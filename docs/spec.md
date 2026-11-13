# Storyline v1 — Product Spec

**Owner:** Michael Simon · **Formerly:** Units · **Drafted:** Nov 13, 2026 · **Status:** Approved for build

---

## 1. Overview

**What it is:** A daily, curated set of NBA player-prop cards built on Kalshi prediction markets. Each card is one player, one stat, one line, a short "why care" blurb, and live Yes/No prices. Users swipe through the cards and make play-money picks.

**Who it's for:** Michael and close friends. No sign-in, no real money.

**Feel:** Like a prediction market, not a sportsbook or DFS app. Prices are probabilities, the choices are Yes/No, and nothing on the card says "over/under".

**Definition of done (v1):**
1. A user opens the link and lands on today's curated cards.
2. Each card shows the player, a description (stat + line + blurb), and Yes/No selections with real-time prices.
3. A user can make a pick.
4. A user can swipe through all of today's cards.
5. A user can view their picks and see how they resulted.
6. List view and Leaderboard exist as "Coming soon" placeholders.
7. Users have a play-money bankroll: $100 to start, $5 per pick.
8. Users set a display name on first visit.

**Release plan**

| Release | Scope | Goal |
|---|---|---|
| **v1 — core loop** | Curation pipeline, cards (Open / Out / Locked / Settled), $5 picks, settlement, My Picks, $100 starting balance, display name, waiting state, carousel, events logging | See real progress fast; friends picking on real cards |
| **v1.1 — retention** | Daily $10 claim (3am–3pm ET), live stat progress on cards, "price moved" prompt | Reasons to come back daily and during games |
| **v2+** | Login, onboarding, leaderboard, consensus split, share my picks, where to watch, cash out, user-set wager/line, admin dashboard | — |

**Architecture rule:** v1 is built so v1.1 *adds* to it and doesn't change what's there. The data model includes v1.1's fields and states from day one (see §9 groundwork). Sections below tag v1.1 items explicitly.

---

## 2. Data sources

| Source | Used for | Access |
|---|---|---|
| **Kalshi** public REST API (`external-api.kalshi.com/trade-api/v2`) | Prop markets, live prices, results | No API key for market data. Rate-limited (we got a 429 after ~4 quick calls). |
| **ESPN** site API (undocumented) | Schedule and tip-off times, game logs, splits, box scores, injuries, news | No key. Undocumented, so it can change without notice. Accepted risk for v1. |

**Kalshi series in scope:** `KXNBAPTS` (points), `KXNBAREB` (rebounds), `KXNBAAST` (assists), `KXNBA3PT` (threes), `KXNBAPRA` (pts+reb+ast).

**Key facts about the data (checked live on Nov 13):**
- Props are **ladders of binary markets** (e.g., "Wembanyama: 20+ / 25+ / 30+ / 35+ points"), each a separate Yes/No contract.
- Volume: about 2,000 prop markets across 9 games and 121 players on a typical night.
- Kalshi does **not** provide tip-off time. Its `occurrence_datetime` is roughly when the game ends. ESPN is the source for tip-off.
- Kalshi settles player props with `result` = `yes`, `no`, or `scalar` (a DNP or cancellation, settled at a "fair price").

**Player matching (Kalshi ↔ ESPN):**
- Match on normalized player name + team. Strip suffixes (Jr., III) and accents.
- Persist each match in a `player_map` table so matching happens once.
- Requires a team-abbreviation map (ESPN `NY/GS/UTAH/NO` ↔ Kalshi `NYK/GSW/UTA/NOP`, etc.).

**Acceptance criteria**
- [ ] Unmatched players are logged and excluded from curation. They are never silently dropped without a log entry.
- [ ] A failed ESPN response (bad shape or non-200) is logged with an alert, and that day's curation still runs on the Kalshi data alone.

---

## 3. Daily curation and blurb pipeline (fully automated)

