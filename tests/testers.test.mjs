// Tester access, admin endpoint and feedback (in-memory store, mocked network).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { __setStoreFactory } from "../netlify/lib/store.mjs";
import { signSession } from "../netlify/lib/auth.mjs";

process.env.SESSION_SECRET = "x".repeat(40);
process.env.ADMIN_SECRET = "a".repeat(40);
process.env.STRIPE_SECRET_KEY = "sk_test";
process.env.STRIPE_PRO_PRICE_IDS = "price_pro";
process.env.RESEND_API_KEY = "re_test";
process.env.EMAIL_FROM = "BankrollIQ <login@bankrolliq.app>";
process.env.FEEDBACK_EMAIL = "owner@example.com";

const mem = new Map();
__setStoreFactory((n) => ({
  get: async (k) => (mem.has(`${n}/${k}`) ? structuredClone(mem.get(`${n}/${k}`)) : null),
  setJSON: async (k, v) => mem.set(`${n}/${k}`, structuredClone(v)),
  delete: async (k) => mem.delete(`${n}/${k}`),
}));
let emails = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const ok = (b) => new Response(JSON.stringify(b), { status: 200 });
  if (u.hostname === "api.stripe.com") return ok({ data: [] }); // nobody pays in these tests
  if (u.hostname === "api.resend.com") { emails.push(JSON.parse(init.body)); return ok({ id: "e" }); }
  throw new Error("unexpected " + url);
};

const ctx = { deploy: { context: "production" }, ip: "9.9.9.9" };
const ORIGIN = "https://bankrolliq.app";
const req = (p, o = {}) => new Request(ORIGIN + p, o);
const admin = { "x-admin-secret": "a".repeat(40), "content-type": "application/json" };
const cookie = (e) => ({ cookie: `biq_session=${signSession(e)}`, origin: ORIGIN, "content-type": "application/json" });

const testers = (await import("../netlify/functions/admin-testers.mjs")).default;
const feedback = (await import("../netlify/functions/feedback.mjs")).default;
const report = (await import("../netlify/functions/arb-report.mjs")).default;
const me = (await import("../netlify/functions/me.mjs")).default;
const requestLink = (await import("../netlify/functions/auth-request-link.mjs")).default;

beforeEach(() => { mem.clear(); emails = []; });

test("admin endpoint rejects a wrong or missing secret", async () => {
  assert.equal((await testers(req("/api/admin/testers"), ctx)).status, 403);
  assert.equal((await testers(req("/api/admin/testers", { headers: { "x-admin-secret": "b".repeat(40) } }), ctx)).status, 403);
});

test("a tester gets Pro access without paying, then loses it when removed", async () => {
  const t = "Tester@Example.com";
  assert.equal((await report(req("/api/arb/report", { headers: cookie("tester@example.com") }), ctx)).status, 403);
  const add = await testers(req("/api/admin/testers", { method: "POST", headers: admin, body: JSON.stringify({ email: t, days: 14, note: "beta" }) }), ctx);
  assert.equal(add.status, 200);
  const list = (await add.json()).testers;
  assert.equal(list[0].email, "tester@example.com");
  assert.equal(list[0].active, true);

  assert.equal((await report(req("/api/arb/report", { headers: cookie("tester@example.com") }), ctx)).status, 200);
  const m = await (await me(req("/api/me", { headers: cookie("tester@example.com") }), ctx)).json();
  assert.equal(m.pro, true);
  assert.equal(m.access, "tester");
  assert.ok(m.expires > Date.now() + 13 * 86400000);

  await testers(req("/api/admin/testers?email=tester%40example.com", { method: "DELETE", headers: admin }), ctx);
  assert.equal((await report(req("/api/arb/report", { headers: cookie("tester@example.com") }), ctx)).status, 403);
});

test("an expired tester has no access", async () => {
  mem.set("arb-testers/all", { "old@example.com": { expires: Date.now() - 1000, added: 0, note: "" } });
  assert.equal((await report(req("/api/arb/report", { headers: cookie("old@example.com") }), ctx)).status, 403);
});

test("testers can request a sign-in link", async () => {
  await testers(req("/api/admin/testers", { method: "POST", headers: admin, body: JSON.stringify({ email: "t2@example.com", days: 7 }) }), ctx);
  const r = await requestLink(req("/api/auth/request-link", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email: "t2@example.com" }) }), ctx);
  assert.equal(r.status, 200);
  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, ["t2@example.com"]);
});

test("invalid tester input is refused", async () => {
  const bad = await testers(req("/api/admin/testers", { method: "POST", headers: admin, body: JSON.stringify({ email: "nope", days: 10 }) }), ctx);
  assert.equal(bad.status, 400);
  const bad2 = await testers(req("/api/admin/testers", { method: "POST", headers: admin, body: JSON.stringify({ email: "a@b.co", days: 0 }) }), ctx);
  assert.equal(bad2.status, 400);
});

test("feedback: testers can send it, it is emailed and listed for admin only", async () => {
  await testers(req("/api/admin/testers", { method: "POST", headers: admin, body: JSON.stringify({ email: "fb@example.com", days: 7 }) }), ctx);
  assert.equal((await feedback(req("/api/feedback", { method: "POST", headers: { ...cookie("nobody@example.com") }, body: "{}" }), ctx)).status, 403);
  const empty = await feedback(req("/api/feedback", { method: "POST", headers: cookie("fb@example.com"), body: JSON.stringify({}) }), ctx);
  assert.equal(empty.status, 400);
  const ok = await feedback(req("/api/feedback", { method: "POST", headers: cookie("fb@example.com"), body: JSON.stringify({ rating: 4, improve: "Add <b>alerts</b>" }) }), ctx);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).emailed, true);
  assert.deepEqual(emails.at(-1).to, ["owner@example.com"]);
  assert.match(emails.at(-1).html, /&lt;b&gt;alerts/); // escaped
  assert.equal((await feedback(req("/api/feedback"), ctx)).status, 403);
  const list = await (await feedback(req("/api/feedback", { headers: admin }), ctx)).json();
  assert.equal(list.feedback[0].improve, "Add <b>alerts</b>");
});
