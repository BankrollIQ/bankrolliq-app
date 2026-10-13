// "My bets" storage and the Game Watch registry.
//   bets/user/<hash>   → [bet, ...]                       (per member)
//   gamewatch/active   → { [userHash:betId]: watchRef }   (what the poller checks)
//   gamewatch/quotes   → { [eventId]: { at, outcomes } }  (latest prices seen by the poller)
import crypto from "node:crypto";
import { sha256 } from "./auth.mjs";
import { envNumber } from "./config.mjs";
import { parseOdds } from "./lockin.mjs";
import { getJSON, setJSON } from "./store.mjs";

export const MAX_BETS = 20;

export function userKey(email) {
  return sha256(email);
}

export async function getBets(email) {
  return (await getJSON("bets", `user/${userKey(email)}`)) || [];
}

async function saveBets(email, bets) {
  await setJSON("bets", `user/${userKey(email)}`, bets);
}

export async function getActive() {
  return (await getJSON("gamewatch", "active")) || {};
}

async function setActive(a) {
  await setJSON("gamewatch", "active", a);
}

export function validateBet(input, event) {
  const errors = [];
  const decimal = parseOdds(input.odds, input.oddsFormat === "decimal" ? "decimal" : "american");
  const stake = Number(input.stake);
  const target = Number(input.targetProfit ?? 0);
  if (!event) errors.push("Pick a game from the list.");
  else if (![event.home_team, event.away_team].includes(input.side)) errors.push("Pick the team you bet on.");
  if (!decimal) errors.push("Enter valid odds (American like +300 / -150, or decimal like 4.00).");
  if (!(stake >= 1 && stake <= 100000)) errors.push("Stake must be between $1 and $100,000.");
  if (!(target >= 0 && target <= 1000000)) errors.push("Target profit must be $0 or more.");
  if (decimal && stake && target >= stake * decimal - stake) errors.push("That target is more than this bet can ever lock in.");
  return { errors, decimal, stake, target };
}

export async function addBet(email, input, event) {
  const { errors, decimal, stake, target } = validateBet(input, event);
  if (errors.length) return { errors };
  const bets = await getBets(email);
  if (bets.length >= MAX_BETS) return { errors: [`You can save up to ${MAX_BETS} bets. Remove an old one first.`] };
  const watchOn = Boolean(input.watch);
  if (watchOn) {
    const maxWatch = envNumber("GAMEWATCH_MAX_PER_USER", 5);
    if (bets.filter((b) => b.watch && b.status === "watching").length >= maxWatch) {
      return { errors: [`Game Watch is limited to ${maxWatch} games at a time during the beta.`] };
    }
  }
  const bet = {
    id: crypto.randomUUID(),
    sportKey: event.sport_key, sportTitle: event.sport_title, eventId: event.id,
    home: event.home_team, away: event.away_team, commence: event.commence_time,
    side: input.side, other: input.side === event.home_team ? event.away_team : event.home_team,
    stake, decimal, oddsEntered: String(input.odds).trim(), oddsFormat: input.oddsFormat === "decimal" ? "decimal" : "american",
    book: String(input.book || "").trim().slice(0, 60), targetProfit: target,
    watch: watchOn, status: watchOn ? "watching" : "saved", createdAt: new Date().toISOString(), alerts: [],
  };
  bets.unshift(bet);
  await saveBets(email, bets);
  if (watchOn) await registerWatch(email, bet);
  return { bet };
}

async function registerWatch(email, bet) {
  const a = await getActive();
  a[`${userKey(email)}:${bet.id}`] = { email, betId: bet.id, sportKey: bet.sportKey, eventId: bet.eventId, commence: bet.commence };
  await setActive(a);
}

export async function removeBet(email, id) {
  const bets = (await getBets(email)).filter((b) => b.id !== id);
  await saveBets(email, bets);
  const a = await getActive();
  delete a[`${userKey(email)}:${id}`];
  await setActive(a);
}

export async function setWatch(email, id, on) {
  const bets = await getBets(email);
  const b = bets.find((x) => x.id === id);
  if (!b) return { errors: ["Bet not found."] };
  if (on) {
    const maxWatch = envNumber("GAMEWATCH_MAX_PER_USER", 5);
    if (bets.filter((x) => x.id !== id && x.watch && x.status === "watching").length >= maxWatch) {
      return { errors: [`Game Watch is limited to ${maxWatch} games at a time during the beta.`] };
    }
    b.watch = true; b.status = "watching";
    await saveBets(email, bets);
    await registerWatch(email, b);
  } else {
    b.watch = false; b.status = "saved";
    await saveBets(email, bets);
    const a = await getActive();
    delete a[`${userKey(email)}:${id}`];
    await setActive(a);
  }
  return { bet: b };
}

// Used by the poller.
export async function updateBet(email, id, fn) {
  const bets = await getBets(email);
  const b = bets.find((x) => x.id === id);
  if (!b) return null;
  fn(b);
  await saveBets(email, bets);
  return b;
}

export async function endWatch(ref, status) {
  const a = await getActive();
  delete a[`${userKey(ref.email)}:${ref.betId}`];
  await setActive(a);
  await updateBet(ref.email, ref.betId, (b) => { b.status = status; });
}

export async function getQuotes() {
  return (await getJSON("gamewatch", "quotes")) || {};
}

export async function setQuotes(q) {
  await setJSON("gamewatch", "quotes", q);
}
