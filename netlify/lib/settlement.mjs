// Explicit settlement states for a hedged position.
// Each state says, for every leg, whether it wins, loses, or is refunded (push / void).
//
//   core      — normal ways the market can settle (an outcome wins, a whole-number line pushes,
//               a two-way moneyline ties/draws and both books refund). Guaranteed figures use these.
//   voidAll   — event cancelled/abandoned: every wager refunded, profit $0.
//   mismatch  — the two books apply different rules to the same event (one voids, the other settles).
//               Shown separately as the rule-mismatch risk; not part of the "guaranteed" minimum.

const W = "win", L = "lose", R = "refund";

function isWholeLine(point) {
  return Number.isFinite(point) && Number.isInteger(point);
}

// Two-way moneylines where a tie/draw is a real result and most books refund both sides.
function twoWayTiePossible(sportKey) {
  return sportKey === "americanfootball_nfl" || sportKey.startsWith("mma_") || sportKey.startsWith("boxing_");
}

// legs: [{ outcome, point }] in market order.
export function settlementStates(sportKey = "", marketKey = "", legs = []) {
  const n = legs.length;
  const core = legs.map((l, k) => ({
    kind: "outcome",
    label: `${l.outcome}${marketKey !== "h2h" && Number.isFinite(l.point) ? ` ${l.point > 0 ? "+" : ""}${l.point}` : ""} wins`,
    results: legs.map((_, i) => (i === k ? W : L)),
  }));
  const linePoint = legs[0]?.point;
  if ((marketKey === "spreads" || marketKey === "totals") && isWholeLine(linePoint)) {
    core.push({ kind: "push", label: `Lands exactly on ${Math.abs(linePoint)} — push, both wagers refunded`, results: legs.map(() => R) });
  }
  if (marketKey === "h2h" && n === 2 && twoWayTiePossible(sportKey)) {
    core.push({ kind: "push", label: sportKey.startsWith("americanfootball") ? "Tie — two-way moneylines refunded (typical rule)" : "Draw — two-way fight lines refunded (typical rule)", results: legs.map(() => R) });
  }

  const voidAll = { kind: "void", label: "Event cancelled / postponed past the void window — all wagers refunded", results: legs.map(() => R) };

  const mismatch = [];
  const oneLegVoid = sportKey.startsWith("tennis_") || sportKey === "baseball_mlb" || (n === 2 && (sportKey.startsWith("mma_") || sportKey.startsWith("boxing_")));
  if (oneLegVoid) {
    const why = sportKey.startsWith("tennis_") ? "retirement" : sportKey === "baseball_mlb" ? "pitcher change" : "draw / no contest";
    for (let j = 0; j < n; j++) {
      mismatch.push({
        kind: "mismatch",
        label: `${why}: ${legs[j].outcome} wager voided, other wager${n > 2 ? "s" : ""} settled as a loss`,
        results: legs.map((_, i) => (i === j ? R : L)),
      });
    }
  }
  if (n === 2 && (sportKey.startsWith("mma_") || sportKey.startsWith("boxing_"))) {
    mismatch.push({ kind: "mismatch", label: "Draw graded as a loss at both books", results: legs.map(() => L) });
  }
  return { core, voidAll, mismatch };
}

export function decisiveOnly(states) {
  return { core: states.core.filter((s) => s.kind === "outcome"), voidAll: states.voidAll, mismatch: [] };
}
