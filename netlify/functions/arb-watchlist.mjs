// /api/arb/watchlist — Pro only.
//   GET                → watched markets with current prices, arbitrage thresholds and hypothetical targets
//   POST {id}          → add a market from the latest report (max 25)
//   POST {refresh:key} → refresh live prices for a watched sport (shared cache, rate-limited)
//   DELETE ?id=…       → remove
import { sha256 } from "../lib/auth.mjs";
import { COVERAGE_GROUPS, envNumber } from "../lib/config.mjs";
import { fetchSportOdds } from "../lib/odds.mjs";
import { buildReport, watchView } from "../lib/report.mjs";
import { getJSON, setJSON } from "../lib/store.mjs";
import { init, json, requirePro, sameOrigin } from "../lib/http.mjs";

const MAX_ITEMS = 25;

function marketsFor(sportKey) {
  const g = COVERAGE_GROUPS.find((x) => (x.keys || []).includes(sportKey) || (x.prefix && sportKey.startsWith(x.prefix)));
  return g ? g.markets : "h2h";
}

async function currentEntry(id, sportKey, latest) {
  const live = sportKey ? await getJSON("live", sportKey) : null;
  const liveEntry = live?.marketIndex?.[id];
  if (liveEntry && (!latest || live.fetchedAt > latest.generatedAt)) return { entry: liveEntry, source: "live-refresh", asOf: live.fetchedAt };
  const e = latest?.marketIndex?.[id];
  return e ? { entry: e, source: "daily-report", asOf: latest.generatedAt } : null;
}

export default async (req, context) => {
  init(context);
  const gate = await requirePro(req);
  if (gate instanceof Response) return gate;
  if (req.method !== "GET" && !sameOrigin(req)) return json({ error: "bad_origin" }, 403);
  const key = `user/${sha256(gate.email)}`;
  const list = (await getJSON("watchlists", key)) || [];
  const latest = await getJSON("reports", "latest");
  const staleMin = envNumber("ARB_STALE_QUOTE_MINUTES", 15);

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body.refresh) {
      const sportKey = String(body.refresh);
      const watched = list.some((w) => w.sportKey === sportKey);
      if (!watched) return json({ error: "not_watched" }, 400);
      const cached = await getJSON("live", sportKey);
      const minAge = envNumber("ARB_LIVE_REFRESH_MINUTES", 10) * 60000;
      if (!cached || Date.now() - new Date(cached.fetchedAt) > minAge) {
        try {
          const { data } = await fetchSportOdds(sportKey, marketsFor(sportKey));
          const now = new Date();
          const r = buildReport([{ key: sportKey, title: sportKey, group: "", ok: true, events: data }], now, {});
          await setJSON("live", sportKey, { fetchedAt: now.toISOString(), marketIndex: r.marketIndex });
        } catch (e) {
          return json({ error: "refresh_failed", detail: e.message }, 502);
        }
      }
    } else {
      const id = String(body.id || "");
      const entry = latest?.marketIndex?.[id];
      if (!entry) return json({ error: "unknown_market", message: "That market is not in the latest report." }, 400);
      if (!list.some((w) => w.id === id)) {
        if (list.length >= MAX_ITEMS) return json({ error: "watchlist_full", message: `Watch list is limited to ${MAX_ITEMS} markets.` }, 400);
        list.unshift({ id, sportKey: entry.sportKey, label: `${entry.away} @ ${entry.home} — ${entry.lineLabel}`, commence: entry.commence, addedAt: new Date().toISOString() });
        await setJSON("watchlists", key, list);
      }
    }
  } else if (req.method === "DELETE") {
    const id = new URL(req.url).searchParams.get("id");
    const next = list.filter((w) => w.id !== id);
    await setJSON("watchlists", key, next);
    list.length = 0;
    list.push(...next);
  } else if (req.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const now = new Date();
  const items = [];
  for (const w of list) {
    const cur = await currentEntry(w.id, w.sportKey, latest);
    if (!cur) items.push({ ...w, available: false, message: "No current quotes (event started, removed, or not in the latest report)." });
    else items.push({ ...w, available: true, source: cur.source, asOf: cur.asOf, view: watchView(cur.entry, now, staleMin) });
  }
  return json({ items, max: MAX_ITEMS });
};

export const config = { path: "/api/arb/watchlist" };
