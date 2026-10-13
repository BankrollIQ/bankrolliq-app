// Unit tests for the arbitrage math and report builder.
// The events below are synthetic TEST FIXTURES shaped like Odds API v4 responses — never shipped as data.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  americanToDecimal, decimalToAmerican, netDecimal, evaluateBook, roundedStakePlan,
  capitalForTarget, thresholdForOutcome, hypotheticalPriceForRoi, maxBankrollFromLimits, allocateDaily,
} from "../netlify/lib/arb.mjs";
import { buildReport, watchView } from "../netlify/lib/report.mjs";

const legs = (...d) => d.map((x) => ({ netDecimal: x }));

test("odds conversion", () => {
  assert.equal(americanToDecimal(150), 2.5);
  assert.equal(americanToDecimal(-200), 1.5);
  assert.equal(americanToDecimal(50), null);
  assert.equal(decimalToAmerican(2.5), 150);
  assert.equal(decimalToAmerican(1.5), -200);
  assert.equal(decimalToAmerican(2), 100);
});

test("commission applies to net winnings", () => {
  assert.equal(netDecimal(3.0, 0.05), 2.9);
  assert.equal(netDecimal(2.0, 0), 2.0);
});

test("two-way arbitrage ROI and equalised payouts", () => {
  const l = legs(2.1, 2.1);
  const { isArb, roi, impliedSum } = evaluateBook(l);
  assert.ok(isArb);
  assert.ok(Math.abs(impliedSum - 0.952381) < 1e-6);
  assert.ok(Math.abs(roi - 0.05) < 1e-9);
  const plan = roundedStakePlan(l, 1000);
  assert.deepEqual(plan.stakes, [500, 500]);
  assert.equal(plan.worstCaseProfit, 50);
});

test("no arbitrage when implied sum >= 1", () => {
  assert.equal(evaluateBook(legs(1.91, 1.91)).isArb, false);
});

test("rounded stakes report honest worst case", () => {
  const plan = roundedStakePlan(legs(2.05, 2.02), 2000);
  assert.equal(plan.totalStaked, plan.stakes[0] + plan.stakes[1]);
  assert.ok(plan.worstCaseProfit <= plan.bestCaseProfit);
  assert.ok(plan.worstCaseProfit > 0);
});

test("capital for $500 target clears target after rounding", () => {
  const plan = capitalForTarget(legs(2.05, 2.02), 500);
  assert.ok(plan.worstCaseProfit >= 500);
  assert.equal(capitalForTarget(legs(1.9, 1.9), 500), null);
});

test("threshold and hypothetical prices", () => {
  assert.ok(Math.abs(thresholdForOutcome([2.0]) - 2.0) < 1e-9);
  assert.ok(Math.abs(thresholdForOutcome([1.5]) - 3.0) < 1e-9);
  assert.equal(thresholdForOutcome([1.0, 1.0]), null);
  const h = hypotheticalPriceForRoi([2.0], 0.02);
  assert.ok(Math.abs(evaluateBook(legs(2.0, h)).roi - 0.02) < 1e-9);
});

test("capacity from wager limits", () => {
  assert.equal(maxBankrollFromLimits(legs(2.0, 2.0), [100, 300]), 200);
  assert.equal(maxBankrollFromLimits(legs(2.0, 2.0), [100, null]), null);
});

test("daily allocation never reuses an event-market and counts capital once", () => {
  const c = (id, eventId, roi, d) => ({ id, eventId, marketKey: "h2h", roi, legs: legs(...d), eligible: true });
  const res = allocateDaily([
    c("a", "e1", evaluateBook(legs(2.2, 2.2)).roi, [2.2, 2.2]),
    c("b", "e1", evaluateBook(legs(2.1, 2.1)).roi, [2.1, 2.1]),
    c("c", "e2", evaluateBook(legs(2.1, 2.1)).roi, [2.1, 2.1]),
  ], { target: 500, defaultCap: 1000 });
  const ids = res.positions.map((p) => p.candidateId);
  assert.ok(!ids.includes("b"));
  assert.equal(res.capitalRequired, res.positions.reduce((s, p) => s + p.totalStaked, 0));
  assert.equal(res.feasible, false); // ~$100 + $50 from two $1,000 positions
});

