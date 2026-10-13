// Scheduled every minute on the published site: checks watched games and sends lock-in alerts.
// Netlify does not run schedules on Deploy Previews — use POST /api/gamewatch/run there.
import { runCycle } from "../lib/gamewatch.mjs";
import { init } from "../lib/http.mjs";
import { env } from "../lib/config.mjs";

export default async (req, context) => {
  init(context);
  try {
    const s = await runCycle({ origin: env("URL", "https://bankrolliq.app") });
    if (s.watches) console.log("[gamewatch]", JSON.stringify(s));
  } catch (e) {
    console.error("[gamewatch] failed:", e.message);
  }
};

export const config = { schedule: "* * * * *" };
