// Game Watch: checks watched games and emails members when their bet can be locked for their target profit.
// Runs every minute (scheduled function) — one Odds API call per sport, only for games that are live or about to start.
import { bookHome, bookTerms, env, envNumber, COVERAGE_GROUPS } from "./config.mjs";
import { fetchEventsOdds, listEvents, listSports } from "./odds.mjs";
import { netDecimal } from "./arb.mjs";
import { endWatch, getActive, getBets, getProfile, getQuotes, setQuotes, updateBet } from "./bets.mjs";
import { evaluateBet, tiePossible } from "./lockin.mjs";
import { getJSON, setJSON } from "./store.mjs";

const HOUR = 3600000;

// Only real web links from the feed; anything with an unfilled placeholder (e.g. {state}) falls back.
export function safeLink(url) {
  if (!url || typeof url !== "string" || /[{}]/.test(url)) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

// All fresh quotes per outcome (team) across bookmakers for one event's two-way h2h market, best first.
// Link preference: outcome (bet slip) → market → bookmaker event page → bookmaker home page.
export function quotesByOutcome(event, now = new Date(), maxAgeMin = 3) {
  const out = {};
  for (const bk of event.bookmakers || []) {
    const m = (bk.markets || []).find((x) => x.key === "h2h");
    if (!m || (m.outcomes || []).length !== 2) continue; // two-way only
    const lastUpdate = m.last_update || bk.last_update || null;
    const age = lastUpdate ? (now - new Date(lastUpdate)) / 60000 : Infinity;
    if (age > maxAgeMin) continue; // stale live prices are not alert-worthy
    const terms = bookTerms(bk.key);
    for (const o of m.outcomes) {
      const net = netDecimal(o.price, terms.commission);
      if (!net) continue;
      const deep = safeLink(o.link) || safeLink(m.link) || safeLink(bk.link);
      (out[o.name] ||= []).push({
        net, price: o.price, book: bk.key, bookTitle: bk.title, commission: terms.commission, feeStatus: terms.feeStatus, kind: terms.kind, lastUpdate,
        link: deep || bookHome(bk.key), linkType: safeLink(o.link) ? "betslip" : deep ? "event" : bookHome(bk.key) ? "home" : null,
      });
    }
  }
  for (const k of Object.keys(out)) out[k] = out[k].sort((a, b) => b.net - a.net).slice(0, 8);
  return out;
}

// Back-compat: single best quote per outcome.
export function bestPrices(event, now = new Date(), maxAgeMin = 3) {
  const q = quotesByOutcome(event, now, maxAgeMin);
  return Object.fromEntries(Object.entries(q).map(([k, v]) => [k, v[0]]));
}

// Best quote for a member: restricted to their sportsbooks when they have chosen some.
export function pickQuote(list, books) {
  if (!list?.length) return { mine: null, overall: null };
  const overall = list[0];
  if (!books?.length) return { mine: overall, overall };
  const set = new Set(books);
  const mine = list.find((q) => set.has(q.book) || set.has(q.book.replace(/_(az|fl|oh|nj|pa|mi|il|va|co|in|ny)$/, ""))) || null;
  return { mine, overall };
}

function dayKey(now) {
  return `credits/${now.toISOString().slice(0, 10)}`;
}

async function spendCredits(cost, now) {
  const cap = envNumber("GAMEWATCH_MAX_CREDITS_PER_DAY", 1500);
  const rec = (await getJSON("gamewatch", dayKey(now))) || { used: 0 };
  if (rec.used + cost > cap) return false;
  rec.used += cost;
  await setJSON("gamewatch", dayKey(now), rec);
  return true;
}

const money = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const am = (a) => (a > 0 ? `+${a}` : `${a}`);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function alertText(bet, ev, overall) {
  const c = ev.current;
  const subject = `Lock ${money(c.lockedProfit)}: bet ${bet.other} ${am(c.american)} at ${c.bookTitle}`;
  const lines = [
    `Bet ${money(c.hedgeStake)} on ${bet.other} ${am(c.american)} at ${c.bookTitle} to lock about ${money(c.lockedProfit)} whichever team wins (total staked ${money(c.totalStaked)}).`,
    `Your bet: ${money(bet.stake)} on ${bet.side} at ${bet.oddsEntered}${bet.book ? ` (${bet.book})` : ""} — ${bet.away} @ ${bet.home}.`,
  ];
  if (overall && overall.book !== c.book && overall.net > c.net + 1e-9) {
    lines.push(`Better price outside your sportsbooks: ${bet.other} ${am(overall.american)} at ${overall.bookTitle}.`);
  }
  lines.push("Prices move fast during games and books can pause betting — confirm the price and stake at the book before placing anything.");
  if (c.feeStatus === "unknown") lines.push(`${c.bookTitle} is an exchange whose trading fees are not included here — check the fee before trading, it reduces the locked amount.`);
  if (tiePossible(bet.sportKey)) lines.push("If the game ends in a tie/draw, books usually refund both bets ($0 profit) — check each book's rules.");
  lines.push("Game Watch has stopped for this bet. Turn it back on from My bets to keep watching.");
  return { subject, lines };
}

const button = (href, label, primary) =>
  `<a href="${esc(href)}" style="display:inline-block;margin:4px 8px 4px 0;padding:13px 18px;border-radius:10px;font-weight:800;text-decoration:none;${primary ? "background:#5eead4;color:#061019" : "background:#e2e8f0;color:#0f172a"}">${esc(label)}</a>`;

export function alertEmail(bet, ev, overall, origin) {
  const { subject, lines } = alertText(bet, ev, overall);
  const c = ev.current;
  const myBets = `${origin}/arbitrage.html#mybets`;
  const buttons = [];
  if (c.link) buttons.push(button(c.link, `${c.linkType === "betslip" ? "Open bet slip" : "Open"} at ${c.bookTitle} →`, true));
  if (overall?.link && overall.book !== c.book && overall.net > c.net + 1e-9) buttons.push(button(overall.link, `Open ${overall.bookTitle}`, false));
  buttons.push(button(myBets, "My bets", false));
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px"><h2 style="margin:0 0 12px">${esc(subject)}</h2><p style="font-size:17px"><b>${esc(lines[0])}</b></p><div style="margin:14px 0">${buttons.join("")}</div>${lines.slice(1).map((l) => `<p>${esc(l)}</p>`).join("")}<p style="color:#667;font-size:12px">BankrollIQ Game Watch (beta). Educational tool, not betting advice. No guaranteed outcomes. 18+/21+ where applicable.</p></div>`;
  const textLinks = [c.link && `${c.bookTitle}: ${c.link}`, overall?.link && overall.book !== c.book && overall.net > c.net + 1e-9 && `${overall.bookTitle}: ${overall.link}`, `My bets: ${myBets}`].filter(Boolean);
  return { subject, html, text: [lines[0], ...textLinks, ...lines.slice(1)].join("\n\n") };
}

async function sendAlert(email, bet, ev, overall, origin) {
  const key = env("RESEND_API_KEY"), from = env("EMAIL_FROM");
  if (!key || !from) return false;
  const { subject, html, text } = alertEmail(bet, ev, overall, origin);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [email], subject, html, text }),
  });
  return res.ok;
}

