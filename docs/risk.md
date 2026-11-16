# Risk and operations

**Owner:** Michael Simon · **Drafted:** Nov 16, 2026 · **Decision:** [ADR-023](decisions/023-run-the-book-as-real-money.md)

Storyline uses play money, but we run it as if the money were real. This doc covers what the house measures, which controls it has, and what gets built when. The product spec (`spec.md`) covers what users see. This covers what it takes to operate the product.

---

## 1. Storyline is the house

Kalshi is an exchange: it matches buyers with sellers and never takes a side. **Storyline does take a side.** When a user picks Yes at 43%, Storyline sells them that position at Kalshi's price and holds the other side. We're a book that copies its prices from an exchange.

Two consequences shape everything below:

1. **We could hedge.** A real operator with too much exposure on one side would buy that side on Kalshi to offset it. We'll never place that trade, but we calculate it (§3).
2. **Stale prices are the biggest risk.** If Kalshi moves on injury news before our cache catches up, informed users pick at the old price. Our guard is that `place_pick` prices from the server cache and rejects picks if it's older than `max_price_age_seconds` (120s). The window between Kalshi moving and our cache catching up is the risk we watch (§3, expected result).

Promotions are a cost: the $100 signup grant, the $10 daily claim and free trades are marketing spend, not part of the book. We report them separately from betting results (§4).

## 2. The math

Every pick stores `side`, `price_cents`, `stake_cents`, `contracts` and `credit_id` at the moment it's placed, and these never change. That's all the exposure math needs.

**Payout if won**: one rule, in one SQL function, shared by settlement and the risk views (STO-62):
- Cash pick: `round(stake × 100 / price)` cents. $5 at 43% → 1163.
- Free-credit pick: payout minus stake (winnings only, ADR-011). No cash was taken in.

**Per market** (open picks only):

| Measure | Definition |
|---|---|
| Stakes in | Cash stakes on both sides (credit picks add nothing) |
| Liability if Yes / if No | Sum of payout-if-won for that side's picks |
| Result if Yes / if No | Stakes in − liability for that side |
| **Worst case** | The lower of the two results. A void returns every stake, so it nets to $0 and is never the worst case. |
| **Expected result** | Stakes in − (p × liability Yes + (1 − p) × liability No), with p = the current Yes midpoint (average of bid and ask) |
| Hedge needed | (liability Yes − liability No) ÷ 100 contracts on the heavier side, and their cost at the current ask |
| Split | % of picks and % of stake on each side |

**Worked example.** "Wemby 30+ points." 30 users pick Yes at 43%, 10 pick No at 58%.
- Stakes in: 40 × $5 = **$200**
- Liability: Yes 30 × $11.63 = **$348.90** · No 10 × $8.62 = **$86.20**
- Result: if Yes −$148.90 · if No +$113.80 → **worst case −$148.90**
- Kalshi's Yes price drifts to 45%. Expected: 200 − (0.45 × 348.90 + 0.55 × 86.20) = **−$4.42**. At 43% it was close to $0. The 2-point move is value the Yes pickers took from the house.
- Hedge: buy 263 Yes contracts at 46¢ ≈ $121. Both outcomes then land near −$7: the book is flat.

**Why expected result matters:** we price at the market with no margin, so a market's expected result starts near $0. Over time, a consistently negative total means users are beating our prices. That would point to the stale-price window, or to a few sharp users (§6).

## 3. What we measure

Built in STO-59 (market, game, day) and STO-63 (money supply, reconciliation).

All of this is SQL views over `picks`, `ledger_entries`, `markets` and `market_price_snapshots`. Only the service role can read them (ADR-016). There's no UI in v1. Michael reads them in the Supabase SQL editor and in Discord (§5).

| View | One row per | Answers |
|---|---|---|
| Market exposure | Market with open picks | Picks and stake per side, split, liability per outcome, worst case, expected result, hedge needed, current price vs. average pick price |
| Game exposure | Game | The same, summed over the game's markets. One player's night moves several markets together, so the game is where risk concentrates. |
| Day book | Storyline day | Open: total stakes, worst case, expected. Settled: house result (stakes kept − payouts − refunds). Settlement lag. |
| Money supply | Storyline day | Created (grants, payouts, refunds), taken back (stakes), total user balances, promo spend |
| Reconciliation | Problem found | **Should return no rows.** Any row is a bug: a pick without its stake, a settled pick without its payout or refund, a payout that doesn't match the pick, a negative balance, or a picked market settled at Kalshi but still open with us longer than `settlement_max_lag_minutes`. |

