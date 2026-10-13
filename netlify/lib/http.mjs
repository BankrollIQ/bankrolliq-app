import { sessionFromRequest } from "./auth.mjs";
import { getProAccess } from "./entitlement.mjs";
import { setDeployContext } from "./store.mjs";

export function init(context) {
  setDeployContext(context?.deploy?.context || "production");
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

// Same-origin check for state-changing requests (CSRF defence on top of SameSite=Lax).
export function sameOrigin(req) {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser clients; the session cookie is still required
  return origin === new URL(req.url).origin;
}

// Server-side gate: valid session AND current Pro entitlement. Returns { email } or a Response.
export async function requirePro(req) {
  const session = sessionFromRequest(req);
  if (!session) return json({ error: "signin_required" }, 401);
  const access = await getProAccess(session.email);
  if (!access.pro) return json({ error: "pro_required", email: session.email }, 403);
  return { email: session.email, access };
}
