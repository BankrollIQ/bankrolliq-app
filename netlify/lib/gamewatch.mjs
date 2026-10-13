// Game Watch: checks watched games and emails members when their bet can be locked for their target profit.
// Runs every minute (scheduled function) — one Odds API call per sport, only for games that are live or about to start.
import { bookTerms, env, envNumber, COVERAGE_GROUPS } from "./config.mjs";
import { fetchEventsOdds, listEvents, listSports } from "./odds.mjs";
import { netDecimal } from "./arb.mjs";
import { endWatch, getActive, getBets, getQuotes, setQuotes, updateBet } from "./bets.mjs";
import { evaluateBet, tiePossible } from "./lockin.mjs";
import { getJSON, setJSON } from "./store.mjs";

const HOUR = 3600000;

// Best net price per outcome (team) across bookmakers for one event's h2h market.
export function bestPrices(event, now = new Date(), maxAgeMin = 3) {
  const best = {};
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
      if (!best[o.name] || net > best[o.name].net) {
        best[o.name] = { net, price: o.price, book: bk.key, bookTitle: bk.title, commission: terms.commission, feeStatus: terms.feeStatus, kind: terms.kind, lastUpdate };
      }
    }
  }
  return best;
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

export function alertText(bet, ev) {
  const c = ev.current;
  const subject = `Lock in ${money(c.lockedProfit)} — ${bet.away} @ ${bet.home}`;
  const lines = [
    `Your bet: ${money(bet.stake)} on ${bet.side} at ${bet.oddsEntered}${bet.book ? ` (${bet.book})` : ""}.`,
    `Available now: ${bet.other} ${am(c.american)} at ${c.bookTitle}${c.commission ? ` (after ${(c.commission * 100).toFixed(1)}% commission)` : ""}.`,
    `Bet ${money(c.hedgeStake)} on ${bet.other} to lock about ${money(c.lockedProfit)} whichever team wins (total staked ${money(c.totalStaked)}).`,
    "Prices move fast during games and books can pause betting — confirm the price and your stake at the book before placing anything.",
  ];
  if (c.feeStatus === "unknown") lines.push(`${c.bookTitle} is an exchange whose trading fees are not included here — check the fee before trading, it reduces the locked amount.`);
  if (tiePossible(bet.sportKey)) lines.push("If the game ends in a tie/draw, books usually refund both bets ($0 profit) — check each book's rules.");
  lines.push("Game Watch has stopped for this bet. Turn it back on from your Arbitrage Daily page to keep watching.");
  return { subject, lines };
}

async function sendAlert(email, bet, ev, origin) {
  const key = env("RESEND_API_KEY"), from = env("EMAIL_FROM");
  if (!key || !from) return false;
  const { subject, lines } = alertText(bet, ev);
  const link = `${origin}/arbitrage.html#mybets`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px"><h2 style="margin:0 0 10px">${esc(subject)}</h2>${lines.map((l) => `<p>${esc(l)}</p>`).join("")}<p><a href="${link}">Open My bets</a></p><p style="color:#667;font-size:12px">BankrollIQ Game Watch (beta). Educational tool, not betting advice. No guaranteed outcomes. 18+/21+ where applicable.</p></div>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [email], subject, html, text: lines.join("\n\n") + `\n\n${link}` }),
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
      quotes[evt.id] = { at: now.toISOString(), live: new Date(evt.commence_time) <= now, outcomes: bestPrices(evt, now) };
    }
    for (const r of due.filter((x) => x.sportKey === sportKey)) {
      // The feed drops completed games; a started game that disappears has finished.
      if (!seen.has(r.eventId)) {
        if (now - new Date(r.commence) > 15 * 60000) { await endWatch(r, "ended"); summary.ended++; }
        continue;
      }
      const bet = (await getBets(r.email)).find((b) => b.id === r.betId);
      if (!bet || bet.status !== "watching") { await endWatch(r, bet ? bet.status : "removed"); continue; }
      const best = quotes[r.eventId].outcomes[bet.other];
      const ev = evaluateBet(bet, best || null);
      if (ev.targetMet) {
        const sent = await sendAlert(r.email, bet, ev, origin).catch(() => false);
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

