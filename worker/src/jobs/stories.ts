// The story step (STO-76, ADR-024 steps 2-3): find the day's stories from ESPN, drop the ones about players who won't play
// tonight, match each to an open in-band market, and store the shortlist for the Claude ranker (STO-11) to read.
//
//  - Settings are loaded inside the run, not at worker startup (STO-106). A missing one is caught here: it fails this job's
//    run (the pipeline_runs row says failed), posts an alert naming each key, and returns normally so the scheduler doesn't
//    alert twice. Every other job is untouched (STO-107).
//  - ESPN down (the inputs throw) or a database error is a real failure: it propagates and the scheduler alerts.
//  - Re-running a day replaces that day's shortlist in one transaction: same stories in, same list out, no duplicates.

import { withRun, type Db } from "../lib/db.js";
import { loadConfig, loadStoryConfig, ConfigError, type StoryConfig } from "../lib/config.js";
import { alertText } from "../lib/alertText.js";
import type { Alert } from "../lib/alert.js";
import type { FetchOptions } from "../lib/http.js";
import { collectStoryInputs, tonightStatus, type StoryInputs } from "../sources/espnStories.js";
import { loadSlate } from "../sources/slate.js";
import type { Slate } from "../sources/types.js";
import { LEAGUE, resolveSlateDate } from "./ingest.js";
import { ANGLES, hotStreak, backFromInjury, backupStepsIn, type OutTeammate, type SignalRef, type StatKey, type StoryCandidate } from "../domain/storyDetectors.js";
import { dropNotPlaying, pickMarket, buildShortlist, type MarketRow, type Matched, type ShortlistPick } from "../domain/storyShortlist.js";
import type { InjuryStatus } from "../domain/injuryStatus.js";
import type { SlotKind } from "../domain/shortlist.js";

export const JOB = "story";
const SOURCE = "espn";

export interface StoryRunOptions {
  alert: Alert;
  /** A specific slate day (YYYY-MM-DD). Default: today's, from the database. */
  date?: string;
  fetchOpts?: FetchOptions;
}

/** What a run reports: the counts that show where stories went, and the shortlist with each story's angle next to its score. */
export interface StorySummary {
  slateDate: string;
  runId: number;
  /** Stories the detectors found, before any filter. */
  found: number;
  foundByAngle: Record<string, number>;
  /** Dropped because the player won't play tonight (STO-102). */
  notPlaying: number;
  /** Dropped because a signal it rests on isn't stored (the context pull hasn't run, or skipped him): we can't cite it. */
  noSignals: number;
  noMarket: number;
  noMarketSamples: string[];
  matched: number;
  shortlisted: number;
  /** For each angle: stories that matched a market, and how many of the shortlist came in by quota or by fill. */
  byAngle: Record<string, { matched: number; quota: number; fill: number }>;
  shortlist: { position: number; angle: string; stat: StatKey; score: number; player: string; slotKind: SlotKind; summary: string }[];
  inputs: { calls: number; failedCalls: number; skippedRows: number; playersWithoutInputs: number; unknownStatuses: string[] };
}

export type StoryRunResult =
  | { status: "ok"; summary: StorySummary }
  | { status: "config_error"; slateDate: string; runId: number | undefined; problems: string[] };

type StoredRef = { id: number; date: string };
const refKey = (r: SignalRef) => `${r.subject.kind}:${r.subject.id}|${r.key}`;

export async function runStories(db: Db, opts: StoryRunOptions): Promise<StoryRunResult> {
  const slateDate = await resolveSlateDate(db, opts.date);
  const config = await loadConfig(db);   // the startup settings every job reads: price band, spread, ESPN pacing
  try {
    const summary = await withRun(db, JOB, slateDate, async (runId) => {
      const cfg = await loadStoryConfig(db);   // inside the run on purpose (STO-107)
      const slate = await loadSlate(db, slateDate, LEAGUE, SOURCE);
      const inputs = await collectStoryInputs(slate, {
        pauseMs: config.espnPauseMs, maxConsecutiveFailures: config.espnMaxConsecutiveFailures, fetchOpts: opts.fetchOpts,
      });
      const stored = await loadStoredSignals(db, slate, slateDate, config.espnFallbackMaxAgeDays);
      const markets = await loadOpenMarkets(db, slateDate);
      const result = buildSummary({ runId, slate, slateDate, inputs, cfg, stored, markets, rules: { bandMin: config.priceBandMin, bandMax: config.priceBandMax, maxSpreadCents: config.maxSpreadCents } });
      await replaceShortlist(db, runId, slateDate, result.picks);
      return result.summary;
    });
    if (summary.inputs.failedCalls > 0 || summary.inputs.skippedRows > 0 || summary.inputs.unknownStatuses.length > 0) {
      await opts.alert(alertText({
        severity: "warning", job: JOB,
        headline: `${JOB}: ESPN inputs degraded (${summary.inputs.failedCalls} failed calls, ${summary.inputs.skippedRows} bad rows, ${summary.inputs.unknownStatuses.length} unrecognised injury statuses)`,
        note: `the shortlist was built from what loaded; ${summary.inputs.playersWithoutInputs} players had no game log or schedule, so no story about them. ` +
          (summary.inputs.unknownStatuses.length ? `Unrecognised statuses (treated as won't-play): ${summary.inputs.unknownStatuses.slice(0, 6).join(", ")}` : ""),
      }));
    }
    return { status: "ok", summary };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    const runId = (err as { pipelineRunId?: number }).pipelineRunId;
    await opts.alert(alertText({
      severity: "failed", job: JOB,
      headline: `${JOB} can't run: ${err.problems.length} story setting(s) missing or wrong in app_config`,
      error: err,
      note: `${err.problems.join("; ")}. Only the story step is stopped; every other job keeps running. Add the missing rows (a migration), then re-run: npm run job -- story`,
    }));
    return { status: "config_error", slateDate, runId, problems: err.problems };
  }
}

