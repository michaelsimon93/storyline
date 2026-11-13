# ADR-008: Stack: Next.js + Supabase + an always-on worker

**Status:** Accepted · **Date:** 2026-11-13

## Context
Requirements: a swipeable, live-updating card deck; background jobs every 30–60s; a fast first visit; rich link previews for future sharing and growth features.

## Options considered
- Next.js on Vercel with Vercel cron (cron isn't built for sub-minute jobs)
- Vite + React SPA + worker (lightest, but blank first paint and no server-rendered previews)
- Next.js + worker
- Expo / React Native web (considered for mobile; deferred since mobile = iOS later)

## Decision
**Next.js (App Router) + Supabase + Node/TypeScript worker on Railway.** Server components render what users *see first*; client components handle what they *touch*. Picks go through a Postgres function, not server actions.

## Consequences
**Decision history:** Vite + React was chosen first, for a fully client-side app. We switched to Next.js when link previews and a fast first visit became explicit requirements. Same React skills either way; Supabase and the worker were unaffected.
- Performance target: first card visible in <1.5s on a mid-range phone over 4G.
