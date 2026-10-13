// Scheduled: generates and stores the Arbitrage Daily report at 17:00 UTC = 9:00 a.m. PST (fixed UTC−8).
// Netlify runs schedules only on the published (production) deploy, never on Deploy Previews.
import { generateAndStore } from "../lib/generate.mjs";
import { init } from "../lib/http.mjs";

export default async (req, context) => {
  init(context);
  try {
    const r = await generateAndStore({ trigger: "scheduled" });
    console.log(`[arb-daily-report] ${r.generatedAt} candidates=${r.stats.candidates} credits=${r.creditsUsed}`);
  } catch (e) {
    console.error("[arb-daily-report] failed:", e.message);
  }
};

export const config = { schedule: "0 17 * * *" };
