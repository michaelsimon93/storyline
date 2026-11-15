# Storyline design rules

The single source of truth for Storyline's UI. Build sessions and reviewers check PRs against this file. If a screen needs something this file doesn't allow, change this file in the same PR (or open a `needs-decision` issue). Don't add a one-off style.

Visual reference: the "Storyline v1 designs" canvas (private, linked from STO-45). Where the canvas and this file disagree, this file wins.

---

## 1. Structure

- **Three layers.**
  - **Tokens:** one tokens file (path set in STO-42).
  - **Building blocks:** shadcn, restyled, in `web/components/ui`.
  - **Storyline components:** `web/components/storyline`.
- **Screens only put components together.** No colors, sizes or one-off styles in screen files. A missing look means a missing variant on a component.
- **Components take data through props only.** Fetching data happens in screens.
- **Every variant appears on `/dev/components`**, built from sample data.
- **"Why" comments:** a component with non-obvious behavior starts with a short `// Why:` comment that cites its issue or ADR.

## 2. Tokens

**No raw color codes outside the tokens file** (CI enforces this). Use tokens by meaning, never by hue: a "win" is `--win` even where another green would look the same. Dark theme only.

### Color

| Token | Value | Use |
|---|---|---|
| `--bg` | #07080B | App background |
| `--surface` | #10121A | Card body, sheets, lists |
| `--surface-2` | #151821 | Chips, tiles, secondary buttons, disabled pick buttons |
| `--surface-raised` | #2A2F3D | Selected segment or tab |
| `--border` | #262A36 | Outlines |
| `--border-subtle` | #1F2330 | Row dividers, tile borders |
| `--text` | #F4F5F7 | Primary text |
| `--text-2` | #D7DAE1 | Card blurb |
| `--text-3` | #B4B9C4 | Supporting copy |
| `--text-muted` | #9AA0AE | Labels, metadata, payout line |
| `--text-disabled` | #8A90A0 | Text on disabled buttons |
| `--yes` / `--yes-soft` / `--yes-border` / `--yes-text` | #2F7BF6 / #1B2232 / #2F3A52 / #8DB6FF | YES: selected fill, resting fill, outline, YES-colored text |
| `--no` / `--no-soft` / `--no-border` / `--no-text` | #C9541F / #2A1E1C / #4A3530 / #F2A27E | NO, same pattern |
| `--reward` / `--reward-light` / `--reward-ink` / `--reward-soft` | #F5B82E / #FFD873 / #1A1406 / #1F1A0A | The daily claim, the end card, the brand bolt, the split between YES and NO |
| `--win` | #7BD88F | Won |
| `--loss` | #FF8A8A | Lost |
| `--void` | #C9CDD6 | Void, ruled out, result pending |
| `--error` | #FF8A8A | Form errors |

- **Team colors** (card foil, number disc, name band) come from card data, not tokens. They're the only colors allowed outside the tokens file, and only inside `StoryCard` and `PickRow` avatars.
- **Gold (`--reward`) is reserved** for the claim, the end card, the brand bolt and the YES/NO divider. Never use it for a regular CTA.
- **Regular primary buttons use `--yes`** (blue) with white text.

### Type

| Role | Family | Weight | Sizes (px) |
|---|---|---|---|
| Display: headings, numbers, prices, buttons, names | Barlow Condensed | 700–800 | 44, 36, 34, 30, 28, 22, 20, 17 |
| Body: blurbs, metadata, labels, inputs | Inter | 400–700 | 17 (inputs), 15, 14, 13, 12, 11 |

- Display text is uppercase, except numbers and prices.
- Labels (11–12px Inter 600–700) are uppercase with 0.08–0.12em letter spacing.
- Nothing is smaller than 11px.

### Spacing

- A 4px scale: 4, 8, 12, 16, 20, 24, 32, 48.
- Screen padding is 24px horizontally.
- The default gap between stacked elements is 12px. Tight groups (chips, dots) use 8px or 4px.

### Radius

| Token | Value | Use |
|---|---|---|
| `--radius-pill` | 999px | Chips, badges, tab bar, primary buttons |
| `--radius-card` | 22px (16px inner) | Story card, end card |
| `--radius-sheet` | 28px | Modal, bottom sheet (top corners) |
| `--radius-tile` | 16px | Stat tiles, lists, toasts |
| `--radius-control` | 14px | Inputs, pick buttons (outer corners; 6px where YES and NO meet) |

