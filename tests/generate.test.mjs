// End-to-end report generation with a mocked Odds API (synthetic fixtures only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { __setStoreFactory, setDeployContext } from "../netlify/lib/store.mjs";
import { planCoverage } from "../netlify/lib/odds.mjs";
import { generateAndStore, publicReport } from "../netlify/lib/generate.mjs";

process.env.ODDS_API_KEY = "test";
const mem = new Map();
__setStoreFactory((name) => ({
  get: async (k) => mem.get(`${name}/${k}`) ?? null,
  setJSON: async (k, v) => mem.set(`${name}/${k}`, v),
  delete: async (k) => mem.delete(`${name}/${k}`),
}));

const SPORTS = [
  { key: "basketball_nba", title: "NBA", active: true, has_outrights: false },
  { key: "americanfootball_nfl", title: "NFL", active: true, has_outrights: false },
  { key: "basketball_wnba", title: "WNBA", active: false, has_outrights: false },
  { key: "tennis_atp_paris", title: "ATP Paris", active: true, has_outrights: false },
  { key: "boxing_boxing", title: "Boxing", active: true, has_outrights: false },
];
const NOW = new Date("2026-10-13T17:00:00Z");

test("coverage marks scanned, inactive and unsupported sports", () => {
  const { coverage, scan } = planCoverage(SPORTS);
  const st = Object.fromEntries(coverage.map((c) => [c.key, c.status]));
  assert.equal(st.basketball_nba, "scanned");
  assert.equal(st.basketball_wnba, "inactive");
  assert.equal(st.icehockey_nhl, "unsupported");
  assert.equal(st.tennis_atp_paris, "scanned");
  assert.ok(scan.find((s) => s.key === "tennis_atp_paris").markets === "h2h");
});

test("generateAndStore writes latest + daily + index and records feed failures", async () => {
  setDeployContext("deploy-preview");
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const hdr = { "x-requests-used": "10", "x-requests-remaining": "19990", "x-requests-last": "6" };
    if (u.pathname === "/v4/sports/") return new Response(JSON.stringify(SPORTS), { status: 200 });
    if (u.pathname.includes("americanfootball_nfl")) return new Response("boom", { status: 500, headers: hdr });
    if (u.pathname.includes("basketball_nba")) {
      return new Response(JSON.stringify([{
        id: "g1", sport_key: "basketball_nba", sport_title: "NBA", commence_time: "2026-10-14T00:00:00Z", home_team: "H", away_team: "A",
        bookmakers: [
          { key: "booka", title: "Book A", markets: [{ key: "h2h", last_update: "2026-10-13T16:58:00Z", outcomes: [{ name: "H", price: 2.12 }, { name: "A", price: 1.8 }] }] },
          { key: "bookb", title: "Book B", markets: [{ key: "h2h", last_update: "2026-10-13T16:59:00Z", outcomes: [{ name: "H", price: 1.8 }, { name: "A", price: 2.08 }] }] },
        ],
      }]), { status: 200, headers: hdr });
    }
    return new Response("[]", { status: 200, headers: hdr });
  };
  const r = await generateAndStore({ trigger: "manual", now: NOW });
  assert.ok(mem.has("arb-preview-reports/latest"));
  assert.ok(mem.has("arb-preview-reports/daily/2026-10-13"));
  assert.equal(r.candidates.length, 1);
  assert.equal(r.fetchErrors[0].key, "americanfootball_nfl");
  const pub = publicReport(r, new Date(NOW.getTime() + 3 * 3600000));
  assert.equal(pub.pricesStale, true);
  assert.equal(pub.marketIndex, undefined);
});
