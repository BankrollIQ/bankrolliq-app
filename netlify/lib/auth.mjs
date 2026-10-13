// Passwordless (magic-link) sign-in with a signed, HttpOnly session cookie.
import crypto from "node:crypto";
import { env } from "./config.mjs";
import { del, getJSON, setJSON } from "./store.mjs";

const COOKIE = "biq_session";
const SESSION_DAYS = 30;
const LINK_MINUTES = 15;

export function normalizeEmail(e) {
  const s = String(e || "").trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(s) && s.length <= 254 ? s : null;
}

export function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function secret() {
  const s = (env("SESSION_SECRET") || "").trim();
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set (32+ random characters)");
  return s;
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");

export function signSession(email, now = Date.now()) {
  const payload = b64u(JSON.stringify({ e: email, iat: now, exp: now + SESSION_DAYS * 86400000 }));
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySession(token, now = Date.now()) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  const a = Buffer.from(sig || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!data.e || !data.exp || data.exp < now) return null;
    return { email: data.e, exp: data.exp };
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionFromRequest(req) {
  return verifySession(parseCookies(req.headers.get("cookie"))[COOKIE]);
}

function isLocal(req) {
  const h = new URL(req.url).hostname;
  return h === "localhost" || h === "127.0.0.1";
}

export function sessionCookie(req, value, maxAgeSeconds = SESSION_DAYS * 86400) {
  const secure = isLocal(req) ? "" : "; Secure";
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function clearCookie(req) {
  return sessionCookie(req, "", 0);
}

// ---- one-time login links ----

export async function createLoginToken(email) {
  const token = crypto.randomBytes(32).toString("base64url");
  await setJSON("auth", `login/${sha256(token)}`, { email, exp: Date.now() + LINK_MINUTES * 60000 });
  return token;
}

export async function consumeLoginToken(token) {
  if (!token || token.length < 20 || token.length > 100) return null;
  const key = `login/${sha256(token)}`;
  const rec = await getJSON("auth", key);
  if (!rec) return null;
  await del("auth", key); // single use, even if expired
  return rec.exp >= Date.now() ? rec.email : null;
}

// Simple fixed-window rate limit backed by Blobs.
export async function rateLimit(bucket, limit, windowSeconds) {
  const key = `rl/${sha256(bucket)}`;
  const now = Date.now();
  const rec = (await getJSON("auth", key)) || { start: now, count: 0 };
  if (now - rec.start > windowSeconds * 1000) {
    rec.start = now;
    rec.count = 0;
  }
  rec.count++;
  await setJSON("auth", key, rec);
  return rec.count <= limit;
}

export async function sendLoginEmail(to, link) {
  const apiKey = env("RESEND_API_KEY");
  const from = env("EMAIL_FROM");
  if (!apiKey || !from) throw new Error("RESEND_API_KEY and EMAIL_FROM must be configured");
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px">
<h2 style="margin:0 0 12px">Sign in to BankrollIQ Arbitrage Daily™</h2>
<p>Use this one-time link within ${LINK_MINUTES} minutes:</p>
<p><a href="${link}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#5eead4;color:#061019;font-weight:800;text-decoration:none">Sign in</a></p>
<p style="color:#667">If you didn't request this, you can ignore this email.</p>
<p style="color:#667;font-size:12px">Educational analytics only. No guaranteed outcomes. 18+ where applicable.</p></div>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject: "Your BankrollIQ sign-in link", html, text: `Sign in to BankrollIQ Arbitrage Daily: ${link}\nThis link expires in ${LINK_MINUTES} minutes.` }),
  });
  if (!res.ok) throw new Error(`Email send failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
}
