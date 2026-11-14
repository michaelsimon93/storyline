// Storyline's own market vocabulary (ADR-021). Provider adapters map into these; nothing else
// in the worker or the database knows a provider's words. Mirrors the market_status enum in SQL.

export const MARKET_STATUSES = ["open", "paused", "closed", "settled"] as const;
export type MarketStatus = (typeof MARKET_STATUSES)[number];
