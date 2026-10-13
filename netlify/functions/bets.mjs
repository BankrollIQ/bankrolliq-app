// /api/bets — Pro members and testers.
//   GET                         → saved bets with lock-in status (uses Game Watch's latest prices)
//   POST {sportKey,eventId,side,stake,odds,oddsFormat,book,targetProfit,watch} → save a bet
//   PATCH {id, watch}           → turn Game Watch on/off for a bet
//   DELETE ?id=                 → remove
import { addBet, getBets, getProfile, getQuotes, removeBet, setWatch } from "../lib/bets.mjs";
import { eventsFor, pickQuote } from "../lib/gamewatch.mjs";
import { evaluateBet, tiePossible } from "../lib/lockin.mjs";
import { init, json, requirePro, sameOrigin } from "../lib/http.mjs";

async function view(email) {
  const [bets, quotes, profile] = await Promise.all([getBets(email), getQuotes(), getProfile(email)]);
  return bets.map((b) => {
    const q = quotes[b.eventId];
    const list = q?.outcomes?.[b.other];
    const { mine, overall } = pickQuote(Array.isArray(list) ? list : list ? [list] : [], profile.books);
    return { ...b, tiePossible: tiePossible(b.sportKey), quoteAt: q?.at || null, live: q?.live || false, lock: evaluateBet(b, mine),
      betterElsewhere: overall && mine && overall.book !== mine.book && overall.net > mine.net ? { bookTitle: overall.bookTitle, price: overall.price, link: overall.link } : null };
  });
}

export default async (req, context) => {
  init(context);
  const gate = await requirePro(req);
  if (gate instanceof Response) return gate;
  const email = gate.email;
  if (req.method !== "GET" && !sameOrigin(req)) return json({ error: "bad_origin" }, 403);

  if (req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const sportKey = String(b.sportKey || "");
    if (!/^[a-z0-9_]{2,64}$/.test(sportKey)) return json({ error: "bad_request", errors: ["Pick a sport."] }, 400);
    let events = [];
    try { events = await eventsFor(sportKey); } catch { return json({ error: "feed_unavailable", errors: ["Couldn't load games right now. Try again shortly."] }, 502); }
    const event = events.find((e) => e.id === b.eventId);
    const r = await addBet(email, b, event);
    if (r.errors) return json({ error: "invalid", errors: r.errors }, 400);
  } else if (req.method === "PATCH") {
    const b = await req.json().catch(() => ({}));
    const r = await setWatch(email, String(b.id || ""), Boolean(b.watch));
    if (r.errors) return json({ error: "invalid", errors: r.errors }, 400);
  } else if (req.method === "DELETE") {
    await removeBet(email, new URL(req.url).searchParams.get("id"));
  } else if (req.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }
  return json({ bets: await view(email) });
};

export const config = { path: "/api/bets" };
