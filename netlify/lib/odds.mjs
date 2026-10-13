// The Odds API (v4) access for Arbitrage Daily. Same provider and ODDS_API_KEY as get-odds.js.
import { COVERAGE_GROUPS, env } from "./config.mjs";

const BASE = "https://api.the-odds-api.com/v4";

function apiKey() {
  const key = env("ODDS_API_KEY");
  if (!key) throw new Error("ODDS_API_KEY is not configured");
  return key;
}

async function getJson(url, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const usage = {
      used: Number(res.headers.get("x-requests-used")) || null,
      remaining: Number(res.headers.get("x-requests-remaining")) || null,
      last: Number(res.headers.get("x-requests-last")) || 0,
    };
    const body = await res.text();
    if (!res.ok) {
      const err = new Error(`Odds API ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      err.usage = usage;
      throw err;
    }
    return { data: JSON.parse(body), usage };
  } finally {
    clearTimeout(t);
  }
}

// /sports is free (does not use quota). all=true also returns out-of-season sports.
export async function listSports() {
  const url = new URL(`${BASE}/sports/`);
  url.searchParams.set("apiKey", apiKey());
  url.searchParams.set("all", "true");
  const { data } = await getJson(url);
  return data;
}

// Decide what to scan and record coverage status for every requested group.
export function planCoverage(sports) {
  const byKey = new Map(sports.map((s) => [s.key, s]));
  const extra = (env("ARB_EXTRA_SPORTS", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const groups = [...COVERAGE_GROUPS];
  if (extra.length) groups.push({ id: "extra", label: "Additional (ARB_EXTRA_SPORTS)", keys: extra, markets: "h2h" });

  const coverage = [];
  const scan = [];
  for (const g of groups) {
    const keys = g.prefix
      ? sports.filter((s) => s.key.startsWith(g.prefix) && !s.has_outrights).map((s) => s.key)
      : g.keys;
    if (!keys.length) {
      coverage.push({ group: g.label, key: g.prefix ? `${g.prefix}*` : "", status: "unsupported", detail: "No matching sport keys are listed by the odds feed." });
      continue;
    }
    for (const key of keys) {
      const s = byKey.get(key);
      if (!s) coverage.push({ group: g.label, key, status: "unsupported", detail: "Not listed by the odds feed." });
      else if (s.has_outrights) coverage.push({ group: g.label, key, status: "unsupported", detail: "Feed offers outrights only for this key." });
      else if (!s.active) coverage.push({ group: g.label, key, title: s.title, status: "inactive", detail: "Out of season / no events listed today." });
      else {
        coverage.push({ group: g.label, key, title: s.title, status: "scanned", markets: g.markets });
        scan.push({ key, title: s.title, group: g.label, markets: g.markets });
      }
    }
  }
  return { coverage, scan };
}

export function regions() {
  return env("ARB_REGIONS", "us,us2");
}

export function estimateCredits(scan) {
  const r = regions().split(",").length;
  return scan.reduce((sum, s) => sum + s.markets.split(",").length * r, 0);
}

export async function fetchSportOdds(sportKey, markets) {
  const url = new URL(`${BASE}/sports/${encodeURIComponent(sportKey)}/odds/`);
  url.searchParams.set("apiKey", apiKey());
  url.searchParams.set("regions", regions());
  url.searchParams.set("markets", markets);
  url.searchParams.set("oddsFormat", "decimal");
  url.searchParams.set("dateFormat", "iso");
  url.searchParams.set("includeBetLimits", "true");
  return getJson(url);
}

// Fetch every scanned sport with bounded concurrency; failures are recorded, never invented.
export async function fetchAll(scan, { concurrency = 6 } = {}) {
  const results = [];
  let i = 0;
  let lastUsage = null;
  async function worker() {
    while (i < scan.length) {
      const item = scan[i++];
      try {
        const { data, usage } = await fetchSportOdds(item.key, item.markets);
        lastUsage = usage;
        results.push({ ...item, ok: true, events: data, credits: usage.last });
      } catch (e) {
        if (e.usage) lastUsage = e.usage;
        results.push({ ...item, ok: false, error: String(e.message || e).slice(0, 240), events: [] });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, scan.length) }, worker));
  return { results, usage: lastUsage };
}

// ---- Game Watch ----

// Free endpoint: upcoming and live events for a sport (no odds).
export async function listEvents(sportKey) {
  const url = new URL(`${BASE}/sports/${encodeURIComponent(sportKey)}/events`);
  url.searchParams.set("apiKey", apiKey());
  url.searchParams.set("dateFormat", "iso");
  const { data } = await getJson(url);
  return data;
}

// One call for several events of the same sport. Cost = markets x regions (not per event).
// Completed events are not returned by the feed.
export async function fetchEventsOdds(sportKey, eventIds, { markets = "h2h", regionList } = {}) {
  const url = new URL(`${BASE}/sports/${encodeURIComponent(sportKey)}/odds/`);
  url.searchParams.set("apiKey", apiKey());
  url.searchParams.set("regions", regionList || env("GAMEWATCH_REGIONS", "us,us2,us_ex"));
  url.searchParams.set("markets", markets);
  url.searchParams.set("oddsFormat", "decimal");
  url.searchParams.set("dateFormat", "iso");
  url.searchParams.set("eventIds", eventIds.join(","));
  return getJson(url);
}
