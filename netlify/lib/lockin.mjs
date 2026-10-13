// Lock-in (hedge) math for a bet a member already holds. Pure functions, unit-tested.
//
// A member holds: stake S1 on side A at decimal d1  → if A wins they collect P1 = S1 * d1.
// Hedging: bet S2 on the other side at net decimal d2 so the other side also returns P1:
//   S2 = P1 / d2,   locked profit = P1 - S1 - S2   (same whichever side wins).
// Two-way markets only (moneylines without a draw outcome). Ties/draws that refund both bets are
// reported separately: in that case the member gets both stakes back and the locked profit is $0.

import { round2 } from "./arb.mjs";

export function parseOdds(value, format) {
  const v = Number(String(value ?? "").trim().replace(/^\+/, ""));
  if (!Number.isFinite(v)) return null;
  if (format === "decimal") return v > 1 ? v : null;
  if (v >= 100) return 1 + v / 100;
  if (v <= -100) return 1 + 100 / Math.abs(v);
  return null;
}

export function toAmerican(decimal) {
  if (!(decimal > 1)) return null;
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
}

// Lock using the given net opposite price. Stake rounded UP to the cent so the hedge side never pays less than P1.
export function lockAt(bet, d2) {
  const P1 = bet.stake * bet.decimal;
  if (!(d2 > 1)) return null;
  const hedgeStake = Math.ceil((P1 / d2) * 100) / 100;
  const profitIfOriginalWins = P1 - bet.stake - hedgeStake;
  const profitIfHedgeWins = hedgeStake * d2 - bet.stake - hedgeStake;
  return {
    hedgeStake: round2(hedgeStake),
    totalStaked: round2(bet.stake + hedgeStake),
    profitIfOriginalWins: round2(profitIfOriginalWins),
    profitIfHedgeWins: round2(profitIfHedgeWins),
    lockedProfit: round2(Math.min(profitIfOriginalWins, profitIfHedgeWins)),
  };
}

// Minimum net decimal price on the other side that locks at least `target` dollars (0 = break even).
export function requiredOpposite(bet, target = 0) {
  const P1 = bet.stake * bet.decimal;
  const room = P1 - bet.stake - target;
  if (room <= 0) return null; // target larger than the bet can ever lock
  return P1 / room;
}

// Status of a bet against the best current opposite quote { net, price, book, bookTitle, lastUpdate }.
export function evaluateBet(bet, best) {
  const target = Number(bet.targetProfit) || 0;
  const needed = requiredOpposite(bet, target);
  const breakEven = requiredOpposite(bet, 0);
  const out = {
    targetProfit: target,
    neededDecimal: needed && round2(needed * 1000) / 1000,
    neededAmerican: needed && toAmerican(needed),
    breakEvenDecimal: breakEven && round2(breakEven * 1000) / 1000,
    breakEvenAmerican: breakEven && toAmerican(breakEven),
    maxLockable: round2(bet.stake * bet.decimal - bet.stake),
    current: null,
    targetMet: false,
  };
  if (best) {
    const lock = lockAt(bet, best.net);
    out.current = { ...best, american: toAmerican(best.price ?? best.net), ...lock };
    out.targetMet = needed !== null && best.net >= needed - 1e-9 && lock.lockedProfit >= target - 0.01;
  }
  return out;
}

// Sports where a two-way moneyline can end level and books usually refund both sides.
export function tiePossible(sportKey) {
  return sportKey === "americanfootball_nfl" || sportKey.startsWith("mma_") || sportKey.startsWith("boxing_");
}