// One polling cycle. Returns a summary for logs / the admin run-now endpoint.
export async function runCycle({ now = new Date(), origin = "https://bankrolliq.app" } = {}) {
  const active = await getActive();
  const refs = Object.values(active);
  const summary = { watches: refs.length, polledSports: 0, credits: 0, alerts: 0, ended: 0, skipped: [] };
  if (!refs.length) return summary;

  const pregame = envNumber("GAMEWATCH_PREGAME_MINUTES", 60) * 60000;
  const due = [];
  for (const r of refs) {
    const start = new Date(r.commence).getTime();
    if (now - start > 8 * HOUR) { await endWatch(r, "ended"); summary.ended++; continue; }
    if (start - now <= pregame) due.push(r);
  }
  const bySport = {};
  for (const r of due) (bySport[r.sportKey] ||= new Set()).add(r.eventId);

  const regionCount = env("GAMEWATCH_REGIONS", "us,us2,us_ex").split(",").length;
  const quotes = await getQuotes();
  for (const [sportKey, ids] of Object.entries(bySport)) {
    if (!(await spendCredits(regionCount, now))) { summary.skipped.push(`${sportKey}: daily credit cap reached`); continue; }
    let events;
    try {
      ({ data: events } = await fetchEventsOdds(sportKey, [...ids]));
    } catch (e) {
      summary.skipped.push(`${sportKey}: ${String(e.message).slice(0, 120)}`);
      continue;
    }
    summary.polledSports++;
    summary.credits += regionCount;
    const seen = new Set();
    for (const evt of events) {
      seen.add(evt.id);
      quotes[evt.id] = { at: now.toISOString(), live: new Date(evt.commence_time) <= now, outcomes: quotesByOutcome(evt, now) };
    }
    for (const r of due.filter((x) => x.sportKey === sportKey)) {
      // The feed drops completed games; a started game that disappears has finished.
      if (!seen.has(r.eventId)) {
        if (now - new Date(r.commence) > 15 * 60000) { await endWatch(r, "ended"); summary.ended++; }
        continue;
      }
      const bet = (await getBets(r.email)).find((b) => b.id === r.betId);
      if (!bet || bet.status !== "watching") { await endWatch(r, bet ? bet.status : "removed"); continue; }
      const profile = await getProfile(r.email);
      const { mine, overall } = pickQuote(quotes[r.eventId].outcomes[bet.other], profile.books);
      const ev = evaluateBet(bet, mine);
      if (ev.targetMet) {
        if (overall) overall.american = overall.price >= 2 ? Math.round((overall.price - 1) * 100) : Math.round(-100 / (overall.price - 1));
        const sent = await sendAlert(r.email, bet, ev, overall, origin).catch(() => false);
        await updateBet(r.email, r.betId, (b) => {
          b.alerts = [{ at: now.toISOString(), lockedProfit: ev.current.lockedProfit, hedgeStake: ev.current.hedgeStake, book: ev.current.bookTitle, american: ev.current.american, emailed: sent }, ...(b.alerts || [])].slice(0, 10);
        });
        await endWatch(r, "alerted");
        summary.alerts++;
      }
    }
  }
  // Keep quotes only for games still being watched.
  const stillActive = new Set(Object.values(await getActive()).map((r) => r.eventId));
  for (const id of Object.keys(quotes)) if (!stillActive.has(id) && now - new Date(quotes[id].at) > 6 * HOUR) delete quotes[id];
  await setQuotes(quotes);
  return summary;
}

