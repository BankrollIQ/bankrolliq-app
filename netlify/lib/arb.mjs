// BankrollIQ Arbitrage Daily — pure arbitrage math.
// No I/O here: everything is deterministic and unit-tested in tests/arb.test.mjs.

export const SCENARIO_BANKROLLS = [500, 1000, 2000, 5000];
export const TARGET_PROFIT = 500;

// ---------- odds conversion ----------

export function americanToDecimal(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || (a > -100 && a < 100)) return null;
  return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
}

export function decimalToAmerican(decimal) {
  const d = Number(decimal);
  if (!Number.isFinite(d) || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

export function formatAmerican(american) {
  if (american === null || american === undefined) return "—";
  return american > 0 ? `+${american}` : `${american}`;
}

// Commission charged on net winnings (exchange-style). Returns the effective decimal price.
export function netDecimal(decimal, commission = 0) {
  const d = Number(decimal);
  const c = Number(commission) || 0;
  if (!Number.isFinite(d) || d <= 1) return null;
  return 1 + (d - 1) * (1 - c);
}

// ---------- core arbitrage ----------

// legs: [{ netDecimal }]  → { impliedSum, isArb, roi }
// roi = guaranteed net profit / total stake (before rounding).
export function evaluateBook(legs) {
  const impliedSum = legs.reduce((s, l) => s + 1 / l.netDecimal, 0);
  const roi = 1 / impliedSum - 1;
  return { impliedSum, isArb: impliedSum < 1, roi };
}

// Exact (unrounded) stakes so every outcome pays the same.
export function exactStakes(legs, bankroll) {
  const { impliedSum } = evaluateBook(legs);
  return legs.map((l) => (bankroll * (1 / l.netDecimal)) / impliedSum);
}

// Stakes rounded to `step` dollars (default $1), with honest worst/best-case profit after rounding.
export function roundedStakePlan(legs, bankroll, step = 1) {
  const exact = exactStakes(legs, bankroll);
  const stakes = exact.map((s) => Math.max(step, Math.round(s / step) * step));
  const total = stakes.reduce((a, b) => a + b, 0);
  const payouts = stakes.map((s, i) => s * legs[i].netDecimal);
  const profits = payouts.map((p) => p - total);
  return {
    bankroll,
    stakes,
    totalStaked: round2(total),
    payouts: payouts.map(round2),
    worstCaseProfit: round2(Math.min(...profits)),
    bestCaseProfit: round2(Math.max(...profits)),
  };
}

// Capital needed so the worst-case (rounded) profit reaches `target`.
export function capitalForTarget(legs, target = TARGET_PROFIT, step = 1) {
  const { roi, isArb } = evaluateBook(legs);
  if (!isArb || roi <= 0) return null;
  let bankroll = Math.ceil(target / roi / step) * step;
  // Rounding can shave a few cents; step up until the worst case clears the target.
  for (let i = 0; i < 200; i++) {
    const plan = roundedStakePlan(legs, bankroll, step);
    if (plan.worstCaseProfit >= target) return plan;
    bankroll += step * Math.max(1, Math.ceil(bankroll * 0.0005));
  }
  return null;
}

// Price the given outcome must beat (net of its fee) for the book to become an arb,
// given the best net prices on all other outcomes. Returns null if impossible.
export function thresholdForOutcome(otherNetDecimals) {
  const rest = otherNetDecimals.reduce((s, d) => s + 1 / d, 0);
  if (rest >= 1) return null;
  return 1 / (1 - rest);
}

// HYPOTHETICAL price for an outcome that would produce `targetRoi` given the other sides.
export function hypotheticalPriceForRoi(otherNetDecimals, targetRoi) {
  const rest = otherNetDecimals.reduce((s, d) => s + 1 / d, 0);
  const needed = 1 / (1 + targetRoi) - rest;
  if (needed <= 0) return null;
  return 1 / needed;
}

// Convert a required *net* price back to the gross price the bookmaker must quote.
export function grossFromNet(net, commission = 0) {
  const c = Number(commission) || 0;
  if (c >= 1) return null;
  return 1 + (net - 1) / (1 - c);
}

// Maximum total bankroll the position supports given per-leg wager limits.
// limits: array of numbers or null (unknown). Returns null if any limit is unknown.
export function maxBankrollFromLimits(legs, limits) {
  if (!limits.length || limits.some((l) => l === null || l === undefined)) return null;
  const { impliedSum } = evaluateBook(legs);
  const shares = legs.map((l) => 1 / l.netDecimal / impliedSum);
  return Math.floor(Math.min(...limits.map((lim, i) => lim / shares[i])));
}

// ---------- daily allocation ----------

// Greedy allocation toward a daily profit target. Every dollar is counted once:
// all included events are unsettled when the report is generated, so capital is not recycled.
// candidates: [{ id, eventId, marketKey, legs, roi, capacity, eligible }]
export function allocateDaily(candidates, { target = TARGET_PROFIT, defaultCap = 1000, step = 1 } = {}) {
  const pool = candidates
    .filter((c) => c.eligible && c.roi > 0)
    .sort((a, b) => b.roi - a.roi);
  const usedEventMarket = new Set();
  const positions = [];
  let profit = 0;
  let capital = 0;
  for (const c of pool) {
    if (profit >= target) break;
    const key = `${c.eventId}|${c.marketKey}`;
    if (usedEventMarket.has(key)) continue;
    const cap = c.capacity ?? defaultCap;
    const needed = Math.ceil((target - profit) / c.roi / step) * step;
    const bankroll = Math.min(cap, needed);
    if (bankroll < step * c.legs.length) continue;
    const plan = roundedStakePlan(c.legs, bankroll, step);
    if (plan.worstCaseProfit <= 0) continue;
    usedEventMarket.add(key);
    positions.push({ candidateId: c.id, capacitySource: c.capacity ? "verified-limit" : "default-cap", ...plan });
    profit += plan.worstCaseProfit;
    capital += plan.totalStaked;
  }
  return {
    target,
    feasible: profit >= target,
    projectedWorstCaseProfit: round2(profit),
    capitalRequired: round2(capital),
    positions,
  };
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}
