import crypto from "node:crypto";
import { env } from "./config.mjs";
import { rateLimit } from "./auth.mjs";

// Constant-time admin check. adminLocked() caps admin requests per IP (30 per 15 min).
export async function isAdmin(req) {
  const secret = (env("ADMIN_SECRET") || "").trim();
  const given = (req.headers.get("x-admin-secret") || "").trim();
  if (!secret || secret.length < 24 || !given) return false;
  return crypto.timingSafeEqual(
    crypto.createHash("sha256").update(given).digest(),
    crypto.createHash("sha256").update(secret).digest(),
  );
}

export async function adminLocked(req, context) {
  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
  return !(await rateLimit(`admin:${ip}`, 30, 900));
}