// ---------------------------------------------------------------- the pure core: inputs in, summary and picks out

interface Built { summary: StorySummary; picks: ShortlistPick[] }

export function buildSummary(a: {
  runId: number; slate: Slate; slateDate: string; inputs: StoryInputs; cfg: StoryConfig;
  stored: Map<string, StoredRef>; markets: MarketRow[];
  rules: { bandMin: number; bandMax: number; maxSpreadCents: number };
}): Built {
  const { slate, inputs, cfg, stored } = a;
  const today = (r: SignalRef) => { const s = stored.get(refKey(r)); return s && s.date === a.slateDate ? s : undefined; };

  // 1. Find stories.
  const candidates: StoryCandidate[] = [];
  let withoutInputs = 0;
  for (const p of slate.players) {
    const log = p.externalId ? inputs.logs.get(p.externalId) : undefined;
    const teamGames = inputs.teamGames.get(p.teamId);
    if (!p.externalId || !log || !teamGames) { if (!inputs.feedOk || !isOut(tonightStatus(p, inputs))) withoutInputs++; continue; }
    const tonight = tonightStatus(p, inputs);
    const hurtRef: SignalRef = { subject: { kind: "team", id: p.teamId }, key: `injury:${p.externalId}` };
    const listedHurt = stored.has(refKey(hurtRef)) ? [hurtRef] : [];
    candidates.push(
      ...hotStreak({ playerId: p.id, log, teamGames }, cfg),
      ...backFromInjury({ playerId: p.id, teamId: p.teamId, log, teamGames, tonight, injuryEvidence: listedHurt }, cfg),
      ...backupStepsIn({ playerId: p.id, teamId: p.teamId, log, teamGames, tonight }, teammatesOut(p.teamId, inputs, today), cfg),
    );
  }
  const foundByAngle = count(candidates.map((c) => c.angle));

  // 2. STO-102: nobody who won't play tonight, whatever the angle.
  const tonightByPlayer = new Map<string, InjuryStatus | null>(slate.players.map((p) => [p.id, tonightStatus(p, inputs)]));
  const { kept, dropped } = dropNotPlaying(candidates, tonightByPlayer);

  // 3. Every signal a story rests on must be stored, so a blurb can cite it.
  const withSignals: (StoryCandidate & { signalIds: number[] })[] = [];
  let noSignals = 0;
  for (const s of kept) {
    const ids = s.basis.map((r) => (r.key.startsWith("form:") ? today(r) : stored.get(refKey(r)))?.id);
    if (ids.some((id) => id === undefined)) { noSignals++; continue; }
    withSignals.push({ ...s, signalIds: [...new Set(ids as number[])].sort((x, y) => x - y) });
  }

  // 4. Match each to a market on its player and stat.
  const byPlayer = new Map<string, MarketRow[]>();
  for (const m of a.markets) byPlayer.set(m.playerId, [...(byPlayer.get(m.playerId) ?? []), m]);
  const team = new Map(slate.players.map((p) => [p.id, p.teamId]));
  const name = new Map(slate.players.map((p) => [p.id, p.name]));
  const matched: Matched[] = [], noMarket: string[] = [];
  for (const s of withSignals) {
    const m = pickMarket(s, byPlayer.get(s.playerId) ?? [], a.rules);
    if (!m) { noMarket.push(`${name.get(s.playerId)} ${s.stat.toUpperCase()} (${s.angle})`); continue; }
    matched.push({ ...s, teamId: team.get(s.playerId)!, gameId: m.gameId, marketId: m.id });
  }

  // 5. The shortlist: a quota per angle (STO-103).
  const weights = { [ANGLES.hotStreak]: cfg.shortlistSplitHotStreak, [ANGLES.backFromInjury]: cfg.shortlistSplitBackFromInjury, [ANGLES.backupStepsIn]: cfg.shortlistSplitBackupStepsIn };
  const picks = buildShortlist(matched, cfg.shortlistSize, weights);
  const byAngle: StorySummary["byAngle"] = {};
  for (const m of matched) (byAngle[m.angle] ??= { matched: 0, quota: 0, fill: 0 }).matched++;
  for (const k of picks) byAngle[k.angle]![k.slotKind]++;

  return {
    picks,
    summary: {
      slateDate: a.slateDate, runId: a.runId,
      found: candidates.length, foundByAngle, notPlaying: dropped.length, noSignals, noMarket: noMarket.length,
      noMarketSamples: noMarket.slice(0, 8), matched: matched.length, shortlisted: picks.length, byAngle,
      shortlist: picks.map((k) => ({ position: k.position, angle: k.angle, stat: k.stat, score: k.score, player: name.get(k.playerId) ?? k.playerId, slotKind: k.slotKind, summary: k.summary })),
      inputs: { calls: inputs.calls, failedCalls: inputs.failures.length, skippedRows: inputs.skippedRows.length, playersWithoutInputs: withoutInputs, unknownStatuses: inputs.unknownStatuses },
    },
  };
}

