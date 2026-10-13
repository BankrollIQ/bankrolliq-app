# BankrollIQ Arbitrage Daily™ — implementation & setup

Included in the existing **BankrollIQ Pro** subscription. Page: `/arbitrage.html`.

## How it works

| Piece | File | Notes |
|---|---|---|
| Daily report (9:00 a.m. PST, fixed UTC−8) | `netlify/functions/arb-daily-report.mjs` | Cron `0 17 * * *` (UTC). Runs 10:00 a.m. local while PDT is in effect. Netlify runs schedules on production only. |
| Manual run (previews, testing) | `netlify/functions/arb-generate.mjs` | `POST /api/arb/generate` with header `x-admin-secret`. |
| Odds feed | `netlify/lib/odds.mjs` | Same provider/key as `get-odds.js` (The Odds API v4). `/sports` (free) decides coverage; odds pulled per sport with `includeBetLimits=true`. |
| Arbitrage math | `netlify/lib/arb.mjs` | n-way implied-probability check, commission on net winnings, rounded stakes with worst/best-case profit, $500 targets, thresholds, hypothetical prices, daily allocation. |
| Report builder | `netlify/lib/report.mjs` | Matches identical markets only (same event, market, line, outcome set). Skips started events and Asian quarter lines. Flags stale quotes, unknown fees, same-book legs, unusually high ROI, settlement-rule differences. |
| Login | `auth-request-link`, `auth-verify`, `auth-logout`, `me` | Emailed one-time link (15 min, single use) → HttpOnly signed cookie (30 days). Links are only sent to emails with active Pro; the response is identical either way. |
| Pro verification | `netlify/lib/entitlement.mjs`, `stripe-webhook.mjs` | Every protected request re-checks Pro server-side. Stripe webhooks keep records current; anyone without a fresh record is looked up in Stripe directly (covers existing subscribers). |
| Protected data | `arb-report.mjs`, `arb-watchlist.mjs` | Report data is never in the static page. 401 without session, 403 without Pro. |
| Storage | Netlify Blobs | Production uses `arb-*` stores; previews use `arb-preview-*` so a preview can't touch production data. |

