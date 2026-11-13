# Why Storyline

> **The right markets, for the right fan, at the right time.**
> Sports prediction markets list thousands of markets every night. Storyline does two things the exchanges don't: it **curates** the few that matter today, and it tells you **why you should care**.

## The problem
Sports prediction markets now list far more than anyone can sift through: game winners, spreads, totals, quarter and half lines, team stats, player props, futures, awards, specials. On a 9-game NBA night in November 2026, Kalshi had **~2,000 player-prop markets alone** (121 players), on top of everything else across more than 4,000 sports market series. Each market has a price, and none of them says why it's interesting.

The exchanges are built for traders: grids, ladders, order books. They answer *"what are the odds?"* Casual fans first need someone to cut thousands of markets down to the handful worth their attention, and then to answer *"why does this matter tonight?"* Is it a revenge game, a hot streak, a milestone in reach, a backup starting because the star is out? Without that, a market is just a number.

## Where this comes from
I've spent 10+ years building at the frontier of how fans consume and engage with live sports, bringing them into the biggest moments as they happen. I've led two award-winning products: **BetVision** (2025 AGA Online Betting Product of the Year) and **Buzzer** (2023 Hashtag Sports Best App or Mobile Experience).

Across all of it, I've been working on the same problem: **delivering the right moment to the right fan at the right time.** That includes **Units**, a DFS-era startup where I was on the five-person founding team. Units curated the day's most relevant props for casual players, each with a short TL;DR on why it mattered.

Storyline applies that same idea to prediction markets: **the right markets, for the right fan, at the right time.**

**What Units taught us:**
- **The format works, even without a pick.** Fans opened every morning to flip through the pack and read what was going on. If they made picks, great. If not, the curated storylines alone gave them a reason to check in every day.
- **Gamification creates commitment.** Streaks ran past **100 days**, and people didn't want to lose them. When we ran contests, users were eager to compete against each other.
- **Fans want to shape it.** We let users submit the storylines and markets they wanted to see, and we rewarded them for it. We were building a community, not just a product.

Prediction markets now offer far more inventory than the DFS era ever did, and AI can do the daily editorial work. The format deserves another shot.

## Why now
- **Prediction markets went deep on sports.** Player props, team markets, game lines, futures: the inventory now exists on regulated exchanges, with live public prices and results. The problem has shifted from *not enough* markets to *far too many*.
- **AI can curate and write the "why" every day.** The editorial work that once needed a person (choosing what matters out of thousands of markets, then turning stats, injuries and matchups into one sentence a fan cares about) can now be generated, checked against source data, and published each morning or the moment news breaks.

## Who it's for
**Casual fans** who watch games, follow storylines, and would put a few dollars behind a take. Not sharps, volume traders, or people looking for an edge.

## The bet
> **Curation plus the "why" beats volume.** Pick the ~10 markets that matter today, explain each in one sentence, and casual fans will come back every morning to flip through the pack, **whether or not they make a pick**. More markets don't make fans care more. Better choices and better reasons do.

## How the product builds: four layers
| Layer | Question it answers | What it looks like | When |
|---|---|---|---|
| **1. The right markets** | *What matters today, and why should I care?* | **Curation:** thousands of markets (player, team and game) narrowed to a daily deck of ~10. **The why:** each card pairs one storyline with one market. News-driven drops when the story changes (e.g., an injury opens a door for a backup). | **v1** |
| **2. The right fan** | *Why should **I** care?* | Personalization: follow friends and see their picks, favorite teams and players, cards weighted toward what you follow, where to watch | v2+ |
| **3. Entertainment & gamification** | *Why come back tomorrow?* | Play-money bankroll, live stat progress during games, daily claim, **streaks**, leaderboard, **contests**, free trades, share-my-picks. Proven at Units: 100+ day streaks, eager contest play. | v1 → v2+ |
| **4. Community** | *Why is this mine?* | Fans submit storylines and markets they want to see, and are rewarded for it (e.g., free trades). | v2+ |

Layer 1 is what v1 tests. If the curation and the "why" don't land, personalization and gamification won't fix it. If it does, those layers amplify it.

## Product principles
1. **Curation is the product.** What we leave out matters as much as what we show. Every card has to earn its place.
2. **The why comes first.** The storyline is the reason to care. The market is how you act on it.
3. **A prediction market, not a sportsbook.** Yes/No, prices as percentages, no "over/under," no "lock of the day."
4. **Fewer, better.** A deck you can finish, not a feed you scroll forever.
5. **Timely beats comprehensive.** A card about tonight's injury news beats ten generic cards.
6. **The market is the source of truth.** Prices and results come from Kalshi; we never grade our own picks.
7. **Play money, social stakes.** Never real money. Friends, streaks and bragging rights are what make it matter.
8. **A community, not just a product.** Fans should help shape what's in the pack, and be rewarded for it.

## What I'll watch (v1)
Lightweight signals, not formal KPIs:
- **The morning habit:** do friends open it on most game days **without being reminded**, and flip through the whole pack? (Reading counts. Picks are a bonus, not the measure of success.)
- **Pick rate:** of the cards they see, how many do they pick?
- **Is the curation choosing well?** Do cards get picked across the deck, or do friends skip the same kinds every day?
- **Which "whys" work?** Card-level pick rates by storyline type (streak, revenge, milestone, injury opportunity) show what the AI should favor, and that feeds back into the blurb style guide.

## Non-goals
- Real-money wagering, ever
- Power-user tools (ladders, order books, every market)
- Covering every game or player

## Biggest risks
| Risk | How we'll know | First response |
|---|---|---|
| The AI curates poorly or its "whys" aren't compelling | Low or uneven pick rates; friends stop opening | Tighten the style guide; tag storyline types and favor the winners |
| Even-odds lines feel flat (every card ~2x) | Pick rate flat across cards | Add one long-shot card per day |
| ESPN's undocumented API changes | Ingest validation fails | Alerts; swap in a stats provider |

## What I'm practicing
I'm an **engineer turned founding PM**. I take products from 0-to-1 and scale them into global platforms, whether moving fast at a lean startup or working within the structure of a public company. In those roles I led product and was deeply involved in engineering design and technical decisions, but the hands-on building belonged to engineering teams. I've also done design and prototyping work myself.

Storyline closes that gap. **I'm building a complete product end to end, hands-on, with no engineering team.** The product judgment is what I bring. The engineering is what I'm practicing:
- **Back-end and data:** pipelines that ingest third-party data under rate limits, a transactional money ledger, row-level security
- **AI in production:** a pipeline that goes from spec to published content, with validation, traceability, and a feedback loop
- **Shipping:** a deployed web app, background workers, CI, and the operational work of keeping it running
