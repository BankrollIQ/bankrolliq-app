import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOdds, toAmerican, lockAt, requiredOpposite, evaluateBet } from "../netlify/lib/lockin.mjs";

test("parse odds", () => {
  assert.equal(parseOdds("+300", "american"), 4);
  assert.equal(parseOdds("-200", "american"), 1.5);
  assert.equal(parseOdds("50", "american"), null);
  assert.equal(parseOdds("2.5", "decimal"), 2.5);
  assert.equal(toAmerican(2), 100);
});

test("the 49ers example: $100 at +300, 49ers later at even money locks $100", () => {
  const bet = { stake: 100, decimal: 4 };
  const l = lockAt(bet, 2.0);
  assert.equal(l.hedgeStake, 200);
  assert.equal(l.totalStaked, 300);
  assert.equal(l.lockedProfit, 100);
  assert.equal(l.profitIfOriginalWins, 100);
  assert.equal(l.profitIfHedgeWins, 100);
});

test("required opposite price for break-even and for a target", () => {
  const bet = { stake: 100, decimal: 4 };
  assert.ok(Math.abs(requiredOpposite(bet, 0) - 400 / 300) < 1e-9); // 1.333 → -300
  assert.ok(Math.abs(requiredOpposite(bet, 100) - 2) < 1e-9);       // even money
  assert.equal(requiredOpposite(bet, 300), null);                    // can never lock $300 on a $100 bet at +300
  assert.equal(toAmerican(requiredOpposite(bet, 0)), -300);
});

test("hedge stake rounds up to the cent so the hedge side never pays less than the original", () => {
  const bet = { stake: 100, decimal: 2.1 };
  const l = lockAt(bet, 1.93);
  assert.ok(l.hedgeStake * 1.93 >= 210 - 1e-9);
  assert.ok(Math.abs(l.profitIfOriginalWins - l.profitIfHedgeWins) < 0.03);
});

test("evaluateBet flags when the target is met and when it is not", () => {
  const bet = { stake: 100, decimal: 4, targetProfit: 50 };
  const not = evaluateBet(bet, { net: 1.5, price: 1.5, book: "x" });
  assert.equal(not.targetMet, false);
  assert.equal(not.neededDecimal, 1.6); // 400 / (400 - 100 - 50)
  assert.equal(evaluateBet(bet, { net: 1.6, price: 1.6 }).targetMet, true);
  assert.ok(not.current.lockedProfit < 50);
  const yes = evaluateBet(bet, { net: 1.85, price: 1.85, book: "x" });
  assert.equal(yes.targetMet, true);
  assert.ok(yes.current.lockedProfit >= 50);
  assert.equal(evaluateBet(bet, null).current, null);
});