Runs once each morning (default **10:00 ET**; Kalshi lists the day's props around 7:30 ET). It must publish before the first tip-off of the day, which matters for weekend afternoon games.

**Steps**
1. **Gather:** today's games from ESPN, and every open prop market for those games from Kalshi.
2. **Pick the line:** for each player + stat, choose the strike where the Yes and No prices are **closest to even** (minimize |yes_ask − no_ask|).
3. **Filter:**
   - Bid/ask spread ≤ 5¢
   - Player matched to ESPN
   - Player not listed Out or Doubtful
   - No starters-only rule: relevant bench players are eligible. Kalshi only lists props for rotation players (about 13 per game), so its own listings act as the "real role" filter.
4. **Enrich:** for each candidate, attach ESPN context: last 5–10 games, home/away split, season series vs. opponent, teammate injuries, recent news.
5. **Shortlist:** take the top ~30 candidates by liquidity and data completeness.
6. **Curate and write (Claude API):** Claude chooses the final **N cards** (default **N = 10**, configurable) and writes a blurb for each, following these rules:
   - At most 1 card per player
   - Spread across games and stat types
   - Favor the strongest storylines
7. **Validate:** check each blurb, and regenerate any that fail (see criteria below).
8. **Publish:** cards go live immediately. There's no review queue in v1. Michael reviews the published cards and gives feedback afterward.

**Blurb rules**
- ≤ 200 characters.
- Must reference at least one concrete fact taken from the supplied context, such as a stat, streak, matchup, or injury. **No invented stats.**
- Written about the player and the stat's storyline, not as betting advice. No "lock", "hammer", "smash".
- Tone: punchy, fan-first, entertaining.

**Acceptance criteria**
- [ ] The pipeline publishes N cards by 11:00 ET on a normal game day without manual steps.
- [ ] Every blurb is ≤ 200 characters and contains at least one number that appears in its source context.
- [ ] No two cards share a player.
- [ ] Each run stores its inputs (candidates + context) and Claude's outputs, so Michael's feedback can be traced to what the model saw.
- [ ] On a day with no NBA games, the pipeline does nothing and the app shows "No games today."

---

## 4. Card and pick experience

**Card contents**
- Player name, team vs. opponent, tip-off time (local)
- Stat + line, e.g. **"30+ points"**
- Blurb
- Two buttons: **Yes 43%** · **No 58%**, priced at the Yes ask and No ask. They don't need to sum to 100%, the same as on an exchange.
- Payout line under each button: **"$5 → $11.63"** (= $5 ÷ ask price)
- Optional: player headshot (ESPN)

**Line vs. price**
- The **line is locked at publish.** Everyone picks on the same strike for the whole day.
- **Prices update live** from our cache (see §8).

**Navigating the deck**
- Swiping moves to the next or previous card, like flipping through a pack. **Swiping never makes a pick.**
- The deck is an **infinite carousel**: swiping past the last card goes back to the first.
- *(Future: an interstitial card between the last and first, for referrals, feedback, etc.)*

**Making a pick**
- Tap Yes or No to place a **$5 pick** at the current ask.
- One pick per card per user. Picks are **final** (no cancel or edit), just like a trade. Cash-out comes later (see §9).
- The server prices each pick from its latest cached ask at the moment of submission, not from what the client displayed. The confirmation always shows the price the user actually got.
- *(v1.1)* If the server price has moved **more than 3 percentage points** from the price shown, the user sees "Price moved to 49% — still in?" before the pick is placed.
- Picks lock at **tip-off**, using ESPN's *current* start time, so a postponed game moves its lock time with it.

**Card states**

| State | When | What the card shows |
|---|---|---|
| **Open** | Published, before tip | Live Yes/No prices + payout lines; pick buttons enabled (or the user's pick, if made) |
| **Out** | Player listed **Out** by ESPN, or Kalshi market paused, before tip | "Ruled out". New picks disabled. Existing picks stay **Locked** and are resulted by Kalshi like any other pick (a DNP comes back `scalar`, so it voids with a refund). If ESPN lifts the Out status before tip, the card reopens. |
| **Locked** | After tip-off (v1) | "Locked" + the user's pick, if any |
| **Live** *(v1.1)* | After tip-off | Replaces Locked: the user's pick + **live stat progress** from ESPN, e.g. "Wemby: 22 pts · needs 30 · Q3 4:12". Shown to everyone, pick or not. |
| **Settled** | Kalshi result in | Final stat + outcome (Won / Lost / Void) for the user's pick |

- *(v1.1)* Live stats come from ESPN game summaries. The worker polls them about every 60 seconds per in-progress game.
- **We never void picks ourselves.** "Out" only blocks new picks. Every result comes from Kalshi, so if a player listed Out ends up playing, his picks settle on what actually happened.

**Before cards are published ("Cards dropping soon")**
- The app's "day" rolls over at **03:00 ET**, the same time as the daily grant. From then until today's cards publish, the card area shows a waiting state instead of an empty screen:
  - Headline: **"Today's cards drop around 11am ET"**
  - Today's slate from ESPN: e.g. "9 games tonight · first tip 7:00 PM"
  - *(v1.1)* The "Collect $10" prompt, if the grant is still claimable, so the visit is worth something even before the cards arrive
- If the pipeline fails or runs late, the same state remains, with the copy changed to "Cards are running late — check back soon." It never shows an error or a blank screen.
- On no-game days: "No games today. Back tomorrow."

**Acceptance criteria**
- [ ] Between 03:00 ET and publish, every visitor sees the waiting state with today's game count and first tip time.
- [ ] Yesterday's cards are no longer shown as "today's" after 03:00 ET. They remain visible in My Picks.
- [ ] If cards haven't published by 12:00 ET, the copy switches to the "running late" version.
- [ ] The card's line never changes after publish.
- [ ] Displayed prices are never more than 60 seconds old. If the cache is staler than 2 minutes, the pick buttons show "Updating…" and are disabled.
- [ ] A pick submitted after tip-off is rejected by the server, even if the client still shows the card as open.
- [ ] A user with a balance under $5 can view all cards, but the pick buttons are disabled. In v1 the message is "Out of funds"; in v1.1 it points to the next daily claim.
- [ ] Swiping right from the last card shows the first card. Swiping left from the first card shows the last.
- [ ] When ESPN lists a carded player as Out, the card switches to "Ruled out" within 5 minutes and rejects new picks. Existing picks are untouched until Kalshi settles.
- [ ] *(v1.1)* During a game, a Live card's stat is never more than 2 minutes behind ESPN.
- [ ] *(v1.1)* If the price moved more than 3 points, the pick isn't placed until the user confirms.

---

## 5. Bankroll (play money)

| Rule | Value |
|---|---|
| Starting balance | **$100** on first visit |
| Pick size | **$5 fixed** (user-chosen amounts in v2/v3) |
| Daily grant *(v1.1)* | **$10**, available from **3:00 ET**, must be claimed by **15:00 ET** (12:00 PT). Unclaimed grants expire. |
| Out of funds | User can browse but can't pick until they have ≥ $5. In v1 that means they're out until v1.1 ships, which is acceptable for a short gap among friends. |

**Payout math (Kalshi-style):** a $5 pick at ask price *p* buys 5/*p* contracts. Each contract pays $1 if it wins.
- Win: credit $5 ÷ *p* (e.g., $5 at 43% → **$11.63**)
- Loss: $0
- Void (DNP or cancellation): refund $5
- Kalshi trading fees are ignored.

**Money is stored as integer cents.** A $5 pick is 500 cents. Payout = round(500 ÷ price) cents, using one rounding rule everywhere. No floating-point math on money.

**Ledger design:** the balance is the **sum of an append-only ledger**. It is never stored as a single number that gets overwritten.

| Entry type | Amount |
|---|---|
| `signup_grant` | +100 |
| `daily_grant` | +10 |
| `pick_stake` | −5 |
| `pick_payout` | +5/p |
| `pick_refund` | +5 |
| `adjustment` | ± (for re-resulting) |

**Why:** corrections and re-resulting become a new reversing entry, so every balance can be explained line by line. This is what the future admin dashboard will rely on.

**Acceptance criteria**
- [ ] A new ID gets exactly one `signup_grant`.
- [ ] *(v1.1)* The daily grant can be claimed only once per ET day, only between 03:00 and 15:00 ET.
- [ ] *(v1.1)* The "Collect $10" prompt is visible and obvious while a grant is claimable.
- [ ] A pick and its `pick_stake` entry are written in a single transaction. A pick never exists without its stake, and vice versa.
- [ ] The balance can never go below $0.

---

## 6. Resulting

- **Kalshi's `result` is the source of truth.** We do not grade results from box scores ourselves.
- A settlement job runs every ~5 minutes from first tip-off until every picked market is finalized. It checks only markets that have picks.
- Yes-markets can **settle mid-game** when the line is reached. The UI should show that win immediately.

**Pick states:** `Open` → `Locked` (tip-off) → `Won` / `Lost` / `Void`

| Kalshi result | Our state | Ledger |
|---|---|---|
| `yes` | Yes picks Won, No picks Lost | payout to winners |
| `no` | No picks Won, Yes picks Lost | payout to winners |
| `scalar` | Void ("Didn't play") | refund $5 |
**Acceptance criteria**
- [ ] Picks are settled within 10 minutes of Kalshi finalizing the market.
- [ ] Settlement is idempotent: running the job twice never pays out twice.
- [ ] A void is excluded from W/L record display.

---

## 7. Identity, My Picks, and placeholders

**Display name:** on first visit, before seeing cards, the user enters a display name: 2–20 characters, unique, editable later. That's the only step; there's no other onboarding (onboarding arrives with login). Names exist now so the v2 leaderboard and social features have someone to show.

**Identity:** on first visit, the app silently creates a **Supabase anonymous user**. The user sees no login; they just enter a display name. Why this instead of a homemade cookie ID:
- The ID is a real user to the database, so database security rules can enforce "you can only see and place your own picks". A homemade ID couldn't do that.
- When login arrives in v2/v3, the anonymous account can be **upgraded in place**: the same user keeps their picks, balance, and name, with no migration.
- Clearing browser data still creates a new user with $100, which is accepted for v1.

**My Picks screen**
- Shows today's picks first, then past picks.
- For each pick: player, line, side, price at pick, state, and payout.
- Shows the current balance and the W–L record.

**Coming soon:** List view and Leaderboard tabs exist and show a "Coming soon" state.

**Acceptance criteria**
- [ ] The user's ID survives a page reload and a browser restart.
- [ ] My Picks reflects a newly placed pick without a manual refresh.

---

## 8. Architecture constraints

- **Only the worker calls Kalshi, ESPN, and Claude.** The web app reads only from Supabase.
- A **price poller** refreshes today's published-card markets every 30–60s and writes to the cache. It respects rate limits with backoff on 429s.
- Times are stored in UTC and the business rules are applied in ET (grant window, "today").
- Every scheduled job (curation, price poller, live-stats poller, settlement, grant expiry) logs its runs and failures.

**Blurb feedback loop:** Michael gives feedback on published cards in conversation with Claude. That feedback is captured in `blurb-style-guide.md` in the repo, which the curation step includes in its prompt every day. Edit the guide and the next day's blurbs change. A feedback UI is a later iteration.

**Analytics (no third-party provider):**
- Use an `events` table in our own database: `user_id`, `event`, `card_id` (nullable), `props` (JSON), `created_at`.
- Events logged in v1, chosen to show how users move through the product:
  - `app_open`
  - `card_view` (with deck position)
  - `card_swipe` (`direction`: next / previous; `from_position`, `to_position`)
  - `pick_placed` (card, side, price)
  - `tab_switch` (`from_tab`, `to_tab`)
- Added in v1.1: `price_moved_prompt` (+ accepted/declined), `grant_claimed`, `grant_expired`.
- Display names are visible to all users (needed for the leaderboard and for following friends later). Picks stay private in v1. Friends seeing each other's picks comes with the follow feature.
- Analysis is plain SQL queries. There are no dashboards in v1.
- **Primary v1 signal is the morning read habit** (opens + how much of the pack gets viewed), not just picks. Units showed many fans read daily without picking. `card_view` carries the deck position so pack completion can be measured.
**Stack (decided Nov 13)**

| Layer | Choice | Why |
|---|---|---|
| Web app | **Next.js (App Router) + React + TypeScript** on Vercel, mobile-first, installable as a PWA | Two requirements: (1) **fast first visit**: the server sends the deck with today's cards already in it, then client components take over for swiping and live prices; (2) **link previews** for future sharing and growth features: server-rendered preview tags plus generated preview images. |
| UI | Tailwind + shadcn/ui; Embla Carousel for the deck | Same UI tools as Moments. Embla has built-in looping and touch swiping for the infinite carousel. |
| Database + auth | **Supabase** (Postgres, anonymous auth, realtime) | One service covers data, identity, and live price push to open cards. |
| Pick placement | A Postgres function (`place_pick`) called via RPC | Checks the lock time, balance, and price, then writes the pick and its −$5 ledger entry in **one transaction**. No separate API server needed. |
| Worker | **Node + TypeScript** on Railway, always on | Runs curation, the price poller, settlement, and grant expiry. It's the only code that calls Kalshi, ESPN, or Claude. |
| Hosting | Vercel (web app), Railway (worker), Supabase (data) | — |

The web app and the worker are one repo with shared TypeScript types (`Card`, `Pick`, `LedgerEntry`).

**Rendering rule:** server components render what the user *sees first*. Client components handle what the user *touches*: the carousel, live prices, and pick buttons. Picks always go through the `place_pick` database function, not Next.js server actions, so the single-transaction guarantee doesn't depend on the framework.

**Performance target (first visit, mid-range phone on 4G):** today's first card is visible in under 1.5s.

*Decision history:* we first chose Vite + React (an app that runs entirely in the browser). We switched to Next.js once link previews and a fast first visit became requirements.

**Mobile:** iOS only, internal use, decided later. Nothing in v1 commits to an approach.

---

## 9. Out of scope for v1

- Login and accounts
- Real money
- User-chosen wager amounts
- List view and Leaderboard (placeholders only)
- Human review queue and admin dashboard. Later, the dashboard will manage cards, blurbs, lines, re-resulting, and bonus funds.
- Polymarket and cross-exchange prices
- NFL and other sports
- Native mobile app (v1 is a mobile-first web app)
- **Share my picks (v2/v3):** one tap to share the day's picks with friends, e.g. a shareable image or link showing the picks, lines, and prices at pick time. This needs some groundwork in v1, listed below.

- **Where to watch (later):** show each game's network on the card and link out to it. ESPN's scoreboard already provides broadcasts tagged national / home / away, e.g. "Prime Video" (national) or "MyMi / Bucks App" (away). Two pieces of work: (1) a small table mapping network names to watch URLs, and (2) logic to show the national feed first and then a local feed relevant to the user. Some games have no broadcast listed, so the card needs a fallback.
- **Cash out (later):** sell a pick back before it settles at the current price, as prediction-market platforms allow.
- **Leaderboard (later):** scoring will combine winnings, streaks, referrals, and other factors. The exact formula is TBD.

- **Consensus split (later):** "62% of Storyline users picked Yes" on each card. This comes from our own pick data, so it needs no new data source.
- **Streaks (later):** a daily-engagement streak (proven at Units: 100+ day streaks). Calculated from `app_open` / `card_view` events and pick history.
- **Community submissions (later):** users suggest storylines or markets they want to see; accepted submissions earn rewards such as pick credits (free trades).
- **Adjustable lines (later):** let users choose a different line or price on the ladder instead of only the most even one.
- **Onboarding (with login):** a short explainer of how prediction markets work.

**Future-feature decisions (Nov 13) that shape the data model**
- **Contests + bonuses:** contests will have separate bankrolls, and Michael can grant bonuses such as a "free $20 trade". The model is **wallets** (every user has a main wallet; contests get their own) plus **pick credits**. A free trade pays **winnings only**: a $20 free trade at 40% that wins pays $30, not $50. A voided free trade comes back as a credit, not as cash.
- **Team and matchup cards** (win streaks, clinching, rivalries): cards are about a player, a team, or a game.
- **NFL is coming:** every team, player, game, and market carries a league.
- **One line per player:** one pick per card per wallet, even once lines are adjustable.
- **Friends will see each other's picks before tip-off/kickoff** once follows exist. This is an access-rule change only.
- **Cards can drop at any time of day** (e.g., injury news), so each card has its own lock time and sort order.
- **Combos/parlays:** much later. They'll be added as new tables, with no rework of existing ones.
- **No real money, ever.**

**v1 groundwork for later features**
- The ledger supports every entry type from day one, including `daily_grant`, even though nothing writes it until v1.1.
- The card-state model includes `live` from day one. v1 just shows it as "Locked".
- Store the full Kalshi ladder for each card's player + stat, not just the chosen line. Adjustable lines will need it.
- Every pick stores its price and timestamp at the moment it's placed. Both Share my picks and leaderboard scoring need this.
- Every pick stores its **contract count** (= $5 ÷ price). A cash-out value is contracts × the current bid, so this has to be recorded at pick time.
- Each card has a stable public ID, so a shared link can point to it later.
- Save each game's `broadcasts` from the ESPN scoreboard on the game record. We already fetch that feed, so this costs nothing.
- On first visit, capture a `?ref=` parameter, if present, as the user's referrer. This costs almost nothing now, and referral credit can't be reconstructed later. Streaks need no groundwork, since they can be calculated from pick history.

---

## 10. Open questions

None for v1.

**Resolved**
- **10 cards/day** to start. Later this becomes variable: as many as clear a quality bar.
- **No minimum-volume filter in v1.** The spread filter (≤ 5¢) is the only liquidity check. Revisit if thin markets start appearing.
- Picks are final (no cancel or edit). Cash-out comes later.
- The daily $10 is claimable every day, including days with no games.
- Leaderboard scoring will be based on winnings, streaks, referrals, and other factors. It's defined later.
