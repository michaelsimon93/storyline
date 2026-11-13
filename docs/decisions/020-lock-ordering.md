# ADR-020: Lock ordering for picks and settlement

**Status:** Accepted · **Date:** 2026-11-13

## Context
`place_pick` and settlement both touch markets and wallets:
- **A pick** must not interleave with a market being resolved (otherwise settlement can miss an in-flight pick), and two picks from one wallet must not both pass the balance check.
- **Settlement** writes a market's result, then inserts ledger entries, which reference `wallets` and take a key-share lock on the wallet row.

The first version of PR A locked **wallet, then market**. The independent reviewer reproduced a deadlock: settlement held a market and needed a wallet, while a pick held that wallet and needed the market.

## Options considered
- Retry on deadlock (hides the problem; one side still fails)
- Advisory locks per user (another mechanism to reason about)
- A single global lock order, plus the weakest wallet lock that still prevents double spending

## Decision
1. **Lock order is always market, then wallet.** `place_pick` share-locks the card's market (`FOR SHARE`) *before* reading card state, then locks the wallet.
2. **The wallet lock is `FOR NO KEY UPDATE`**, not `FOR UPDATE`. It still serializes two picks from the same wallet, but it doesn't conflict with the key-share locks that ledger inserts take, so settlement never waits on a pick's wallet lock.

Either measure alone prevents this deadlock; both together are defense in depth. Any future code that locks markets and wallets (settlement job, cash-out, admin re-resulting) must follow the same order.

## Consequences
- A result write waits for any in-flight pick on that market (milliseconds); a pick that arrives while a result is being written waits, then sees the card as settled.
- Tests: `settlement.integration.test.ts` reproduces the deadlock scenario (it fails only with *both* measures removed, since either one prevents it); `concurrency.integration.test.ts` fails if the wallet lock is removed.
