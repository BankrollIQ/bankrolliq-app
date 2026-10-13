// Handler tests: auth, Stripe webhook signature, and server-side Pro gating.
// Uses an in-memory store and a mocked fetch — no network, no real Stripe or Odds API data.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { __setStoreFactory } from "../netlify/lib/store.mjs";
import { signSession, sha256 } from "../netlify/lib/auth.mjs";

process.env.SESSION_SECRET = "x".repeat(40);
process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
process.env.STRIPE_PRO_PRICE_IDS = "price_pro";
process.env.RESEND_API_KEY = "re_test";
process.env.EMAIL_FROM = "BankrollIQ <login@bankrolliq.app>";

const mem = new Map();
__setStoreFactory((name) => ({
  get: async (k) => (mem.has(`${name}/${k}`) ? structuredClone(mem.get(`${name}/${k}`)) : null),
  setJSON: async (k, v) => mem.set(`${name}/${k}`, structuredClone(v)),
  delete: async (k) => mem.delete(`${name}/${k}`),
}));

let stripeSubs = {};
let sentEmails = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (u.hostname === "api.stripe.com") {
    if (u.pathname === "/v1/customers") return ok({ data: stripeSubs[u.searchParams.get("email")] ? [{ id: "cus_1" }] : [] });
    if (u.pathname === "/v1/customers/cus_1") return ok({ id: "cus_1", email: "pro@example.com" });
    if (u.pathname === "/v1/subscriptions") return ok({ data: stripeSubs["pro@example.com"] || [] });
  }
  if (u.hostname === "api.resend.com") {
    sentEmails.push(JSON.parse(init.body));
    return ok({ id: "email_1" });
  }
  throw new Error(`unexpected fetch ${url}`);
};

const ctx = { deploy: { context: "deploy-preview" }, ip: "1.2.3.4" };
const sub = (status, price = "price_pro") => ({ id: "sub_1", status, customer: "cus_1", items: { data: [{ price: { id: price } }] }, current_period_end: Math.floor(Date.now() / 1000) + 86400 });
const req = (path, opts = {}) => new Request(`https://preview--bankrolliq.netlify.app${path}`, opts);
const cookieFor = (email) => ({ cookie: `biq_session=${signSession(email)}` });

beforeEach(() => { mem.clear(); stripeSubs = {}; sentEmails = []; });

const report = (await import("../netlify/functions/arb-report.mjs")).default;
const requestLink = (await import("../netlify/functions/auth-request-link.mjs")).default;
const verify = (await import("../netlify/functions/auth-verify.mjs")).default;
const webhook = (await import("../netlify/functions/stripe-webhook.mjs")).default;
const watch = (await import("../netlify/functions/arb-watchlist.mjs")).default;

test("report endpoint: 401 without session, 403 without Pro, 200 with Pro", async () => {
  assert.equal((await report(req("/api/arb/report"), ctx)).status, 401);
  stripeSubs["basic@example.com"] = [];
  assert.equal((await report(req("/api/arb/report", { headers: cookieFor("basic@example.com") }), ctx)).status, 403);
  stripeSubs["pro@example.com"] = [sub("active")];
  const res = await report(req("/api/arb/report", { headers: cookieFor("pro@example.com") }), ctx);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).report, null);
});

test("forged or tampered session cookie is rejected", async () => {
  const good = signSession("pro@example.com");
  const [p] = good.split(".");
  const bad = `${p}.AAAA`;
  stripeSubs["pro@example.com"] = [sub("active")];
  assert.equal((await report(req("/api/arb/report", { headers: { cookie: `biq_session=${bad}` } }), ctx)).status, 401);
});

test("non-Pro price or canceled subscription does not grant access", async () => {
  stripeSubs["pro@example.com"] = [sub("active", "price_premium")];
  assert.equal((await report(req("/api/arb/report", { headers: cookieFor("pro@example.com") }), ctx)).status, 403);
  mem.clear();
  stripeSubs["pro@example.com"] = [sub("canceled")];
  assert.equal((await report(req("/api/arb/report", { headers: cookieFor("pro@example.com") }), ctx)).status, 403);
});

test("magic link: sent only to Pro, same response for everyone, single use", async () => {
  stripeSubs["pro@example.com"] = [sub("trialing")];
  const post = (email) => requestLink(req("/api/auth/request-link", { method: "POST", headers: { "content-type": "application/json", origin: "https://preview--bankrolliq.netlify.app" }, body: JSON.stringify({ email }) }), ctx);
  const a = await (await post("nobody@example.com")).json();
  const b = await (await post("pro@example.com")).json();
  assert.deepEqual(a, b);
  assert.equal(sentEmails.length, 1);
  const link = sentEmails[0].text.match(/https:\S+/)[0];
  const r1 = await verify(new Request(link), ctx);
  assert.equal(r1.status, 302);
  assert.match(r1.headers.get("set-cookie"), /biq_session=.+HttpOnly; SameSite=Lax/);
  const r2 = await verify(new Request(link), ctx);
  assert.match(r2.headers.get("location"), /signin=expired/);
});

test("cross-origin login request is refused", async () => {
  const res = await requestLink(req("/api/auth/request-link", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" }), ctx);
  assert.equal(res.status, 403);
});

test("Stripe webhook: rejects bad signature; cancellation revokes access", async () => {
  stripeSubs["pro@example.com"] = [sub("active")];
  const headers = cookieFor("pro@example.com");
  assert.equal((await report(req("/api/arb/report", { headers }), ctx)).status, 200);

  const body = JSON.stringify({ id: "evt_1", type: "customer.subscription.deleted", data: { object: sub("canceled") } });
  assert.equal((await webhook(req("/api/stripe-webhook", { method: "POST", headers: { "stripe-signature": "t=1,v1=bad" }, body }), ctx)).status, 400);

  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", "whsec_test").update(`${t}.${body}`).digest("hex");
  const ok = await webhook(req("/api/stripe-webhook", { method: "POST", headers: { "stripe-signature": `t=${t},v1=${sig}` }, body }), ctx);
  assert.equal(ok.status, 200);
  assert.equal((await report(req("/api/arb/report", { headers }), ctx)).status, 403);
});

test("watch list only accepts markets from the latest report", async () => {
  stripeSubs["pro@example.com"] = [sub("active")];
  const headers = { ...cookieFor("pro@example.com"), "content-type": "application/json", origin: "https://preview--bankrolliq.netlify.app" };
  mem.set("arb-preview-reports/latest", {
    generatedAt: new Date().toISOString(),
    marketIndex: {
      "e1::h2h:Away|Home": {
        id: "e1::h2h:Away|Home", eventId: "e1", sportKey: "basketball_nba", home: "Home", away: "Away", commence: "2099-01-01T00:00:00Z", lineLabel: "Moneyline", marketKey: "h2h",
        outcomes: [
          { name: "Away", best: { net: 2.0, book: "a", lastUpdate: new Date().toISOString() } },
          { name: "Home", best: { net: 1.9, book: "b", lastUpdate: new Date().toISOString() } },
        ],
      },
    },
  });
  const bad = await watch(req("/api/arb/watchlist", { method: "POST", headers, body: JSON.stringify({ id: "made-up" }) }), ctx);
  assert.equal(bad.status, 400);
  const good = await watch(req("/api/arb/watchlist", { method: "POST", headers, body: JSON.stringify({ id: "e1::h2h:Away|Home" }) }), ctx);
  const data = await good.json();
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].view.outcomes[1].threshold.netDecimal, 2);
  assert.ok(mem.has(`arb-preview-watchlists/user/${sha256("pro@example.com")}`));
});