The worst case for a game or a day is the **sum of each market's worst case**. That's conservative: it assumes every market goes against us at once. A true worst case for a whole game would need a model of how one player's stats move together, which is out of scope.

## 4. Money supply

Real books worry about running out of money. A play-money product has the opposite problem: inflation. Every grant and every winning pick creates money. If balances only go up, a future leaderboard stops meaning anything.

So we track created vs. taken back each day, and promo spend (grants) separately from the book's own result. There's no target yet. The point is to see the trend before leaderboards and contests depend on it.

## 5. Discord: the risk report (STO-66)

Until there's an admin page, Discord is where operations happen.

- **Book closed report**: posted when the day's first game locks. Total stakes, worst case, expected result, the 3 biggest market exposures, and the most lopsided split.
- **Settled report**: posted once every market of the day has settled. House result, promo spend, money created vs. taken back, reconciliation status (✅ or the number of problems).
- **Threshold alerts**, sent as they happen while picks are open:
  - a market's worst case falls below `risk_alert_worst_case_cents`
  - one side holds at least `risk_alert_split_pct` of a market's picks, once it has `risk_alert_min_picks` picks
  - reconciliation returns any row (always critical)

Thresholds are `app_config` rows (ADR-018). Alerts follow STO-36's dedupe once that ships: one alert per market per condition per day.

## 6. Controls

| Control | Status |
|---|---|
| Price the pick on the server, not the client | ✅ built (`place_pick`) |
| Reject picks on a stale price (`max_price_age_seconds`) | ✅ built |
| User's max price (`p_max_price_cents`); v1.1 "price moved" confirmation | ✅ built / v1.1 (STO-24) |
| Fixed $5 stake, one pick per card per wallet | ✅ built. This caps how much any one user can risk on one market. |
| Picks lock at tip-off, or when the game starts or ends | ✅ built |
| Only Kalshi's result voids a pick | ✅ by design (ADR-004). No admin voids. |
| Every config change audited | ✅ built (`config_audit`) |
| **Suspend a card** (manual kill switch) | v1 (STO-64) |
| Maximum liability per market or day | Open question (STO-60): decide once the views show real numbers |
| Limit or flag sharp users | v2+ (STO-65) |

**Suspend a card.** AI curation publishes automatically. If a card turns out to be wrong (bad line, wrong player, a bad blurb) or a market has too much exposure, Michael needs to stop new picks on it right away. `suspend_card(card_id, reason)` and `resume_card(card_id)`, run from the SQL editor, put the card in the **Paused** state from `design.md` §3. Existing picks are untouched and settle normally. Every suspend and resume is logged with who, when and why. This is separate from `is_out`, which the worker rewrites on every poll and would overwrite a manual suspend.

## 7. Later

- **Admin dashboard (STO-29):** a page over these same views, plus suspend/resume buttons. No new math.
- **Sharp users (STO-65):** closing line value: the price a user got vs. the last price before lock, from `market_price_snapshots` (ADR-017). Users who consistently beat the closing price are who a real book limits. For us, it's a "best pickers" stat.
- **Exposure caps (STO-60):** if adopted, `place_pick` checks the market's worst case before accepting a pick. Users would see that side as full.

---

## Acceptance criteria

Each issue carries its own criteria. These are the ones that define "the house is operable":

- [ ] Any market's worst case, expected result and hedge needed can be read with one query, and the numbers match the worked example in §2 in a scenario test.
- [ ] The payout used for liability is computed by the same function settlement uses. Changing the rule in one place changes both.
- [ ] The reconciliation view returns no rows on a correct ledger, and returns a row for each kind of broken book in §3, with a test for each.
- [ ] No risk view or admin function is readable or callable with the anon or user key ("can't do it" tests, ADR-016).
- [ ] The book closed and settled reports post to Discord daily without manual steps.
- [ ] A suspended card rejects new picks immediately and shows Paused. Resuming reopens it if it would otherwise be open.
