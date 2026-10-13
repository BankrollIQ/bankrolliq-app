// Coverage targets, bookmaker fee assumptions and settlement-rule notes.
// Everything an operator may need to change is overridable from environment variables.

export function env(name, fallback = undefined) {
  const v = globalThis.Netlify?.env?.get?.(name) ?? process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export function envNumber(name, fallback) {
  const n = Number(env(name));
  return Number.isFinite(n) ? n : fallback;
}

export function envJson(name, fallback) {
  const raw = env(name);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`[config] ${name} is not valid JSON; using defaults`);
    return fallback;
  }
}

// Requested coverage groups. `prefix` groups match every active key that starts with it.
export const COVERAGE_GROUPS = [
  { id: "nba", label: "NBA", keys: ["basketball_nba"], markets: "h2h,spreads,totals" },
  { id: "nfl", label: "NFL", keys: ["americanfootball_nfl"], markets: "h2h,spreads,totals" },
  { id: "ncaaf", label: "NCAA Football", keys: ["americanfootball_ncaaf"], markets: "h2h,spreads,totals" },
  { id: "ncaab", label: "NCAA Basketball", keys: ["basketball_ncaab"], markets: "h2h,spreads,totals" },
  { id: "nhl", label: "NHL", keys: ["icehockey_nhl"], markets: "h2h,spreads,totals" },
  { id: "wnba", label: "WNBA", keys: ["basketball_wnba"], markets: "h2h,spreads,totals" },
  { id: "mlb", label: "MLB", keys: ["baseball_mlb"], markets: "h2h,spreads,totals" },
  { id: "mma", label: "UFC / MMA", keys: ["mma_mixed_martial_arts"], markets: "h2h" },
  { id: "boxing", label: "Boxing", keys: ["boxing_boxing"], markets: "h2h" },
  { id: "tennis", label: "Tennis (ATP/WTA)", prefix: "tennis_", markets: "h2h" },
  { id: "soccer", label: "Soccer majors (EPL, UCL, MLS)", keys: ["soccer_epl", "soccer_uefa_champs_league", "soccer_usa_mls"], markets: "h2h,totals" },
];

// Things members may ask for that this feed/report does not cover.
export const KNOWN_UNSUPPORTED = [
  { label: "Player props", reason: "Not requested in the daily report (separate, per-event API calls at much higher credit cost)." },
  { label: "Futures / outrights", reason: "Many-outcome markets with differing field lists across books; excluded to avoid false positives." },
  { label: "Live / in-play odds", reason: "Prices move in seconds; events that have started are excluded from the report." },
  { label: "Tennis Challenger / ITF", reason: "Not listed by the odds feed; only ATP/WTA tournament keys it publishes are scanned." },
  { label: "Asian quarter lines (±0.25 / ±0.75)", reason: "Split settlement makes two-outcome math invalid; these lines are skipped." },
];

// Default fee assumptions by Odds API bookmaker key. Commission applies to net winnings.
// None of these are marked verified: an operator must confirm and set BOOK_TERMS_JSON.
export const DEFAULT_BOOK_FEES = {
  betfair_ex_uk: { commission: 0.05, kind: "exchange" },
  betfair_ex_eu: { commission: 0.05, kind: "exchange" },
  betfair_ex_au: { commission: 0.05, kind: "exchange" },
  matchbook: { commission: 0.02, kind: "exchange" },
  smarkets: { commission: 0.02, kind: "exchange" },
  betopenly: { commission: null, kind: "exchange" },
  novig: { commission: null, kind: "exchange" },
  prophetx: { commission: null, kind: "exchange" },
  kalshi: { commission: null, kind: "exchange" },
  polymarket: { commission: null, kind: "exchange" },
};

// BOOK_TERMS_JSON example:
// {"draftkings":{"commission":0,"feeVerified":true,"termsVerified":true,"maxStake":500,"limitVerified":true,"notes":"Checked 2026-10-12"}}
export function bookTerms(bookKey) {
  const overrides = envJson("BOOK_TERMS_JSON", {});
  const base = DEFAULT_BOOK_FEES[bookKey];
  const o = overrides[bookKey] || {};
  const looksExchange = /(_ex|exchange)/.test(bookKey);
  const kind = o.kind || base?.kind || (looksExchange ? "exchange" : "sportsbook");
  let commission = o.commission ?? base?.commission;
  let feeStatus;
  if (o.commission !== undefined && o.feeVerified) feeStatus = "verified";
  else if (kind === "sportsbook" && commission === undefined) {
    commission = 0;
    feeStatus = "standard-no-commission";
  } else if (commission === null || commission === undefined) {
    commission = 0;
    feeStatus = "unknown";
  } else feeStatus = "assumed";
  return {
    kind,
    commission,
    feeStatus,
    feeVerified: feeStatus === "verified",
    termsVerified: Boolean(o.termsVerified),
    maxStake: Number.isFinite(o.maxStake) ? o.maxStake : null,
    limitVerified: Number.isFinite(o.maxStake) && o.limitVerified === true,
    notes: o.notes || null,
  };
}

