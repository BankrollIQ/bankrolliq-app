// GET /api/gamewatch/games            → sports available for My bets / Game Watch
// GET /api/gamewatch/games?sport=key  → upcoming and live games for that sport
// Pro members and testers only. Uses free Odds API endpoints, cached.
import { eventsFor, watchableSports } from "../lib/gamewatch.mjs";
import { init, json, requirePro } from "../lib/http.mjs";

export default async (req, context) => {
  init(context);
  const gate = await requirePro(req);
  if (gate instanceof Response) return gate;
  const sport = new URL(req.url).searchParams.get("sport");
  try {
    if (!sport) return json({ sports: await watchableSports() });
    if (!/^[a-z0-9_]{2,64}$/.test(sport)) return json({ error: "bad_sport" }, 400);
    const games = (await eventsFor(sport)).map((e) => ({ id: e.id, home: e.home_team, away: e.away_team, commence: e.commence_time }));
    return json({ games });
  } catch (e) {
    return json({ error: "feed_unavailable", detail: String(e.message).slice(0, 160) }, 502);
  }
};

export const config = { path: "/api/gamewatch/games" };
