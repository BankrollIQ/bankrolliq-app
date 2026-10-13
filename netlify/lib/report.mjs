// Turns raw Odds API events into the Arbitrage Daily report. Pure: no network or storage.
import {
  SCENARIO_BANKROLLS, TARGET_PROFIT, allocateDaily, capacityFromLimits, capitalForTarget, decimalToAmerican,
  evaluateBook, hypotheticalPriceForRoi, netDecimal, round2, stakePlan, thresholdForOutcome,
} from "./arb.mjs";
import { settlementStates } from "./settlement.mjs";
import { bookTerms, envNumber, scheduleInfo, settlementNotes, KNOWN_UNSUPPORTED } from "./config.mjs";

export const REPORT_VERSION = 1;
const MARKET_LABEL = { h2h: "Moneyline", spreads: "Spread", totals: "Total" };

function isQuarterLine(point) {
  return Number.isFinite(point) && Math.abs((point * 4) % 2) === 1;
}

function fmtPoint(p) {
  return p > 0 ? `+${p}` : `${p}`;
}

// Group every bookmaker quote into comparable markets: same event, same market, same line, same outcome set.
export function groupEventMarkets(event, generatedAt, opts = {}) {
  const staleMs = (opts.staleQuoteMinutes ?? 15) * 60000;
  const groups = new Map();
  for (const bk of event.bookmakers || []) {
    const terms = bookTerms(bk.key);
    for (const m of bk.markets || []) {
      if (!MARKET_LABEL[m.key]) continue;
      const outs = m.outcomes || [];
      let key, label, ordered;
      if (m.key === "h2h") {
        if (outs.length < 2 || outs.length > 3) continue;
        const names = outs.map((o) => o.name).sort();
        key = `h2h:${names.join("|")}`;
        label = outs.length === 3 ? "Moneyline (3-way)" : "Moneyline";
        ordered = names.map((n) => outs.find((o) => o.name === n));
      } else if (m.key === "spreads") {
        if (outs.length !== 2) continue;
        const home = outs.find((o) => o.name === event.home_team) || [...outs].sort((a, b) => a.name.localeCompare(b.name))[0];
        const away = outs.find((o) => o !== home);
        if (!Number.isFinite(home.point) || home.point !== -away.point || isQuarterLine(home.point)) continue;
        key = `spreads:${home.name}:${home.point}`;
        label = `${home.name} ${fmtPoint(home.point)} / ${away.name} ${fmtPoint(away.point)}`;
        ordered = [home, away];
      } else {
        if (outs.length !== 2) continue;
        const over = outs.find((o) => o.name === "Over");
        const under = outs.find((o) => o.name === "Under");
        if (!over || !under || over.point !== under.point || isQuarterLine(over.point)) continue;
        key = `totals:${over.point}`;
        label = `Total ${over.point}`;
        ordered = [over, under];
      }
      if (!groups.has(key)) {
        groups.set(key, {
          key, marketKey: m.key, lineLabel: label,
          outcomes: ordered.map((o) => ({ name: o.name, point: o.point ?? null, quotes: [] })),
        });
      }
      const g = groups.get(key);
      const lastUpdate = m.last_update || bk.last_update || null;
      const ageMin = lastUpdate ? (generatedAt - new Date(lastUpdate)) / 60000 : null;
      ordered.forEach((o, i) => {
        const net = netDecimal(o.price, terms.commission);
        if (!net) return;
        g.outcomes[i].quotes.push({
          book: bk.key, bookTitle: bk.title, price: o.price, american: decimalToAmerican(o.price), net,
          commission: terms.commission, feeStatus: terms.feeStatus, feeVerified: terms.feeVerified,
          termsVerified: terms.termsVerified, maxStake: terms.maxStake, limitVerified: terms.limitVerified,
          betLimit: Number.isFinite(o.bet_limit) ? o.bet_limit : null,
          lastUpdate, ageMinutes: ageMin === null ? null : round2(ageMin),
          stale: ageMin === null || ageMin * 60000 > staleMs,
        });
      });
    }
  }
  return [...groups.values()].filter((g) => g.outcomes.every((o) => o.quotes.length));
}

