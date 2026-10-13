// POST /api/gamewatch/run — operator only: run one Game Watch cycle now (for testing on Deploy Previews).
import { runCycle } from "../lib/gamewatch.mjs";
import { adminLocked, isAdmin } from "../lib/admin.mjs";
import { init, json } from "../lib/http.mjs";

export default async (req, context) => {
  init(context);
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (await adminLocked(req, context)) return json({ error: "too_many_requests" }, 429);
  if (!(await isAdmin(req))) return json({ error: "forbidden" }, 403);
  try {
    return json({ ok: true, ...(await runCycle({ origin: new URL(req.url).origin })) });
  } catch (e) {
    return json({ error: "failed", detail: e.message }, 500);
  }
};

export const config = { path: "/api/gamewatch/run" };