// ---------- report builder with fixtures ----------
const NOW = new Date("2026-10-13T17:00:00Z");
const upd = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();
const ev = (id, books, extra = {}) => ({
  id, sport_key: "basketball_nba", sport_title: "NBA", commence_time: "2026-10-14T00:00:00Z",
  home_team: "Home", away_team: "Away", bookmakers: books, ...extra,
});
const bk = (key, h, a, minAgo = 2, more = []) => ({
  key, title: key.toUpperCase(),
  markets: [{ key: "h2h", last_update: upd(minAgo), outcomes: [{ name: "Home", price: h }, { name: "Away", price: a }] }, ...more],
});

test("report finds a cross-book arb, ranks by ROI, flags staleness and verification gaps", () => {
  const results = [{
    key: "basketball_nba", title: "NBA", group: "NBA", ok: true,
    events: [
      ev("e1", [bk("booka", 2.15, 1.80), bk("bookb", 1.85, 2.10)]),
      ev("e2", [bk("booka", 2.05, 1.85, 40), bk("bookb", 1.90, 2.03)]),
      ev("e3", [bk("booka", 1.91, 1.91), bk("bookb", 1.90, 1.92)]),
      ev("started", [bk("booka", 3, 3), bk("bookb", 3, 3)], { commence_time: "2026-10-13T16:00:00Z" }),
    ],
  }];
  const r = buildReport(results, NOW, { coverage: [] });
  assert.equal(r.stats.eventsScanned, 3);
  assert.equal(r.candidates.length, 2);
  assert.equal(r.candidates[0].eventId, "e1");
  const top = r.candidates[0];
  assert.deepEqual(top.legs.map((l) => [l.outcome, l.book]), [["Away", "bookb"], ["Home", "booka"]]);
  assert.equal(top.status, "candidate"); // nothing operator-verified
  assert.ok(top.verificationGaps.length > 0);
  assert.equal(top.scenarios.length, 4);
  assert.ok(top.target500.worstCaseProfit >= 500);
  const second = r.candidates[1];
  assert.equal(second.flags.stale, true);
  assert.equal(second.eligible, false);
  assert.ok(!r.candidates.some((c) => c.eventId === "started"));
  assert.ok(r.allocation.positions.every((p) => p.candidateId !== second.id));
});

test("spreads only match identical lines; quarter lines skipped", () => {
  const sp = (pt, h, a) => ({ key: "spreads", last_update: upd(1), outcomes: [{ name: "Home", price: h, point: pt }, { name: "Away", price: a, point: -pt }] });
  const results = [{ key: "basketball_nba", ok: true, events: [ev("s1", [
    { key: "booka", title: "A", markets: [sp(-3.5, 2.1, 1.8), sp(-3.25, 2.5, 2.5)] },
    { key: "bookb", title: "B", markets: [sp(-4.5, 1.7, 2.3)] },
  ])] }];
  const r = buildReport(results, NOW, {});
  assert.equal(r.candidates.length, 0); // -3.5 vs -4.5 is a middle, not an arb
  assert.ok(!Object.keys(r.marketIndex).some((k) => k.includes("-3.25")));
});

test("watch view shows threshold and labels hypothetical prices", () => {
  const results = [{ key: "basketball_nba", ok: true, events: [ev("w1", [bk("booka", 2.0, 1.8), bk("bookb", 1.9, 1.85)])] }];
  const r = buildReport(results, NOW, {});
  const v = watchView(Object.values(r.marketIndex)[0], NOW);
  const away = v.outcomes.find((o) => o.name === "Away");
  assert.ok(Math.abs(away.threshold.netDecimal - 2.0) < 1e-9);
  assert.ok(away.hypotheticalTargets.every((t) => t.label.startsWith("HYPOTHETICAL")));
});