// ---- Game lists for the "My bets" form (free Odds API endpoints, cached) ----

export async function watchableSports(now = Date.now()) {
  const cached = await getJSON("gamewatch", "sports");
  if (cached && now - cached.at < HOUR) return cached.list;
  const sports = await listSports();
  const groups = COVERAGE_GROUPS.filter((g) => g.id !== "soccer"); // soccer moneylines are 3-way
  const list = sports
    .filter((s) => s.active && !s.has_outrights)
    .map((s) => ({ s, g: groups.find((g) => (g.keys || []).includes(s.key) || (g.prefix && s.key.startsWith(g.prefix))) }))
    .filter((x) => x.g)
    .map(({ s, g }) => ({ key: s.key, title: s.title, group: g.label }));
  await setJSON("gamewatch", "sports", { at: now, list });
  return list;
}

export async function eventsFor(sportKey, now = Date.now()) {
  const k = `events/${sportKey}`;
  const cached = await getJSON("gamewatch", k);
  if (cached && now - cached.at < 10 * 60000) return cached.list;
  const list = (await listEvents(sportKey))
    .filter((e) => now - new Date(e.commence_time) < 6 * HOUR)
    .sort((a, b) => a.commence_time.localeCompare(b.commence_time))
    .slice(0, 80);
  await setJSON("gamewatch", k, { at: now, list });
  return list;
}

