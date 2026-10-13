// /api/admin/testers — operator only (x-admin-secret).
//   GET → list testers   POST {email, days, note} → add/extend   DELETE ?email= → remove
import { addTester, listTesters, removeTester } from "../lib/testers.mjs";
import { adminLocked, isAdmin } from "../lib/admin.mjs";
import { init, json } from "../lib/http.mjs";

export default async (req, context) => {
  init(context);
  if (await adminLocked(req, context)) return json({ error: "too_many_requests" }, 429);
  if (!(await isAdmin(req))) return json({ error: "forbidden" }, 403);
  try {
    if (req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      await addTester(b.email, b.days ?? 30, b.note);
    } else if (req.method === "DELETE") {
      await removeTester(new URL(req.url).searchParams.get("email"));
    } else if (req.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }
  } catch (e) {
    return json({ error: e.message }, 400);
  }
  const all = await listTesters();
  const now = Date.now();
  const testers = Object.entries(all)
    .map(([email, t]) => ({ email, ...t, active: t.expires > now }))
    .sort((a, b) => b.added - a.added);
  return json({ testers });
};

export const config = { path: "/api/admin/testers" };