### Shadow

| Token | Value |
|---|---|
| `--shadow-card` | `0 18px 40px rgba(0,0,0,.55)` |
| `--shadow-modal` | `0 24px 60px rgba(0,0,0,.6)` |

### Motion

| Token | Value | Use |
|---|---|---|
| `--motion-fast` | 150ms | Button press, fades |
| `--motion-base` | 200ms | Card swipe, scaling the peeking cards, state changes |
| `--motion-sheet` | 250ms | Modal and sheet open and close |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | All of the above |
| `--toast-duration` | 2600ms | The "+$10 added" toast |

- Under `prefers-reduced-motion`, transitions become opacity only: no slide, scale or shimmer.
- Nothing loops or pulses except the Live dot (v1.1).

## 3. Story card

### Anatomy (top to bottom)

1. **Foil frame:** 7px of team-color gradient, `--radius-card`, `--shadow-card`.
2. **Art area (184px):**
   - Top row: the hook badge (bolt icon plus hook name) on the left; the status badge, or `#n/10` on Open cards, on the right.
   - Center: a disc with the player's number in team colors. A headshot can replace it later.
   - Bottom: the name band, with the player name (uppercase) on the left and `TEAM · POS` on the right.
3. **Line row:** the stat and line ("25+ PTS") on the left; opponent and time ("vs BOS · 7:30 PM") on the right.
4. **Stat row (optional):** in Live (v1.1) and Settled cards, for example "Finished with 31 PTS · needed 25".
5. **Blurb:** `--text-2`, 14px, about 3 lines at most. The style guide limits blurb length; the card never scrolls.
6. **Pick buttons:** YES on the left and NO on the right. Each button's width is proportional to its price, with a 4px `--reward` divider between them. 50px tall.
7. **Footer line:** the payout line, the user's pick, or the status message (§4, §5). One line, centered, 11.5–12px.

**Size:** 300px wide. Previous and next cards peek about 33px from each side, at 0.94 scale and 0.45 opacity. Peeking cards are inert and hidden from screen readers.

### States

`StoryCard` takes one `state` prop. No state exists outside this table.

| State | When | Status badge | Pick buttons | Footer |
|---|---|---|---|---|
| **Loading** | Cards haven't loaded yet | — | — | — |
| **Open** | Published, before tip-off, no pick yet | Tip-off time | Enabled, `*-soft` fills | Payout line |
| **Picked** | Open, and the user has picked | Tip-off time | Chosen side filled and ✓; other side disabled (`--surface-2`, `--text-disabled`) | "✓ YES at 58% · pays $8.62 if it hits" in `--yes-text` or `--no-text` |
| **Price delayed** | Open, and the price is older than `max_price_age_seconds` | Tip-off time | Both disabled, prices shown as "—" | "Updating…", with the last price shown in muted text |
| **Out of funds** | Open, and the balance is under $5 | Tip-off time | Both disabled | Claim available: "Collect $10 to keep playing" (a `--reward` button replaces the pick buttons). Already claimed: "You have $X. Your next $10 unlocks tomorrow." |
| **Ruled out** | ESPN lists the player Out, before tip-off | "Ruled out" | Both disabled; card in grayscale | User picked: "Ruled out · $5 back when the game settles". No pick: "Ruled out". |
| **Paused** | The market isn't trading (not an ESPN Out), before tip-off | "Paused" | Both disabled | "Picks paused until trading resumes" |
| **Locked** | After tip-off, or once ESPN reports the game in progress | "Locked" | Both disabled; the user's pick keeps its ✓ fill | User picked: "Your YES at 58% · now 71%". No pick: "Picks closed at tip-off". |
| **Final, result pending** | ESPN says the game is final, and the market has no result yet | "Final" | As in Locked | "Result pending" |
| **Won** | Settled, and the pick won | "Final" | As in Locked, without prices | "WON · $8.62 paid" in `--win`, 16px |
| **Lost** | Settled, and the pick lost | "Final" | As in Locked, without prices | "LOST · $5.00" in `--loss`, 16px |
| **Void** | Settled void (Kalshi `scalar`) | "Void", or "Ruled out" if ESPN listed him Out before tip-off | Disabled; card in grayscale | "Didn't play · $5.00 refunded" or "Ruled out · refunded" |
| **Final, no pick** | Settled, and the user didn't pick | "Final" | Disabled, without prices | "Final · YES hit" or "Final · NO hit", in `--void` |
| **Live** *(v1.1)* | Game in progress | "● Live · Q3" | As in Locked | As in Locked, plus the stat row "18 PTS so far · needs 7 more" |

