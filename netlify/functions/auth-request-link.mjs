// POST /api/auth/request-link { email } — emails a one-time sign-in link to active Pro subscribers.
// The response is identical whether or not the email has Pro, so it cannot be used to probe accounts.
import { createLoginToken, normalizeEmail, rateLimit, sendLoginEmail } from "../lib/auth.mjs";
import { getProAccess } from "../lib/entitlement.mjs";
import { init, json, sameOrigin } from "../lib/http.mjs";

const GENERIC = { ok: true, message: "If this email has an active BankrollIQ Pro subscription, a sign-in link is on its way. Check your spam folder." };

export default async (req, context) => {
  init(context);
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!sameOrigin(req)) return json({ error: "bad_origin" }, 403);
  let body = {};
  try { body = await req.json(); } catch { /* handled below */ }
  const email = normalizeEmail(body.email);
  if (!email) return json({ error: "invalid_email" }, 400);

  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
  if (!(await rateLimit(`ip:${ip}`, 20, 3600)) || !(await rateLimit(`email:${email}`, 3, 900))) {
    return json({ error: "rate_limited", message: "Too many requests. Try again in a few minutes." }, 429);
  }
  try {
    const access = await getProAccess(email);
    if (access.pro) {
      const token = await createLoginToken(email);
      const link = `${new URL(req.url).origin}/api/auth/verify?token=${encodeURIComponent(token)}`;
      await sendLoginEmail(email, link);
    }
  } catch (e) {
    console.error("[auth-request-link]", e.message);
    return json({ error: "unavailable", message: "Sign-in is temporarily unavailable. Please try again shortly." }, 503);
  }
  return json(GENERIC);
};

export const config = { path: "/api/auth/request-link" };
