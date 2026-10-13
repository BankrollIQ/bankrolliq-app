// POST /api/arb/generate — operator-only "run now" (header x-admin-secret: $ADMIN_SECRET).
// Used to verify a Deploy Preview, which writes to the separate preview store.
import crypto from "node:crypto";
import { env } from "../lib/config.mjs";
import { generateAndStore, publicReport } from "../lib/generate.mjs";
import { init, json } from "../lib/http.mjs";

export default async (req, context) => {
  init(context);
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  // Trim stray spaces/newlines that often sneak in when pasting into dashboards or terminals.
  const secret = (env("ADMIN_SECRET") || "").trim();
  const given = (req.headers.get("x-admin-secret") || "").trim();
  if (!secret) return json({ error: "forbidden", reason: "ADMIN_SECRET is not set for this deploy context (rebuild after adding it)." }, 403);
  if (secret.length < 24) return json({ error: "forbidden", reason: "ADMIN_SECRET in Netlify is shorter than 24 characters." }, 403);
  if (!given) return json({ error: "forbidden", reason: "No x-admin-secret header was received." }, 403);
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(secret).digest();
  if (!crypto.timingSafeEqual(a, b)) return json({ error: "forbidden", reason: "The secret sent does not match ADMIN_SECRET for this deploy context." }, 403);
  try {
    const r = await generateAndStore({ trigger: "manual" });
    const p = publicReport(r);
    return json({ ok: true, generatedAt: p.generatedAt, stats: p.stats, creditsUsed: p.creditsUsed, fetchErrors: p.fetchErrors, coverage: p.coverage });
  } catch (e) {
    return json({ error: "generation_failed", detail: e.message }, 500);
  }
};

export const config = { path: "/api/arb/generate" };