function best(quotes) {
  return quotes.reduce((a, b) => (b.net > a.net ? b : a));
}

export function watchKey(eventId, groupKey) {
  return `${eventId}::${groupKey}`;
}

function bestLegs(g) {
  return g.outcomes.map((o) => {
    const q = best(o.quotes);
    return { outcome: o.name, point: o.point, ...q, netDecimal: q.net };
  });
}

function evaluateGroup(g) {
  const legs = bestLegs(g);
  const { impliedSum, isArb, roi } = evaluateBook(legs);
  return { legs, impliedSum, isArb, roi };
}

export function buildReport(results, generatedAt = new Date(), meta = {}) {
  const opts = {
    staleQuoteMinutes: envNumber("ARB_STALE_QUOTE_MINUTES", 15),
    nearMiss: envNumber("ARB_NEAR_MISS_MARGIN", 0.02),
    windowHours: envNumber("ARB_DAILY_WINDOW_HOURS", 24),
    defaultCap: envNumber("ARB_DEFAULT_MAX_STAKE_PER_EVENT", 1000),
    highRoi: envNumber("ARB_HIGH_ROI_WARNING", 0.05),
  };
  const candidates = [];
  const nearMisses = [];
  const marketIndex = {};
  let eventsScanned = 0;
  let marketsCompared = 0;

  for (const r of results) {
    for (const ev of r.events || []) {
      const commence = new Date(ev.commence_time);
      if (!(commence > generatedAt)) continue; // started or invalid: never treated as an opportunity
      eventsScanned++;
      for (const g of groupEventMarkets(ev, generatedAt, opts)) {
        marketsCompared++;
        const { legs, impliedSum, isArb, roi } = evaluateGroup(g);
        const base = {
          id: watchKey(ev.id, g.key), eventId: ev.id, sportKey: ev.sport_key || r.key, sportTitle: ev.sport_title || r.title,
          group: r.group, home: ev.home_team, away: ev.away_team, commence: ev.commence_time,
          marketKey: g.marketKey, marketLabel: MARKET_LABEL[g.marketKey], groupKey: g.key, lineLabel: g.lineLabel,
          impliedSum: round2(impliedSum * 10000) / 10000, roi, roiPct: round2(roi * 100),
        };
        marketIndex[base.id] = {
          ...base,
          outcomes: g.outcomes.map((o) => {
            const sorted = [...o.quotes].sort((a, b) => b.net - a.net);
            return { name: o.name, point: o.point, best: sorted[0], second: sorted[1] || null };
          }),
        };
        if (isArb) candidates.push(enrichCandidate({ ...base, legs }, generatedAt, opts));
        else if (impliedSum < 1 + opts.nearMiss) nearMisses.push({ ...base, legs });
      }
    }
  }

  candidates.sort((a, b) => b.roi - a.roi);
  nearMisses.sort((a, b) => a.impliedSum - b.impliedSum);

  const allocations = buildAllocations(candidates, opts);
  return {
    version: REPORT_VERSION,
    generatedAt: generatedAt.toISOString(),
    schedule: scheduleInfo(),
    trigger: meta.trigger || "scheduled",
    regions: meta.regions,
    settings: opts,
    coverage: meta.coverage || [],
    knownUnsupported: KNOWN_UNSUPPORTED,
    fetchErrors: results.filter((r) => !r.ok).map((r) => ({ key: r.key, error: r.error })),
    usage: meta.usage || null,
    creditsUsed: results.reduce((s, r) => s + (r.credits || 0), 0),
    stats: {
      eventsScanned, marketsCompared, candidates: candidates.length,
      verified: candidates.filter((c) => c.status === "verified").length,
      staleCandidates: candidates.filter((c) => c.flags.stale).length,
    },
    candidates,
    nearMisses: nearMisses.slice(0, 50),
    allocations,
    marketIndex,
  };
}

// Per-leg wager limit and where it came from. The smaller known value wins.
export function legLimit(l) {
  const opts = [];
  if (Number.isFinite(l.maxStake)) opts.push({ value: l.maxStake, source: l.limitVerified ? "operator-verified" : "operator-entered (unverified)" });
  if (Number.isFinite(l.betLimit)) opts.push({ value: l.betLimit, source: "feed-reported (unverified)" });
  if (!opts.length) return { value: null, source: "unknown", verified: false };
  const min = opts.reduce((a, b) => (b.value < a.value ? b : a));
  return { value: min.value, source: min.source, verified: min.source === "operator-verified" };
}