### Candidate vs. verified
A result is a **verified opportunity** only when, for every leg: the fee is operator-verified, settlement terms are operator-verified, the wager limit is known (from `BOOK_TERMS_JSON` or the feed's exchange bet limits) and covers the stake, no price is stale, no high-severity settlement difference applies, and the legs come from different books. Everything else is a **mathematical candidate**, with the open items listed on its card. Nothing is invented: if the feed has no arbitrage, the report says so.

### Settlement states (`netlify/lib/settlement.mjs`)
Every position is evaluated per state, each leg marked win / lose / refund:
* **Core states** — each outcome wins; a whole-number spread or total lands exactly (push: every wager refunded, **$0**); an NFL two-way moneyline ties or a two-way fight line draws (refunded, **$0**). The "guaranteed minimum" is the lowest core-state profit, so any position that can push is shown with a $0 minimum and is never verified or allocated.
* **Event voided** — cancellation: everything refunded, $0 (shown on every row).
* **Rule mismatch** — the books disagree (tennis retirement, MLB pitcher change, fight draw graded as a loss): one leg voids while the other loses, or both lose. Shown separately as "rule-mismatch worst".

### Stake rounding
Stakes are whole dollars, rounded *down*, then leftover dollars go to the leg with the lowest payout. The total never exceeds the chosen bankroll, and no leg exceeds a known wager limit (two- and three-way). If a limit binds, the whole position shrinks so it stays hedged ("cut to limits").

### $500 calculations
* **Per event:** smallest bankroll whose rounded stakes give ≥ $500 in every core state, within known limits. If a push is possible the plan is sized on decisive outcomes and labelled *not guaranteed* ($0 if it pushes). If limits make $500 impossible, the maximum within limits is shown instead.
* **Daily — two separate plans:**
  * **Verified plan:** only verified opportunities, each capped at operator-verified wager limits.
  * **Theoretical plan:** all eligible candidates; each cap is labelled by source — operator-verified limits, known but unverified limits (feed-reported exchange limits or `maxStake` without `limitVerified`), or the assumed `ARB_DEFAULT_MAX_STAKE_PER_EVENT` cap. Assumed caps are never described as verified.
  * Both: one position per event-market, positions with a $0 guaranteed minimum excluded, capital counted once (all events unsettled at report time), deposits listed per bookmaker.

### Watch-list hypothetical targets
For 1% and 2% ROI target prices on each side: the price, per-side stakes for a $1,000 bankroll, worst case, and the capital (with per-side stakes) for $500 — all labelled hypothetical, assuming no commission on that side and unknown limits.

## Services and costs (checked 12 Oct 2026 — confirm current prices)

| Service | Needed for | Cost |
|---|---|---|
| The Odds API | Odds feed | Free 500 credits/mo is not enough. 20K plan **$30/mo** (100K $59/mo). Cost per call = markets × regions. Default run ≈ 6 credits per team sport, 2 per tennis/MMA/boxing key → roughly 40–90 credits/day (~1,200–2,700/mo) plus watch-list refreshes and the existing public odds tool. |
| Stripe | Subscriptions (existing) | Existing fees; webhooks are free. |
| Resend (or similar) | Sign-in emails | Free: 3,000/mo, 100/day. Pro **$20/mo** for 50,000. Requires verifying a sending domain (e.g. `bankrolliq.app`) via DNS records in Netlify DNS. |
| Netlify | Hosting, functions, schedule, Blobs | Scheduled functions are on all plans (30 s limit). Check Blobs/function usage against your plan's credits. |

### Odds API terms — action needed
Their terms allow commercial use in websites/apps/dashboards **as long as the data is not the primary product being sold or redistributed**, and prohibit reselling or repackaging the data as a feed/API/downloadable files. Arbitrage Daily shows computed results inside a Pro subscription and has no export or API for raw odds, but because the feature is built entirely on their prices, **get written confirmation from The Odds API before launch.**

## Configuration (Netlify → Project configuration → Environment variables)

Required:

| Variable | Value |
|---|---|
| `ODDS_API_KEY` | Already set. |
| `SESSION_SECRET` | 32+ random characters. |
| `STRIPE_SECRET_KEY` | Restricted key with **read** access to Customers and Subscriptions is enough. Use a test-mode key for the Deploy Preview context. |
| `STRIPE_WEBHOOK_SECRET` | From Stripe → Webhooks → endpoint `https://bankrolliq.app/api/stripe-webhook`, events `customer.subscription.created/updated/deleted/paused/resumed`, `checkout.session.completed`. |
| `STRIPE_PRO_PRICE_IDS` | The `price_…` ID(s) behind the Pro payment link (comma-separated). |
| `RESEND_API_KEY`, `EMAIL_FROM` | e.g. `BankrollIQ <login@bankrolliq.app>` after verifying the domain. |
| `ADMIN_SECRET` | 24+ random characters, for `POST /api/arb/generate`. |

Optional (defaults in brackets): `PRO_ALLOW_TRIALING` [true], `PRO_ACCESS_EMAILS` (owner/testing access, comma-separated), `ARB_REGIONS` [us,us2], `ARB_EXTRA_SPORTS`, `ARB_STALE_QUOTE_MINUTES` [15], `ARB_REPORT_STALE_MINUTES` [30], `ARB_NEAR_MISS_MARGIN` [0.02], `ARB_DAILY_WINDOW_HOURS` [24], `ARB_DEFAULT_MAX_STAKE_PER_EVENT` [1000], `ARB_HIGH_ROI_WARNING` [0.05], `ARB_MAX_CREDITS_PER_RUN` [400], `ARB_LIVE_REFRESH_MINUTES` [10],
`BOOK_TERMS_JSON` — operator-confirmed fees, terms and limits, e.g.
`{"draftkings":{"commission":0,"feeVerified":true,"termsVerified":true,"maxStake":500,"limitVerified":true,"notes":"Checked 2026-10-12"}}`. A `maxStake` only counts as verified with `"limitVerified": true`.

## Verifying on a Deploy Preview
1. Push branch `feature/arbitrage-daily` and open a pull request — Netlify builds a Deploy Preview.
2. Set the variables above for the *Deploy Previews* context (test-mode Stripe; add your email to `PRO_ACCESS_EMAILS` if you have no test subscription).
3. `curl -X POST https://deploy-preview-N--<site>.netlify.app/api/arb/generate -H "x-admin-secret: $ADMIN_SECRET"` (schedules don't run on previews).
4. Open `/arbitrage.html` on the preview, sign in, review the report, watch list and calculator.
5. Check `/api/arb/report` returns 401 signed out and 403 for a non-Pro email.

## Tests
`npm install && npm test` — math, report building, coverage, auth, webhook signatures and Pro gating, using synthetic fixtures and mocks (no live data).

## Known limits
* Wager limits for regular sportsbooks are not in the feed; they stay "unknown" unless set in `BOOK_TERMS_JSON`.
* The existing public `get-odds` endpoint still spends credits for anonymous visitors (input is now validated). Consider gating or caching it.
* Bookmakers restrict accounts that arbitrage consistently; settlement can differ even when prices look aligned.

## Testers (free access) and feedback
* **Admin page:** `https://bankrolliq.app/admin.html` — unlock with the production `ADMIN_SECRET` (kept only in that browser tab). Add a tester's email and number of days (1–365); remove or extend at any time. No redeploy needed.
* Testers sign in at `/arbitrage.html` with that email, like members, and see a "Tester access until …" banner.
* **Feedback form** on the Arbitrage Daily page (members and testers). Each response is stored and emailed to `FEEDBACK_EMAIL` (set this in Netlify; the email uses the existing Resend settings). The admin page also lists all feedback.
* Admin requests are limited to 30 per 15 minutes per IP.

## My bets & Game Watch (beta)
* **My bets** (Pro and testers): save a bet already placed (sport, game, team, stake, odds, book, target). The page shows the opposite-side price needed to break even and to lock the target, and the hedge stake. Two-way moneylines only (soccer excluded).
* **Game Watch:** scheduled function `gamewatch-poll` runs every minute on the published site. From `GAMEWATCH_PREGAME_MINUTES` (60) before kick-off until the game ends, it makes **one Odds API call per sport** for all watched games (cost = number of regions, default 3: `us,us2,us_ex` — `us_ex` includes Kalshi, Polymarket, Novig, ProphetX, BetOpenly). Quotes older than 3 minutes are ignored.
* When the best opposite price locks at least the member's target, it emails them once (Resend) with the hedge stake, book and locked amount, then stops watching that bet. Exchange fees that aren't configured are called out in the alert. NFL/fight ties are noted.
* Limits: `GAMEWATCH_MAX_PER_USER` (5 active watches), `GAMEWATCH_MAX_CREDITS_PER_DAY` (1500 Odds API credits/day; polling pauses when reached).
* Approximate Odds API cost: 3 credits per minute per sport with live watched games → ~630 credits for a 3.5-hour game (shared by everyone watching that sport).
* Approximate Netlify cost: the every-minute check runs ~43,000 times a month; with no live watches it only reads one small record (roughly 10–30 credits/month).
* Deploy Previews don't run schedules: `POST /api/gamewatch/run` with `x-admin-secret` runs one cycle on demand.
