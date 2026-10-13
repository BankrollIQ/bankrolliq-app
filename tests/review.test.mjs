// Tests for the review findings: settlement states, stake caps, allocation separation, watch-list targets.
// All prices are synthetic test fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stakePlan, capitalForTarget, evaluateBook, allocateDaily } from "../netlify/lib/arb.mjs";
import { settlementStates } from "../netlify/lib/settlement.mjs";
import { buildReport, hypotheticalTarget, watchView } from "../netlify/lib/report.mjs";

const L = (...d) => d.map((x, i) => ({ outcome: `O${i + 1}`, point: null, netDecimal: x }));
const NOW = new Date("2026-10-13T17:00:00Z");
const upd = new Date(NOW - 60000).toISOString();

// ---------- 1. push / draw / void / refund ----------

test("whole-number spread: push state pays $0 and the guaranteed minimum is $0", () => {
  const legs = [{ outcome: "Home", point: -3, netDecimal: 2.1 }, { outcome: "Away", point: 3, netDecimal: 2.1 }];
  const st = settlementStates("americanfootball_nfl", "spreads", legs);
  const plan = stakePlan(legs, 1000, { states: st });
  const push = plan.states.find((s) => s.kind === "push");
  assert.ok(push);
  assert.equal(push.profit, 0);
  assert.equal(plan.worstCaseProfit, 0);
  assert.equal(plan.pushPossible, true);
  assert.equal(plan.voidAll.profit, 0);
  const t = capitalForTarget(legs, 500, { states: st });
  assert.equal(t.reachable, true);
  assert.equal(t.guaranteed, false);
  assert.equal(t.basis, "decisive-outcomes-only");
  assert.equal(t.plan.worstCaseProfit, 0);
});

test("whole-number total also pushes; half-point lines do not", () => {
  const whole = [{ outcome: "Over", point: 45, netDecimal: 2.1 }, { outcome: "Under", point: 45, netDecimal: 2.1 }];
  const half = [{ outcome: "Over", point: 45.5, netDecimal: 2.1 }, { outcome: "Under", point: 45.5, netDecimal: 2.1 }];
  assert.ok(settlementStates("basketball_nba", "totals", whole).core.some((s) => s.kind === "push"));
  assert.ok(!settlementStates("basketball_nba", "totals", half).core.some((s) => s.kind === "push"));
  assert.ok(stakePlan(half, 1000, { states: settlementStates("basketball_nba", "totals", half) }).worstCaseProfit > 0);
});

test("NFL two-way moneyline tie is modelled as a refund ($0)", () => {
  const legs = [{ outcome: "A", point: null, netDecimal: 2.1 }, { outcome: "B", point: null, netDecimal: 2.1 }];
  const plan = stakePlan(legs, 1000, { states: settlementStates("americanfootball_nfl", "h2h", legs) });
  assert.equal(plan.states.find((s) => s.kind === "push").profit, 0);
  assert.equal(plan.worstCaseProfit, 0);
  const nba = stakePlan(legs, 1000, { states: settlementStates("basketball_nba", "h2h", legs) });
  assert.ok(nba.worstCaseProfit > 0);
});

test("fight draw rule mismatch shows the full loss separately", () => {
  const legs = [{ outcome: "A", point: null, netDecimal: 2.1 }, { outcome: "B", point: null, netDecimal: 2.1 }];
  const plan = stakePlan(legs, 1000, { states: settlementStates("mma_mixed_martial_arts", "h2h", legs) });
  assert.equal(plan.mismatchWorstProfit, -1000);
  assert.ok(plan.mismatchStates.some((s) => s.label.includes("loss at both")));
});

test("tennis retirement: one leg void, other settled as loss", () => {
  const legs = [{ outcome: "P1", point: null, netDecimal: 2.2 }, { outcome: "P2", point: null, netDecimal: 2.0 }];
  const plan = stakePlan(legs, 1000, { states: settlementStates("tennis_atp_paris", "h2h", legs) });
  assert.equal(plan.mismatchStates.length, 2);
  for (const m of plan.mismatchStates) assert.ok(m.profit < 0);
  assert.equal(plan.mismatchWorstProfit, -Math.max(...plan.stakes));
});