const isOut = (s: InjuryStatus | null) => !!s && (s.status === "Out" || s.status === "Doubtful" || s.status === "Unknown");
const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});

/** Teammates listed Out or Doubtful today, with a stored injury signal from today (a claim about tonight needs tonight's fact). */
function teammatesOut(teamId: number, inputs: StoryInputs, today: (r: SignalRef) => StoredRef | undefined): OutTeammate[] {
  const teamGames = inputs.teamGames.get(teamId);
  if (!teamGames) return [];
  return (inputs.injuriesByTeam.get(teamId) ?? []).flatMap((e) => {
    const log = inputs.logs.get(e.athleteId);
    const tonight = inputs.statusByAthlete.get(e.athleteId) ?? null;
    if (!log || !today({ subject: { kind: "team", id: teamId }, key: `injury:${e.athleteId}` })) return [];
    return [{ espnId: e.athleteId, name: e.name, teamId, tonight, log, teamGames }];
  });
}

// ---------------------------------------------------------------- the database

/**
 * Stored ESPN signals about tonight's players and teams: today's, plus earlier injury signals within the lookback (a player
 * "back from injury" was listed hurt on an earlier day). Newest wins per (subject, key).
 */
async function loadStoredSignals(db: Db, slate: Slate, slateDate: string, lookbackDays: number): Promise<Map<string, StoredRef>> {
  const { rows } = await db.query<{ id: string; player_id: string | null; team_id: number | null; key: string; date: string }>(
    `select id, player_id, team_id, key, slate_date::text as date
       from signals
      where source = $1 and slate_date between $2::date - $3::int and $2::date
        and (player_id = any($4::uuid[]) or team_id = any($5::smallint[]))
        and (slate_date = $2::date or key like 'injury:%')
      order by slate_date, id`,
    [SOURCE, slateDate, lookbackDays, slate.players.map((p) => p.id), slate.teams.map((t) => t.id)]);
  const out = new Map<string, StoredRef>();
  for (const r of rows) out.set(`${r.player_id ? "player" : "team"}:${r.player_id ?? r.team_id}|${r.key}`, { id: Number(r.id), date: r.date });
  return out;
}

/** Open player markets of tonight's games that haven't started. The band and spread are applied when matching. */
async function loadOpenMarkets(db: Db, slateDate: string): Promise<MarketRow[]> {
  const { rows } = await db.query<{ id: string; player_id: string; game_id: string; stat: string; strike: number; bid: number | null; ask: number | null }>(
    `select m.id, m.player_id, m.game_id, m.stat, m.strike::float8 as strike, m.yes_bid_cents as bid, m.yes_ask_cents as ask
       from markets m join games g on g.id = m.game_id
      where g.league = $1 and g.slate_date = $2::date and g.status = 'scheduled'
        and m.kind = 'player_stat' and m.status = 'open' and m.result is null
        and m.player_id is not null and m.stat is not null and m.strike is not null`,
    [LEAGUE, slateDate]);
  return rows.map((r) => ({ id: r.id, playerId: r.player_id, gameId: r.game_id, stat: r.stat, strike: r.strike, yesBidCents: r.bid, yesAskCents: r.ask }));
}

/** Replace the day's shortlist in one transaction: a re-run gives the same rows, never extras, and a failure leaves the old list intact. */
async function replaceShortlist(db: Db, runId: number, slateDate: string, picks: ShortlistPick[]): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query(`delete from story_shortlist where slate_date = $1::date`, [slateDate]);   // its signal links go with it
    for (const k of picks) {
      const { rows } = await client.query<{ id: string }>(
        `insert into story_shortlist (run_id, slate_date, league, position, player_id, game_id, team_id, angle, stat, score, summary, market_id, slot_kind)
         values ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
        [runId, slateDate, LEAGUE, k.position, k.playerId, k.gameId, k.teamId, k.angle, k.stat, k.score, k.summary, k.marketId, k.slotKind]);
      await client.query(`insert into story_shortlist_signals (shortlist_id, signal_id) select $1, unnest($2::bigint[])`, [rows[0]!.id, k.signalIds]);
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
