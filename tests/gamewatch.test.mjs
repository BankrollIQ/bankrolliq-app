// Game Watch: bets API, polling cycle, alerts, credit cap and endings. Synthetic fixtures; network mocked.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { __setStoreFactory } from "../netlify/lib/store.mjs";
import { signSession } from "../netlify/lib/auth.mjs";
import { runCycle, bestPrices } from "../netlify/lib/gamewatch.mjs";

process.env.SESSION_SECRET = "x".repeat(40);
process.env.ADMIN_SECRET = "a".repeat(40);
process.env.ODDS_API_KEY = "test";
process.env.STRIPE_SECRET_KEY = "sk_test";
process.env.STRIPE_PRO_PRICE_IDS = "price_pro";
process.env.PRO_ACCESS_EMAILS = "pro@example.com";
process.env.RESEND_API_KEY = "re_test";
process.env.EMAIL_FROM = "BankrollIQ <login@bankrolliq.app>";
delete process.env.BOOK_TERMS_JSON;

const mem = new Map();
__setStoreFactory((n) => ({
  get: async (k) => (mem.has(`${n}/${k}`) ? structuredClone(mem.get(`${n}/${k}`)) : null),
  setJSON: async (k, v) => mem.set(`${n}/${k}`, structuredClone(v)),
  delete: async (k) => mem.delete(`${n}/${k}`),
}));

const T0 = Date.now();
const iso = (min) => new Date(T0 + min * 60000).toISOString();
const GAME = { id: "g1", sport_key: "americanfootball_nfl", sport_title: "NFL", commence_time: iso(-30), home_team: "San Francisco 49ers", away_team: "Underdogs" };
let oddsCalls = 0, emails = [], livePrice = 1.6, liveGames = [GAME];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const ok = (b) => new Response(JSON.stringify(b), { status: 200 });
  if (u.hostname === "api.resend.com") { emails.push(JSON.parse(init.body)); return ok({ id: "e" }); }
  if (u.hostname === "api.stripe.com") return ok({ data: [] });
  if (u.pathname === "/v4/sports/") return ok([{ key: "americanfootball_nfl", title: "NFL", active: true, has_outrights: false }, { key: "soccer_epl", title: "EPL", active: true, has_outrights: false }]);
  if (u.pathname.endsWith("/events")) return ok([GAME]);
  if (u.pathname.endsWith("/odds/")) {
    oddsCalls++;
    return ok(liveGames.filter((g) => u.searchParams.get("eventIds").split(",").includes(g.id)).map((g) => ({ ...g, bookmakers: [
      { key: "fanduel", title: "FanDuel", link: "https://sportsbook.fanduel.com/event/1", markets: [{ key: "h2h", last_update: new Date().toISOString(), outcomes: [{ name: "San Francisco 49ers", price: livePrice, link: "https://sportsbook.fanduel.com/addToBetslip?id=9" }, { name: "Underdogs", price: 2.3 }] }] },
      { key: "betmgm", title: "BetMGM", link: "https://sports.{state}.betmgm.com/event/1", markets: [{ key: "h2h", last_update: new Date().toISOString(), outcomes: [{ name: "San Francisco 49ers", price: livePrice - 0.05 }, { name: "Underdogs", price: 2.2 }] }] },
      { key: "draftkings", title: "DraftKings", markets: [{ key: "h2h", last_update: iso(-30), outcomes: [{ name: "San Francisco 49ers", price: 5.0 }, { name: "Underdogs", price: 1.2 }] }] }, // stale: ignored
    ] })));
  }
  throw new Error("unexpected " + url);
};

const ctx = { deploy: { context: "production" }, ip: "1.1.1.1" };
const O = "https://bankrolliq.app";
const H = { cookie: `biq_session=${signSession("pro@example.com")}`, origin: O, "content-type": "application/json" };
const bets = (await import("../netlify/functions/bets.mjs")).default;
const games = (await import("../netlify/functions/gamewatch-games.mjs")).default;
const run = (await import("../netlify/functions/gamewatch-run.mjs")).default;