function finiteOrNull(n) {
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function enrichCandidate(c, generatedAt, opts) {
  const gaps = [];
  const settlement = settlementNotes(c.sportKey, c.marketKey, c.legs.length);
  const states = settlementStates(c.sportKey, c.marketKey, c.legs);
  const stale = c.legs.some((l) => l.stale);
  const unknownFee = c.legs.some((l) => l.feeStatus === "unknown");
  const sameBook = new Set(c.legs.map((l) => l.book)).size < c.legs.length;
  const pushPossible = states.core.some((s) => s.kind === "push");
  const legLimits = c.legs.map(legLimit);
  const limits = legLimits.map((x) => x.value);
  const capacity = finiteOrNull(capacityFromLimits(c.legs, limits));
  const capacityVerified = legLimits.every((x) => x.verified) ? capacity : null;

  if (stale) gaps.push(`At least one price was more than ${opts.staleQuoteMinutes} min old when the report ran.`);
  if (unknownFee) gaps.push("Commission is unknown for at least one exchange; net ROI may be overstated.");
  if (c.legs.some((l) => !l.feeVerified)) gaps.push("Fees not operator-verified for every book.");
  if (c.legs.some((l) => !l.termsVerified)) gaps.push("Settlement terms not operator-verified for every book.");
  if (!legLimits.every((x) => x.verified)) gaps.push("Available wager size not operator-verified for every leg.");
  if (pushPossible) gaps.push("A push / tie refunds every wager, so the guaranteed minimum profit is $0.");
  if (settlement.some((n) => n.severity === "high")) gaps.push("Settlement rules can differ in a way that breaks the hedge (see rule-mismatch outcomes).");
  if (sameBook) gaps.push("Best prices come from the same bookmaker — likely a pricing error that may be voided.");
  const highRoi = c.roi >= opts.highRoi;
  if (highRoi) gaps.push(`ROI ≥ ${opts.highRoi * 100}% is unusual and often a stale or erroneous price that books may void.`);

  const status = gaps.length === 0 ? "verified" : "candidate";
  const scenarios = SCENARIO_BANKROLLS.map((b) => stakePlan(c.legs, b, { limits, states }));
  const target500 = capitalForTarget(c.legs, TARGET_PROFIT, { limits, states });
  const hoursToStart = (new Date(c.commence) - generatedAt) / 3600000;
  return {
    ...c,
    legs: c.legs.map((l, i) => ({ ...l, limit: legLimits[i].value, limitSource: legLimits[i].source })),
    limits,
    states,
    status,
    verificationGaps: gaps,
    flags: { stale, unknownFee, sameBook, highRoi, pushPossible },
    settlement,
    capacity,
    capacityVerified,
    scenarios,
    target500,
    eligible: !stale && !unknownFee && !sameBook && !pushPossible && !settlement.some((n) => n.severity === "high") && hoursToStart <= opts.windowHours,
  };
}

function describePositions(alloc, byId) {
  const deposits = {};
  for (const p of alloc.positions) {
    const c = byId.get(p.candidateId);
    p.event = `${c.away} @ ${c.home}`;
    p.lineLabel = c.lineLabel;
    p.status = c.status;
    p.legs = c.legs.map((l, i) => ({ book: l.bookTitle, outcome: l.outcome, stake: p.stakes[i] }));
    for (const l of p.legs) deposits[l.book] = (deposits[l.book] || 0) + l.stake;
  }
  alloc.depositsByBook = deposits;
  return alloc;
}

// Two separate plans. "verified" uses only verified opportunities sized within operator-verified limits.
// "theoretical" also uses unverified candidates; its caps are labelled by source and never called verified.
export function buildAllocations(candidates, opts) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const verified = describePositions(allocateDaily(
    candidates.filter((c) => c.status === "verified" && c.eligible && c.capacityVerified),
    { target: TARGET_PROFIT, capOf: (c) => ({ cap: c.capacityVerified, source: "operator-verified wager limits" }) },
  ), byId);
  const theoretical = describePositions(allocateDaily(
    candidates.filter((c) => c.eligible),
    {
      target: TARGET_PROFIT,
      capOf: (c) => c.capacityVerified ? { cap: c.capacityVerified, source: "operator-verified wager limits" }
        : c.capacity ? { cap: c.capacity, source: "known but unverified wager limits" }
        : { cap: opts.defaultCap, source: `assumed $${opts.defaultCap} cap — limits unknown, not verified` },
    },
  ), byId);
  const note = "Capital is counted once: every included event is unsettled at report time, so no stake is assumed to be recycled into a later bet the same day. Positions where a push or tie is possible are excluded because their guaranteed profit is $0.";
  return {
    verified: { ...verified, label: "Verified plan", note },
    theoretical: { ...theoretical, label: "Theoretical plan (unverified fees, terms or wager sizes)", note, defaultCapPerEvent: opts.defaultCap },
  };
}

