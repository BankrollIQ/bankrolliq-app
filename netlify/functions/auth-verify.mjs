// GET /api/auth/verify?token=… — consumes the one-time link and sets the session cookie.
import { consumeLoginToken, sessionCookie, signSession } from "../lib/auth.mjs";
import { init } from "../lib/http.mjs";

export default async (req, context) => {
  init(context);
  const token = new URL(req.url).searchParams.get("token");
  const email = await consumeLoginToken(token);
  if (!email) {
    return new Response(null, { status: 302, headers: { Location: "/arbitrage.html?signin=expired", "Cache-Control": "no-store" } });
  }
  return new Response(null, {
    status: 302,
    headers: { Location: "/arbitrage.html", "Set-Cookie": sessionCookie(req, signSession(email)), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
};

export const config = { path: "/api/auth/verify" };