beforeEach(() => { mem.clear(); oddsCalls = 0; emails = []; livePrice = 1.6; liveGames = [GAME]; delete process.env.GAMEWATCH_MAX_CREDITS_PER_DAY; });

const saveBet = (extra = {}) => bets(new Request(O + "/api/bets", { method: "POST", headers: H, body: JSON.stringify({ sportKey: "americanfootball_nfl", eventId: "g1", side: "Underdogs", stake: 100, odds: "+300", oddsFormat: "american", targetProfit: 100, watch: true, ...extra }) }), ctx);

test("signed-out users cannot use My bets or the game list", async () => {
  assert.equal((await bets(new Request(O + "/api/bets"), ctx)).status, 401);
  assert.equal((await games(new Request(O + "/api/gamewatch/games"), ctx)).status, 401);
});

test("game list excludes 3-way soccer and lists games", async () => {
  const s = await (await games(new Request(O + "/api/gamewatch/games", { headers: H }), ctx)).json();
  assert.deepEqual(s.sports.map((x) => x.key), ["americanfootball_nfl"]);
  const g = await (await games(new Request(O + "/api/gamewatch/games?sport=americanfootball_nfl", { headers: H }), ctx)).json();
  assert.equal(g.games[0].home, "San Francisco 49ers");
});

test("save validates input", async () => {
  const bad = await saveBet({ odds: "+50" });
  assert.equal(bad.status, 400);
  const bad2 = await saveBet({ eventId: "nope" });
  assert.equal(bad2.status, 400);
  const tooBig = await saveBet({ targetProfit: 300 }); // $100 at +300 can lock at most $300 → refused
  assert.equal(tooBig.status, 400);
});

test("no alert until the 49ers reach even money; then one email, watch stops", async () => {
  assert.equal((await saveBet()).status, 200);
  let s = await runCycle({ origin: O });
  assert.equal(s.alerts, 0);
  assert.equal(oddsCalls, 1);
  const view = (await (await bets(new Request(O + "/api/bets", { headers: H }), ctx)).json()).bets[0];
  assert.equal(view.lock.neededAmerican, 100);           // needs 49ers at +100 for $100 locked
  assert.equal(view.lock.current.bookTitle, "FanDuel");  // stale DraftKings price ignored
  assert.equal(view.lock.targetMet, false);

  livePrice = 2.0;
  s = await runCycle({ origin: O });
  assert.equal(s.alerts, 1);
  assert.equal(emails.length, 1);
  assert.match(emails[0].subject, /^Lock \$100\.00: bet San Francisco 49ers \+100 at FanDuel/);
  assert.match(emails[0].text, /Bet \$200\.00 on San Francisco 49ers/);
  assert.match(emails[0].text, /tie/i); // NFL tie note
  assert.match(emails[0].html, /href="https:\/\/sportsbook\.fanduel\.com\/addToBetslip\?id=9"/); // bet-slip deep link
  assert.match(emails[0].html, /Open bet slip at FanDuel/);
  const after = (await (await bets(new Request(O + "/api/bets", { headers: H }), ctx)).json()).bets[0];
  assert.equal(after.status, "alerted");
  assert.equal(after.alerts[0].lockedProfit, 100);

  s = await runCycle({ origin: O });
  assert.equal(s.watches, 0); // no repeat alerts
  assert.equal(emails.length, 1);
});

test("several watches on the same sport share one feed call", async () => {
  await saveBet();
  await saveBet({ targetProfit: 50 });
  await runCycle({ origin: O });
  assert.equal(oddsCalls, 1);
});

