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

// Largest total bankroll whose exact (unrounded) shares fit inside every known per-leg limit.
// Unknown limits (null/undefined) are treated as unlimited here; callers decide how to label that.
export function capacityFromLimits(legs, limits = []) {
  const { impliedSum } = evaluateBook(legs);
  let cap = Infinity;
  legs.forEach((l, i) => {
    const lim = limits[i];
    if (Number.isFinite(lim)) cap = Math.min(cap, lim / ((1 / l.netDecimal) / impliedSum));
  });
  return cap;
}

// Rounded stakes that NEVER exceed the bankroll or any per-leg limit.
// 1) shrink the bankroll to what the limits allow, 2) floor every stake to `step`,
// 3) hand out leftover dollars one step at a time to the leg with the lowest payout,
//    stopping when that leg is at its limit (adding elsewhere would only lower the worst case).
// Profit is reported for every settlement state (see settlement.mjs), including pushes and voids.
export function stakePlan(legs, bankroll, { step = 1, limits = [], states = null } = {}) {
  const st = states || { core: legs.map((_, k) => ({ kind: "outcome", label: `Outcome ${k + 1} wins`, results: legs.map((__, i) => (i === k ? "win" : "lose")) })), voidAll: null, mismatch: [] };
  const lims = legs.map((_, i) => (Number.isFinite(limits[i]) ? Math.floor(limits[i] / step) * step : Infinity));
  const effective = Math.min(bankroll, Math.floor(capacityFromLimits(legs, limits) / step) * step);
  const exact = effective > 0 ? exactStakes(legs, effective) : legs.map(() => 0);
  const stakes = exact.map((e, i) => Math.min(Math.floor(e / step) * step, lims[i]));
  let left = effective - stakes.reduce((a, b) => a + b, 0);
  while (left >= step) {
    let k = 0;
    for (let i = 1; i < legs.length; i++) if (stakes[i] * legs[i].netDecimal < stakes[k] * legs[k].netDecimal) k = i;
    if (stakes[k] + step > lims[k]) break;
    stakes[k] += step;
    left -= step;
  }
  const total = stakes.reduce((a, b) => a + b, 0);
  const profitOf = (s) => ({ kind: s.kind, label: s.label, profit: stateProfitLocal(stakes, legs, s.results) });
  const core = st.core.map(profitOf);
  const mismatch = (st.mismatch || []).map(profitOf);
  const coreProfits = core.map((c) => c.profit);
  return {
    bankroll,
    stakes,
    totalStaked: round2(total),
    limitBound: effective < bankroll,
    hedged: stakes.every((s) => s > 0),
    payouts: stakes.map((s, i) => round2(s * legs[i].netDecimal)),
    states: core,
    voidAll: st.voidAll ? profitOf(st.voidAll) : null,
    mismatchStates: mismatch,
    pushPossible: core.some((c) => c.kind === "push"),
    worstCaseProfit: round2(Math.min(...coreProfits)),
    bestCaseProfit: round2(Math.max(...coreProfits)),
    mismatchWorstProfit: mismatch.length ? round2(Math.min(...mismatch.map((m) => m.profit))) : null,
  };
}

function stateProfitLocal(stakes, legs, results) {
  let p = 0;
  results.forEach((r, i) => {
    if (r === "win") p += stakes[i] * (legs[i].netDecimal - 1);
    else if (r === "lose") p -= stakes[i];
  });
  return round2(p);
}

// Back-compat name used by older callers/tests.
export function roundedStakePlan(legs, bankroll, step = 1) {
  return stakePlan(legs, bankroll, { step });
}

// Capital needed for `target` profit.
// guaranteed=true only when every core state (incl. pushes) pays >= target. When a push/tie is possible
// the guaranteed minimum is $0, so the plan is sized on decisive outcomes and marked guaranteed=false.
export function capitalForTarget(legs, target = TARGET_PROFIT, { step = 1, limits = [], states = null } = {}) {
  const { roi, isArb } = evaluateBook(legs);
  if (!isArb || roi <= 0) return null;
  const decisive = states ? { ...states, core: states.core.filter((s) => s.kind === "outcome") } : null;
  const capacity = capacityFromLimits(legs, limits);
  let bankroll = Math.ceil(target / roi / step) * step;
  for (let i = 0; i < 400; i++) {
    if (bankroll > capacity) {
      const atCap = stakePlan(legs, Math.floor(capacity / step) * step, { step, limits, states });
      return { reachable: false, reason: "wager-limits", maxProfitWithinLimits: decisive ? stakePlan(legs, atCap.bankroll, { step, limits, states: decisive }).worstCaseProfit : atCap.worstCaseProfit, plan: atCap };
    }
    const sized = stakePlan(legs, bankroll, { step, limits, states: decisive || states });
    if (sized.worstCaseProfit >= target) {
      const full = stakePlan(legs, bankroll, { step, limits, states });
      return {
        reachable: true,
        guaranteed: full.worstCaseProfit >= target,
        basis: full.pushPossible ? "decisive-outcomes-only" : "all-settlement-states",
        plan: full,
      };
    }
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

// Greedy allocation toward a daily profit target. Every dollar is counted once: all included
// events are unsettled at report time, so capital is not recycled.
// candidates: [{ id, eventId, marketKey, legs, roi, limits, states }]
// capOf(c) → { cap, source } where source describes where the per-event cap came from.
export function allocateDaily(candidates, { target = TARGET_PROFIT, capOf, step = 1 } = {}) {
  const pool = [...candidates].filter((c) => c.roi > 0).sort((a, b) => b.roi - a.roi);
  const usedEventMarket = new Set();
  const positions = [];
  let profit = 0;
  let capital = 0;
  for (const c of pool) {
    if (profit >= target) break;
    const key = `${c.eventId}|${c.marketKey}`;
    if (usedEventMarket.has(key)) continue;
    const { cap, source } = capOf(c);
    if (!(cap > 0)) continue;
    const needed = Math.ceil((target - profit) / c.roi / step) * step;
    const plan = stakePlan(c.legs, Math.min(cap, needed), { step, limits: c.limits || [], states: c.states });
    if (!plan.hedged || plan.worstCaseProfit <= 0) continue; // pushes ($0) never count toward a target
    usedEventMarket.add(key);
    positions.push({ candidateId: c.id, capSource: source, cap, ...plan });
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