// Watch-list view for one market: current best prices, the opposite-side threshold, and hypothetical targets.
export function watchView(entry, now = new Date(), staleMinutes = 15) {
  const nets = entry.outcomes.map((o) => o.best.net);
  const { impliedSum, isArb, roi } = evaluateBook(nets.map((n) => ({ netDecimal: n })));
  return {
    ...entry,
    impliedSum, isArb, roi,
    outcomes: entry.outcomes.map((o, i) => {
      const others = nets.filter((_, j) => j !== i);
      const threshold = thresholdForOutcome(others);
      const hyp = [0.01, 0.02].map((r) => hypotheticalTarget(entry, i, nets, r));
      const age = o.best.lastUpdate ? (now - new Date(o.best.lastUpdate)) / 60000 : null;
      return {
        ...o,
        priceAgeMinutes: age === null ? null : Math.round(age),
        priceStale: age === null || age > staleMinutes,
        threshold: threshold && {
          netDecimal: round2(threshold * 1000) / 1000,
          american: decimalToAmerican(threshold),
          note: "Price this side must beat (after any commission) at a book other than the opposite side's, using the current best opposite price.",
        },
        hypotheticalTargets: hyp,
      };
    }),
  };
}

// A HYPOTHETICAL price for outcome i that would produce `targetRoi` against the current best prices on the
// other side(s), with the stakes and capital that price would imply. Assumes no commission on the
// hypothetical side and unknown wager limits. Never presented as a quote.
export function hypotheticalTarget(entry, i, nets, targetRoi, bankroll = 1000) {
  const others = nets.filter((_, j) => j !== i);
  const d = hypotheticalPriceForRoi(others, targetRoi);
  const base = { targetRoiPct: targetRoi * 100, label: "HYPOTHETICAL — not a quoted price" };
  if (!d) return { ...base, decimal: null, american: null };
  const legs = entry.outcomes.map((o, j) => ({ outcome: o.name, point: o.point, netDecimal: j === i ? d : nets[j], book: j === i ? "hypothetical" : o.best.book }));
  const states = settlementStates(entry.sportKey || "", entry.marketKey || "", legs);
  const example = stakePlan(legs, bankroll, { states });
  const target = capitalForTarget(legs, TARGET_PROFIT, { states });
  return {
    ...base,
    decimal: round2(d * 1000) / 1000,
    american: decimalToAmerican(d),
    example: {
      bankroll,
      stakes: legs.map((l, j) => ({ outcome: l.outcome, book: j === i ? "hypothetical price" : entry.outcomes[j].best.bookTitle || l.book, stake: example.stakes[j] })),
      totalStaked: example.totalStaked,
      worstCaseProfit: example.worstCaseProfit,
      pushPossible: example.pushPossible,
    },
    capitalFor500: target && target.reachable ? {
      capital: target.plan.totalStaked,
      stakes: target.plan.stakes,
      worstCaseProfit: target.plan.worstCaseProfit,
      guaranteed: target.guaranteed,
      basis: target.basis,
    } : null,
    limitsNote: "Wager limits unknown — sizes assume every book accepts these stakes.",
  };
}