- **Loading:** a card-shaped skeleton (same frame and size) in `--surface` and `--surface-2` blocks. No spinner. Static under reduced motion.
- **Grayscale** applies only to Ruled out and Void.
- **Status beats balance:** a card that is Locked, Final or Out shows that state even if the balance is under $5.

### Around the card

- **End card:** an 11th slot between #10 and #1. The carousel still loops, so swiping past the end card goes to #1. It has a `--reward` foil and two variants:
  - **Some unseen:** "N storylines left," with shortcuts to up to 3 unseen cards, then "+N more".
  - **All seen:** "All caught up," with stat tiles for picks today and "If all hit", plus a "Track my picks" button.
  - "Seen" means the card was the active card on this device on this storyline day.
- **Page dots (11):**
  - Active card: 18px wide, `--text`.
  - Picked: `--yes`.
  - Seen: `--text-muted`.
  - Unseen: `--border`.
  - End card: square; `--reward` once all 10 are seen, otherwise dim gold.
- **Empty states** replace the carousel. They never show an error or a blank screen:

| Situation | Headline | Supporting line | Also shows |
|---|---|---|---|
| Waiting for today's storylines | "Today's storylines drop around 11 AM ET" | Today's slate, e.g. "9 games tonight · first game 7:00 PM" | Claim box, if the claim is available |
| Running late (not published by 12:00 ET, or the pipeline failed) | "Today's storylines are running late" | "Check back soon. They'll show up here on their own." | Claim box; link to open picks |
| No games today | "No games today" | "Back tomorrow." | Claim box |

## 4. Price and payout display

- **Prices are whole percentages:** "58%". Never "¢", "58c", decimals or odds formats ("+150", "1.72").
- **Each button shows its own side's ask price.** YES and NO don't have to add up to 100%.
- **Button label format:** `YES 58%` and `NO 42%`, in Barlow Condensed 20px/800. The side name is uppercase; the price is weight 600 at 85% opacity.
- **Payout = `round(500 × 100 ÷ price_cents)` cents.** One rounding rule, used everywhere. Only use the shared helper; never recompute it in a component.
- **Payout line, before a pick:** "$5 pick · YES pays $8.62 · NO pays $11.90".
- **Money display:**
  - Payouts, refunds and stakes always use two decimals ("$5.00", "$8.62").
  - Balances use no decimals when whole ("$100") and two decimals otherwise ("$3.20").
  - No minus or plus signs. Direction is shown by the word (Won, Lost, Refunded) and its color.
- **The confirmed price is the server's.** After a pick, show the price `place_pick` returned, not the one that was on screen.
- **Live price refresh:** update the number in place, with no animation, flash or announcement on each tick.

## 5. Copy rules

- **Say "storylines" or "stories," never "deck" or "pack."**
  - Header: "Today's Storylines".
  - Tabs: Stories · Picks · Leaders.
  - CTAs: "Open today's stories".
- **Keep the app sport-agnostic outside cards.** Say "game," "when the game starts" and "first game," not "tip-off," "NBA" or "court." Sport terms are fine inside a card (line, stat, blurb, status).
- **Use prediction-market words, not betting words.** Say "pick," "YES/NO," "pays," "price." Never "bet," "wager," "odds," "over/under," "parlay," "cash."
- **Don't push the money framing:** no "play money" disclaimers, and no starting-balance pitch in onboarding.
- **Welcome screen:**
  - Headline: "The best stories in sports, one pick at a time".
  - Three steps: read why it matters, pick YES or NO, picks lock when the game starts.
  - CTA: "Play now".