test("report: whole-number line is never verified, never in an allocation, and shows $0 push", () => {
  const sp = (h, a) => ({ key: "spreads", last_update: upd, outcomes: [{ name: "Home", price: h, point: -3 }, { name: "Away", price: a, point: 3 }] });
  const r = buildReport([{ key: "americanfootball_nfl", ok: true, events: [{
    id: "p1", sport_key: "americanfootball_nfl", commence_time: "2026-10-14T00:00:00Z", home_team: "Home", away_team: "Away",
    bookmakers: [{ key: "a", title: "A", markets: [sp(2.15, 1.8)] }, { key: "b", title: "B", markets: [sp(1.8, 2.1)] }],
  }] }], NOW, {});
  const c = r.candidates[0];
  assert.equal(c.flags.pushPossible, true);
  assert.equal(c.eligible, false);
  assert.equal(c.status, "candidate");
  for (const s of c.scenarios) {
    assert.equal(s.worstCaseProfit, 0);
    assert.equal(s.states.find((x) => x.kind === "push").profit, 0);
  }
  assert.equal(c.target500.guaranteed, false);
  assert.equal(r.allocations.theoretical.positions.length, 0);
});

// ---------- 2. stakes never exceed bankroll or limits ----------

test("rounded stakes never exceed the bankroll (2-way and 3-way, many prices)", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let n = 0; n < 2000; n++) {
    const k = n % 2 ? 3 : 2;
    const legs = L(...Array.from({ length: k }, () => 1.2 + rnd() * (k === 3 ? 6 : 2.5)));
    const bank = [500, 1000, 2000, 5000, 777, 1999][n % 6];
    const p = stakePlan(legs, bank);
    assert.ok(p.totalStaked <= bank, `total ${p.totalStaked} > ${bank}`);
    assert.ok(p.stakes.every((s) => Number.isInteger(s) && s >= 0));
  }
});

test("rounded stakes never exceed per-leg wager limits, including 3-way", () => {
  const two = stakePlan(L(2.1, 2.1), 5000, { limits: [100, null] });
  assert.ok(two.stakes[0] <= 100);
  assert.ok(two.totalStaked <= 5000);
  assert.equal(two.limitBound, true);
  assert.ok(two.worstCaseProfit > 0); // shrunk to stay hedged, not left lopsided

  const three = stakePlan(L(3.4, 3.6, 3.5), 5000, { limits: [250, 900, 120] });
  three.stakes.forEach((s, i) => assert.ok(s <= [250, 900, 120][i], `leg ${i} ${s}`));
  assert.ok(three.totalStaked <= 5000);
  assert.ok(three.worstCaseProfit > 0);
});

test("$500 target respects wager limits and reports when it is unreachable", () => {
  const t = capitalForTarget(L(2.05, 2.03), 500, { limits: [200, 200] });
  assert.equal(t.reachable, false);
  assert.equal(t.reason, "wager-limits");
  assert.ok(t.plan.stakes.every((s) => s <= 200));
  assert.ok(t.maxProfitWithinLimits < 500);
});

// ---------- 3. verified vs theoretical allocations ----------

const mkResults = (books) => [{ key: "basketball_nba", ok: true, events: [{
  id: "v1", sport_key: "basketball_nba", commence_time: "2026-10-14T00:00:00Z", home_team: "H", away_team: "A",
  bookmakers: books.map(([key, h, a]) => ({ key, title: key, markets: [{ key: "h2h", last_update: upd, outcomes: [{ name: "H", price: h }, { name: "A", price: a }] }] })),
}] }];

test("unverified candidates only appear in the theoretical plan, with an assumed (not verified) cap", () => {
  delete process.env.BOOK_TERMS_JSON;
  const r = buildReport(mkResults([["booka", 2.06, 1.8], ["bookb", 1.8, 2.04]]), NOW, {});
  assert.equal(r.allocations.verified.positions.length, 0);
  const pos = r.allocations.theoretical.positions[0];
  assert.match(pos.capSource, /assumed .* not verified/);
  assert.ok(!/verified wager/.test(pos.capSource));
  assert.ok(pos.totalStaked <= 1000);
});

