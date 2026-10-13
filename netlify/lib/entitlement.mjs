// Pro access, decided server-side from Stripe subscription data.
// Source of truth: Stripe webhooks keep a per-email record in Blobs. If no fresh record exists
// (e.g. subscribers who joined before the webhook was configured), Stripe is queried directly.
import crypto from "node:crypto";
import { env } from "./config.mjs";
import { sha256 } from "./auth.mjs";
import { getJSON, setJSON } from "./store.mjs";
import { getTester } from "./testers.mjs";

const RECHECK_MS = 6 * 3600000;

export function proPriceIds() {
  return (env("STRIPE_PRO_PRICE_IDS", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function allowedStatuses() {
  return env("PRO_ALLOW_TRIALING", "true") === "false" ? ["active"] : ["active", "trialing"];
}

function ownerOverride(email) {
  const list = (env("PRO_ACCESS_EMAILS", "") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(email);
}

export function hasProFromRecord(rec, now = Date.now()) {
  if (!rec?.subscriptions) return false;
  const pro = new Set(proPriceIds());
  if (!pro.size) return false;
  return Object.values(rec.subscriptions).some(
    (s) => allowedStatuses().includes(s.status) && s.priceIds.some((p) => pro.has(p)) &&
      (!s.currentPeriodEnd || s.currentPeriodEnd * 1000 > now - 3 * 86400000),
  );
}

export function subscriptionSummary(sub) {
  return {
    status: sub.status,
    priceIds: (sub.items?.data || []).map((i) => i.price?.id).filter(Boolean),
    currentPeriodEnd: sub.current_period_end || sub.items?.data?.[0]?.current_period_end || null,
    customer: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
    updated: Date.now(),
  };
}

async function stripeGet(path, params = {}) {
  const key = env("STRIPE_SECRET_KEY");
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
  const url = new URL(`https://api.stripe.com/v1/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Stripe ${path} ${res.status}`);
  return res.json();
}

export async function refreshFromStripe(email) {
  const customers = await stripeGet("customers", { email, limit: "10" });
  const rec = { email, subscriptions: {}, checkedAt: Date.now(), source: "stripe-lookup" };
  for (const c of customers.data || []) {
    const subs = await stripeGet("subscriptions", { customer: c.id, status: "all", limit: "20" });
    for (const s of subs.data || []) rec.subscriptions[s.id] = subscriptionSummary(s);
  }
  await setJSON("entitlements", sha256(email), rec);
  return rec;
}

export async function getProAccess(email) {
  if (ownerOverride(email)) return { pro: true, source: "owner-override" };
  const tester = await getTester(email);
  if (tester) return { pro: true, source: "tester", expires: tester.expires };
  let rec = await getJSON("entitlements", sha256(email));
  if (!rec || !rec.checkedAt || Date.now() - rec.checkedAt > RECHECK_MS) {
    try {
      rec = await refreshFromStripe(email);
    } catch (e) {
      console.error("[entitlement] Stripe lookup failed", e.message);
      if (!rec) return { pro: false, source: "unavailable" };
    }
  }
  return { pro: hasProFromRecord(rec), source: rec.source || "webhook" };
}

export async function recordSubscription(email, sub) {
  const key = sha256(email);
  const rec = (await getJSON("entitlements", key)) || { email, subscriptions: {} };
  rec.subscriptions[sub.id] = subscriptionSummary(sub);
  rec.checkedAt = Date.now();
  rec.source = "webhook";
  await setJSON("entitlements", key, rec);
  return rec;
}

export async function customerEmail(customerId) {
  const c = await stripeGet(`customers/${encodeURIComponent(customerId)}`);
  return c.deleted ? null : c.email;
}

// Stripe-Signature: t=timestamp,v1=hex(hmac_sha256(secret, `${t}.${rawBody}`)); 5-minute tolerance.
export function verifyStripeSignature(rawBody, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!header || !secret) return false;
  const v1 = [];
  let t = null;
  for (const kv of header.split(",")) {
    const [k, v] = kv.split("=");
    if (k === "t") t = Number(v);
    if (k === "v1") v1.push(v);
  }
  if (!t || !v1.length || Math.abs(nowSec - t) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return v1.some((sig) => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
}