- **Errors are plain and specific,** for example "Use at least 4 characters." Never "Something went wrong" when the cause is known.
- **Fixed strings:**
  - Claim: "Your daily $10", "Collect $10", "Not now", "$10 added".
  - My Picks empty state: "No picks yet".
  - Coming soon: "[Feature] coming soon".
- **Display name:**
  - 4–20 characters: letters, numbers and underscores.
  - Unique without regard to case. Reserved: admin, storyline, mod, support.
  - Pre-filled with a suggestion, with a shuffle button.
  - Each failure has its own message: too short, too long, invalid characters, taken, not available.

## 6. Screens and flows (v1)

- **First open:** the welcome and name screen comes before any cards (STO-35).
- **Header:** the screen title on the left. On the right, a name and balance chip that opens the edit-name sheet.
- **Daily claim:**
  - On the first visit of the storyline day while the claim is available, a modal opens over the Stories screen. It shows a gold $10 coin, "Your daily $10", one line of copy, "Collect $10" and "Not now".
  - It shows at most once per day.
  - After "Not now", a gold "Collect $10" pill replaces the "N of 10 picked" text until the claim is collected or expires.
  - Collecting updates the balance in place and shows the toast.
- **My Picks:**
  - Stat tiles (Record, Net total, Open), then **Tonight**, then **Settled**.
  - Each row: team-color avatar, player, "LINE · SIDE at N%" (or a status sub-line), status, and detail.
  - Row statuses match §3: live, upcoming ("pays $X"), result pending, Won, Lost, "Ruled out" (sub-line "$5 back when the game settles"; after the void, "Refunded"), "Didn't play · Refunded".
- **List and Leaders tabs:** "Coming soon" screens only.

## 7. Accessibility minimums

- **Contrast:**
  - Body text ≥ 4.5:1.
  - White on filled `--yes` or `--no` is about 4:1, so it's allowed only for large text: ≥ 18.66px bold or ≥ 24px regular.
  - Never put small text on those fills.
- **Never use color alone.** Every result, state or side also has a word or symbol (Won/Lost, ✓, YES/NO, the badge).
- **Touch targets ≥ 44 × 44px**, including icon buttons, dots that act as controls, and the sheet's close button.
- **Use real elements:** `<button>`, `<a href>`, `<input>` with a `<label>`. No click handlers on `div` or `span`.
- **Pick buttons use `aria-pressed`.** Disabled buttons are actually `disabled`, not just styled that way.
- **Focus:** a visible focus ring on every interactive element. The modal and the sheet trap focus, close on Escape, and return focus to whatever opened them.
- **Announcements:**
  - Toasts, pick confirmations and form errors use a polite live region.
  - Price ticks are never announced.
- **Peeking cards** are `inert` and `aria-hidden`. Only the active card can be reached by Tab.
- **Icon-only buttons** have an `aria-label`. Decorative SVGs are `aria-hidden`.
- **Motion:** `prefers-reduced-motion` is respected (§2 Motion).

## 8. Decided / still open

**Decided** (enforced in the rules above)
- shadcn components restyled with our tokens. `/dev/components` is the catalog. Storybook comes in v1.1 (STO-42, 43, 44).
- One `StoryCard` with a `state` prop. Picks are final, one per card, $5.
- End card in the loop. "Done" means seen all 10, not picked all 10 (STO-16, 20).
- "Ruled out" never refunds until the market voids (STO-14, ADR-004).
- Price delay: picks pause past `max_price_age_seconds`, enforced in `place_pick` (STO-41).
- The daily claim is in v1, as a once-a-day modal with a pill as the fallback (STO-22).

**Still open**
- **Claim day boundary:** STO-22 says the claim runs midnight to midnight ET, but the storyline day (`storyline_day()`, spec §4) rolls over at 03:00 ET. Pick one boundary for both. Until then, UI copy says "today" or "tomorrow," never a clock time.
- **"Paused" state:** spec §4 shows a paused market as "Ruled out." This file splits it into its own "Paused" state. Confirm.
- **`docs/spec.md` §4–5 needs to catch up with this file:** the payout line format, "cards" → "storylines" in the waiting copy, the end card instead of last → first, display names of 2–20 → 4–20, and the claim moving from v1.1 to v1.