test("operator-verified fees, terms and limits produce a verified plan within those limits", () => {
  process.env.BOOK_TERMS_JSON = JSON.stringify({
    booka: { commission: 0, feeVerified: true, termsVerified: true, maxStake: 400, limitVerified: true },
    bookb: { commission: 0, feeVerified: true, termsVerified: true, maxStake: 300, limitVerified: true },
  });
  const r = buildReport(mkResults([["booka", 2.06, 1.8], ["bookb", 1.8, 2.04]]), NOW, {});
  delete process.env.BOOK_TERMS_JSON;
  const c = r.candidates[0];
  assert.equal(c.status, "verified");
  const v = r.allocations.verified.positions[0];
  assert.equal(v.capSource, "operator-verified wager limits");
  const byBook = Object.fromEntries(v.legs.map((l) => [l.book, l.stake]));
  assert.ok(byBook.booka <= 400 && byBook.bookb <= 300);
  for (const s of c.scenarios) {
    assert.ok(s.stakes[0] <= 300 && s.stakes[1] <= 400); // legs ordered A (bookb), H (booka)
    assert.ok(s.totalStaked <= s.bankroll);
  }
});

test("a maxStake that is not marked limitVerified is not treated as verified", () => {
  process.env.BOOK_TERMS_JSON = JSON.stringify({
    booka: { commission: 0, feeVerified: true, termsVerified: true, maxStake: 400 },
    bookb: { commission: 0, feeVerified: true, termsVerified: true, maxStake: 300 },
  });
  const r = buildReport(mkResults([["booka", 2.06, 1.8], ["bookb", 1.8, 2.04]]), NOW, {});
  delete process.env.BOOK_TERMS_JSON;
  assert.equal(r.candidates[0].status, "candidate");
  assert.equal(r.allocations.verified.positions.length, 0);
  assert.equal(r.allocations.theoretical.positions[0].capSource, "known but unverified wager limits");
});

test("allocation skips $0-worst-case positions entirely", () => {
  const legs = [{ outcome: "H", point: -3, netDecimal: 2.2 }, { outcome: "A", point: 3, netDecimal: 2.2 }];
  const res = allocateDaily([{ id: "x", eventId: "e", marketKey: "spreads", legs, roi: evaluateBook(legs).roi, states: settlementStates("americanfootball_nfl", "spreads", legs) }],
    { target: 500, capOf: () => ({ cap: 1000, source: "test" }) });
  assert.equal(res.positions.length, 0);
});

// ---------- 4. hypothetical watch-list targets ----------

test("each hypothetical target has per-side stakes and capital for $500", () => {
  const entry = {
    sportKey: "basketball_nba", marketKey: "h2h",
    outcomes: [
      { name: "A", point: null, best: { net: 2.0, price: 2.0, book: "x", bookTitle: "X", lastUpdate: upd } },
      { name: "H", point: null, best: { net: 1.9, price: 1.9, book: "y", bookTitle: "Y", lastUpdate: upd } },
    ],
  };
  const v = watchView(entry, NOW);
  for (const o of v.outcomes) {
    for (const t of o.hypotheticalTargets) {
      assert.match(t.label, /^HYPOTHETICAL/);
      assert.equal(t.example.stakes.length, 2);
      assert.ok(t.example.totalStaked <= 1000);
      assert.ok(t.example.stakes.some((s) => s.book === "hypothetical price"));
      assert.ok(t.capitalFor500.capital > 0);
      assert.ok(t.capitalFor500.worstCaseProfit >= 500);
      assert.equal(t.capitalFor500.guaranteed, true);
    }
  }
});

test("hypothetical target on a whole-number line is not called guaranteed", () => {
  const entry = {
    sportKey: "americanfootball_nfl", marketKey: "spreads",
    outcomes: [
      { name: "H", point: -7, best: { net: 2.0, book: "x", lastUpdate: upd } },
      { name: "A", point: 7, best: { net: 1.9, book: "y", lastUpdate: upd } },
    ],
  };
  const t = hypotheticalTarget(entry, 1, [2.0, 1.9], 0.02);
  assert.equal(t.example.pushPossible, true);
  assert.equal(t.capitalFor500.guaranteed, false);
  assert.equal(t.capitalFor500.worstCaseProfit, 0);
});
