// Fetch → analyse → store. Used by the 9 a.m. PST schedule and the admin "run now" endpoint.
import { estimateCredits, fetchAll, listSports, planCoverage, regions } from "./odds.mjs";
import { buildReport } from "./report.mjs";
import { getJSON, setJSON } from "./store.mjs";
import { envNumber } from "./config.mjs";

export async function generateAndStore({ trigger = "scheduled", now = new Date() } = {}) {
  const sports = await listSports();
  const { coverage, scan } = planCoverage(sports);
  const budget = envNumber("ARB_MAX_CREDITS_PER_RUN", 400);
  const estimate = estimateCredits(scan);
  if (estimate > budget) {
    throw new Error(`Estimated ${estimate} credits exceeds ARB_MAX_CREDITS_PER_RUN=${budget}; refusing to run.`);
  }
  const { results, usage } = await fetchAll(scan);
  // If the feed failed for every sport (e.g. monthly credits used up), keep the last good report
  // instead of publishing an empty one that looks like "no opportunities today".
  if (scan.length && results.every((r) => !r.ok)) {
    const reason = results[0]?.error || "unknown error";
    const latest = await getJSON("reports", "latest");
    if (latest) {
      latest.feedProblem = { at: now.toISOString(), message: `Today's refresh failed for every sport: ${reason}` };
      await setJSON("reports", "latest", latest);
    }
    throw new Error(`Odds feed failed for all sports; previous report kept. First error: ${reason}`);
  }
  const report = buildReport(results, now, { trigger, coverage, usage, regions: regions() });
  report.creditsEstimated = estimate;
  const day = report.generatedAt.slice(0, 10);
  await setJSON("reports", `daily/${day}`, report);
  await setJSON("reports", "latest", report);
  const index = (await getJSON("reports", "index")) || [];
  const entry = { day, generatedAt: report.generatedAt, trigger, candidates: report.stats.candidates };
  await setJSON("reports", "index", [entry, ...index.filter((e) => e.day !== day)].slice(0, 60));
  return report;
}

// What subscribers receive: everything except the raw market index used by the watch list.
export function publicReport(report, now = new Date()) {
  if (!report) return null;
  const { marketIndex, ...rest } = report;
  const ageMinutes = Math.round((now - new Date(report.generatedAt)) / 60000);
  const staleAfter = envNumber("ARB_REPORT_STALE_MINUTES", 30);
  return {
    ...rest,
    marketCount: Object.keys(marketIndex || {}).length,
    servedAt: now.toISOString(),
    reportAgeMinutes: ageMinutes,
    pricesStale: ageMinutes > staleAfter,
    staleNotice: ageMinutes > staleAfter
      ? `Prices are ${ageMinutes} minutes old. Odds move quickly — re-check every price at the bookmaker before placing anything.`
      : null,
  };
}
