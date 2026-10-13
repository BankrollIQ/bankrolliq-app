// POST /api/auth/logout — clears the session cookie.
import { clearCookie } from "../lib/auth.mjs";
import { init, json, sameOrigin } from "../lib/http.mjs";

export default async (req, context) => {
  init(context);
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!sameOrigin(req)) return json({ error: "bad_origin" }, 403);
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie(req) });
};

export const config = { path: "/api/auth/logout" };
