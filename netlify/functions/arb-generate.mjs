// POST /api/arb/generate — operator-only "run now" (header x-admin-secret: $ADMIN_SECRET).
// Used to verify a Deploy Preview, which writes to the separate preview store.
import crypto from "node:crypto";
import { env } from "../lib/config.mjs";
import { generateAndStore, publicReport } from "../lib/generate.mjs";
import { init, json } from "../lib/http.mjs";

export default async (req, context) => {
  init(context);
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const secret = env("ADMIN_SECRET");
  const given = req.headers.get("x-admin-secret") || "";
  const ok = secret && secret.length >= 24 && given.length === secret.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) return json({ error: "forbidden" }, 403);
  try {
    const r = await generateAndStore({ trigger: "manual" });
    const p = publicReport(r);
    return json({ ok: true, generatedAt: p.generatedAt, stats: p.stats, creditsUsed: p.creditsUsed, fetchErrors: p.fetchErrors, coverage: p.coverage });
  } catch (e) {
    return json({ error: "generation_failed", detail: e.message }, 500);
  }
};

export const config = { path: "/api/arb/generate" };