// Settlement-rule differences that commonly break arbitrage. Severity "high" blocks "verified".
export function settlementNotes(sportKey, marketKey, outcomeCount) {
  const notes = [];
  const add = (severity, text) => notes.push({ severity, text });
  if (sportKey.startsWith("tennis_")) {
    add("high", "Retirement rules differ: some books void if a player retires, others settle once a set is completed or on who advances. One leg can lose while the other is voided.");
  }
  if (sportKey.startsWith("mma_") || sportKey.startsWith("boxing_")) {
    if (outcomeCount === 2) add("high", "Two-way fight moneyline: books differ on whether a draw / no-contest is a push or a loss. Confirm both books void on a draw.");
    add("medium", "Fight rescheduling, opponent changes and weigh-in misses are graded differently across books.");
  }
  if (sportKey === "baseball_mlb") {
    add("medium", "Listed-pitcher rules differ ('action' vs. listed pitchers). A pitcher change can void one leg only.");
    if (marketKey === "totals") add("medium", "Totals usually need 8.5–9 innings to be graded; shortened games may settle differently.");
  }
  if (sportKey.startsWith("americanfootball_") && marketKey === "h2h") {
    add("low", "NFL/NCAAF moneylines include overtime; an NFL tie is usually a push on two-way moneylines — confirm at both books.");
  }
  if (sportKey === "icehockey_nhl") {
    add("low", "Feed moneylines and puck lines include overtime and shootout. Do not mix with a book's regulation-time (3-way) market.");
  }
  if (sportKey.startsWith("soccer_")) {
    add("low", "Soccer markets settle on 90 minutes plus stoppage time; extra time and penalties are excluded.");
  }
  add("low", "Postponement and cancellation rules (void windows) differ by book.");
  return notes;
}

export function scheduleInfo() {
  return { cronUtc: "0 17 * * *", label: "9:00 a.m. PST (fixed UTC−8; 10:00 a.m. when Pacific Daylight Time is in effect)" };
}

// Bookmakers Game Watch knows about (Odds API keys). `home` is a fallback when the feed has no deep link.
export const BOOKS = [
  { key: "draftkings", title: "DraftKings", home: "https://sportsbook.draftkings.com" },
  { key: "fanduel", title: "FanDuel", home: "https://sportsbook.fanduel.com" },
  { key: "betmgm", title: "BetMGM", home: "https://www.betmgm.com" },
  { key: "williamhill_us", title: "Caesars", home: "https://www.caesars.com/sportsbook-and-casino" },
  { key: "fanatics", title: "Fanatics", home: "https://sportsbook.fanatics.com" },
  { key: "espnbet", title: "ESPN BET", home: "https://espnbet.com" },
  { key: "betrivers", title: "BetRivers", home: "https://www.betrivers.com" },
  { key: "hardrockbet", title: "Hard Rock Bet", home: "https://www.hardrock.bet" },
  { key: "ballybet", title: "Bally Bet", home: "https://www.ballybet.com" },
  { key: "betparx", title: "betPARX", home: "https://www.betparx.com" },
  { key: "fliff", title: "Fliff", home: "https://www.getfliff.com" },
  { key: "bovada", title: "Bovada", home: "https://www.bovada.lv" },
  { key: "betonlineag", title: "BetOnline", home: "https://www.betonline.ag" },
  { key: "mybookieag", title: "MyBookie", home: "https://www.mybookie.ag" },
  { key: "lowvig", title: "LowVig", home: null },
  { key: "betus", title: "BetUS", home: null },
  { key: "betanysports", title: "BetAnySports", home: null },
  { key: "rebet", title: "Rebet", home: null },
  { key: "kalshi", title: "Kalshi (exchange)", home: "https://kalshi.com" },
  { key: "polymarket", title: "Polymarket (exchange)", home: "https://polymarket.com" },
  { key: "novig", title: "Novig (exchange)", home: null },
  { key: "prophetx", title: "ProphetX (exchange)", home: null },
  { key: "betopenly", title: "BetOpenly (exchange)", home: null },
];

export function bookHome(key) {
  const base = key.replace(/_(az|fl|oh|nj|pa|mi|il|va|co|in|ny)$/, ""); // e.g. hardrockbet_az → hardrockbet
  return BOOKS.find((b) => b.key === base)?.home || null;
}