test("daily credit cap stops polling", async () => {
  process.env.GAMEWATCH_MAX_CREDITS_PER_DAY = "2"; // one poll costs 3 (three regions)
  await saveBet();
  const s = await runCycle({ origin: O });
  assert.equal(oddsCalls, 0);
  assert.match(s.skipped[0], /credit cap/);
});

test("a finished game (dropped from the feed) ends the watch", async () => {
  await saveBet();
  liveGames = [];
  const s = await runCycle({ origin: O });
  assert.equal(s.ended, 1);
  const b = (await (await bets(new Request(O + "/api/bets", { headers: H }), ctx)).json()).bets[0];
  assert.equal(b.status, "ended");
});

test("watch can be turned off and back on; delete removes it", async () => {
  await saveBet();
  const id = (await (await bets(new Request(O + "/api/bets", { headers: H }), ctx)).json()).bets[0].id;
  await bets(new Request(O + "/api/bets", { method: "PATCH", headers: H, body: JSON.stringify({ id, watch: false }) }), ctx);
  assert.equal((await runCycle({ origin: O })).watches, 0);
  await bets(new Request(O + "/api/bets", { method: "PATCH", headers: H, body: JSON.stringify({ id, watch: true }) }), ctx);
  assert.equal((await runCycle({ origin: O })).watches, 1);
  await bets(new Request(O + "/api/bets?id=" + id, { method: "DELETE", headers: H }), ctx);
  assert.equal((await runCycle({ origin: O })).watches, 0);
});

test("run-now endpoint requires the admin secret", async () => {
  assert.equal((await run(new Request(O + "/api/gamewatch/run", { method: "POST" }), ctx)).status, 403);
  const ok = await run(new Request(O + "/api/gamewatch/run", { method: "POST", headers: { "x-admin-secret": "a".repeat(40) } }), ctx);
  assert.equal(ok.status, 200);
});

test("bestPrices ignores 3-way markets", () => {
  const p = bestPrices({ bookmakers: [{ key: "x", title: "X", markets: [{ key: "h2h", last_update: new Date().toISOString(), outcomes: [{ name: "A", price: 3 }, { name: "B", price: 3 }, { name: "Draw", price: 3 }] }] }] });
  assert.deepEqual(p, {});
});

const profile = (await import("../netlify/functions/profile.mjs")).default;

test("My sportsbooks: alerts only on the member's books, and mention the better price elsewhere", async () => {
  const put = await profile(new Request(O + "/api/profile", { method: "PUT", headers: H, body: JSON.stringify({ books: ["betmgm", "not_a_book"] }) }), ctx);
  assert.deepEqual((await put.json()).books, ["betmgm"]);
  await saveBet({ targetProfit: 90 });
  livePrice = 2.0; // FanDuel 2.00, BetMGM 1.95
  const s = await runCycle({ origin: O });
  assert.equal(s.alerts, 1);
  const e = emails.at(-1);
  assert.match(e.subject, /at BetMGM/);
  assert.match(e.text, /Better price outside your sportsbooks: San Francisco 49ers \+100 at FanDuel/);
  // BetMGM's link has an unfilled {state} placeholder → falls back to its home page
  assert.match(e.html, /href="https:\/\/www\.betmgm\.com\/?"/);
  assert.doesNotMatch(e.html, /\{state\}/);
});

test("no alert when the target is only available at books the member doesn't use", async () => {
  await profile(new Request(O + "/api/profile", { method: "PUT", headers: H, body: JSON.stringify({ books: ["betmgm"] }) }), ctx);
  await saveBet({ targetProfit: 100 }); // needs 2.00; BetMGM only 1.95
  livePrice = 2.0;
  const s = await runCycle({ origin: O });
  assert.equal(s.alerts, 0);
  const v = (await (await bets(new Request(O + "/api/bets", { headers: H }), ctx)).json()).bets[0];
  assert.equal(v.lock.current.bookTitle, "BetMGM");
  assert.equal(v.betterElsewhere.bookTitle, "FanDuel");
});
