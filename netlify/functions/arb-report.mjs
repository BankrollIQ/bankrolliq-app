// GET /api/arb/report[?day=YYYY-MM-DD] — Pro only. Report data never ships in the static page.
import { publicReport } from "../lib/generate.mjs";
import { getJSON } from "../lib/store.mjs";
import { init, json, requirePro } from "../lib/http.mjs";

export default async (req, context) => {
  init(context);
  const gate = await requirePro(req);
  if (gate instanceof Response) return gate;
  const day = new URL(req.url).searchParams.get("day");
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: "bad_day" }, 400);
  const report = await getJSON("reports", day ? `daily/${day}` : "latest");
  const index = (await getJSON("reports", "index")) || [];
  if (!report) return json({ report: null, history: index, message: "No report has been generated yet. The first report runs at 9:00 a.m. PST." });
  return json({ report: publicReport(report), history: index });
};

export const config = { path: "/api/arb/report" };
