// Pure parsers for ESPN's undocumented context endpoints (ADR-005). Each takes the raw JSON and
// returns typed rows, and throws when the shape isn't what we recorded (Nov 2026), so a
// breaking change fails loudly instead of writing bad signals. No network, no clock.

type Obj = Record<string, unknown>;

function obj(v: unknown, what: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`ESPN response: ${what} is not an object`);
  return v as Obj;
}
function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`ESPN response missing ${what}`);
  return v;
}
function str(v: unknown, what: string): string {
  if (typeof v !== "string" || v === "") throw new Error(`ESPN response missing ${what}`);
  return v;
}
/** An id ESPN sends as a string in some endpoints and a number in others (news ids are numbers). */
function idOf(v: unknown, what: string): string {
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  return str(v, what);
}
function num(v: unknown, what: string): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || (typeof v === "string" && v.trim() === "")) {
    throw new Error(`ESPN response: ${what} is not a number (${String(v)})`);
  }
  return n;
}

// ---------------------------------------------------------------- game log

export interface GameLogRow {
  eventId: string;
  date: string;       // ISO, as ESPN gives it
  home: boolean;
  opponentId: string; // ESPN team id
  min: number; reb: number; ast: number; pts: number;
  fg3m: number; fg3a: number;
}

/** Regular-season rows, newest first. Preseason rows are in the same file and must not count as form. */
export function parseGameLog(raw: unknown): GameLogRow[] {
  const data = obj(raw, "game log");
  const labels = arr(data.labels, "labels").map(String);
  const at = (label: string) => {
    const i = labels.indexOf(label);
    if (i < 0) throw new Error(`ESPN game log: no ${label} column`);
    return i;
  };
  const col = { min: at("MIN"), reb: at("REB"), ast: at("AST"), pts: at("PTS"), fg3: at("3PT") };
  const events = obj(data.events, "events");

  const rows: GameLogRow[] = [];
  for (const season of arr(data.seasonTypes, "seasonTypes")) {
    const s = obj(season, "season type");
    if (!str(s.displayName, "season name").endsWith("Regular Season")) continue;
    for (const cat of arr(s.categories, "categories")) {
      for (const r of arr(obj(cat, "category").events, "category events")) {
        const row = obj(r, "game row");
        const eventId = str(row.eventId, "eventId");
        const stats = arr(row.stats, `stats for ${eventId}`);
        if (stats.length !== labels.length) throw new Error(`ESPN game log: stats for ${eventId} has ${stats.length} values, expected ${labels.length}`);
        const meta = events[eventId];
        if (meta === undefined) throw new Error(`ESPN game log: no game info for event ${eventId}`);
        const m = obj(meta, `game ${eventId}`);
        const [made, att] = str(stats[col.fg3], "3PT").split("-");
        rows.push({
          eventId,
          date: str(m.gameDate, "gameDate"),
          home: str(m.atVs, "atVs") === "vs",
          opponentId: str(obj(m.opponent, "opponent").id, "opponent id"),
          min: num(stats[col.min], "MIN"), reb: num(stats[col.reb], "REB"),
          ast: num(stats[col.ast], "AST"), pts: num(stats[col.pts], "PTS"),
          fg3m: num(made, "3PT made"), fg3a: num(att, "3PT attempted"),
        });
      }
    }
  }
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// ---------------------------------------------------------------- injuries

export interface InjuryEntry { athleteId: string; name: string; status: string; date: string; comment: string }

/**
 * League-wide injuries by ESPN team id. An entry's own `id` is the injury's, not the player's:
 * the player's id only appears in the player-card URL, so that is where it is read.
 */
export function parseInjuries(raw: unknown): Map<string, InjuryEntry[]> {
  const teams = arr(obj(raw, "injuries").injuries, "injuries");
  const out = new Map<string, InjuryEntry[]>();
  for (const t of teams) {
    const team = obj(t, "injury team");
    const teamId = str(team.id, "injury team id");
    const entries = arr(team.injuries, `injuries for team ${teamId}`).map((e): InjuryEntry => {
      const entry = obj(e, "injury");
      const athlete = obj(entry.athlete, "injury athlete");
      const name = str(athlete.displayName, "athlete name");
      const card = arr(athlete.links ?? [], "athlete links").map((l) => obj(l, "link"))
        .find((l) => Array.isArray(l.rel) && l.rel.includes("playercard"));
      const m = typeof card?.href === "string" ? card.href.match(/\/player\/_\/id\/(\d+)(?:\/|$)/) : null;
      if (!m) throw new Error(`ESPN injuries: no athlete id for ${name}`);
      return {
        athleteId: m[1]!, name,
        status: str(entry.status, `status for ${name}`),
        date: str(entry.date, `date for ${name}`),
        comment: typeof entry.shortComment === "string" ? entry.shortComment : "",
      };
    });
    out.set(teamId, entries);
  }
  return out;
}

// ---------------------------------------------------------------- schedule

export interface FinishedGame { eventId: string; date: string; homeId: string; awayId: string; homeAbbr: string; awayAbbr: string; homeScore: number; awayScore: number }

/** A team's finished regular-season games with scores. Scheduled and preseason games are dropped. */
export function parseSchedule(raw: unknown): FinishedGame[] {
  const events = arr(obj(raw, "schedule").events, "events");
  const out: FinishedGame[] = [];
  for (const e of events) {
    const ev = obj(e, "event");
    if (obj(ev.seasonType, "seasonType").id !== "2") continue;
    const comp = obj(arr(ev.competitions, "competitions")[0], "competition");
    if (obj(obj(comp.status, "status").type, "status type").name !== "STATUS_FINAL") continue;
    const id = str(ev.id, "event id");
    const side = (homeAway: string) => {
      const c = arr(comp.competitors, "competitors").map((x) => obj(x, "competitor")).find((x) => x.homeAway === homeAway);
      if (!c) throw new Error(`ESPN schedule: ${id} has no ${homeAway} competitor`);
      const score = obj(c.score, `score for ${homeAway} in ${id}`);
      const team = obj(c.team, "team");
      return { team: str(team.id, "team id"), abbr: str(team.abbreviation, "team abbreviation"), score: num(score.value, `score for ${homeAway} in ${id}`) };
    };
    const home = side("home"), away = side("away");
    out.push({ eventId: id, date: str(ev.date, "event date"), homeId: home.team, awayId: away.team, homeAbbr: home.abbr, awayAbbr: away.abbr, homeScore: home.score, awayScore: away.score });
  }
  return out;
}

// ---------------------------------------------------------------- news

export interface Article { id: string; type: string; headline: string; published: string; url: string; teamIds: string[] }

/** A team's news feed. `teamIds` are the teams the article is tagged to (athlete tags are ignored). */
export function parseNews(raw: unknown): Article[] {
  return arr(obj(raw, "news").articles, "articles").map((a): Article => {
    const art = obj(a, "article");
    const id = idOf(art.id, "article id");
    const web = obj(obj(art.links ?? {}, "article links").web, `link for article ${id}`);
    return {
      id, type: str(art.type, `type for article ${id}`),
      headline: str(art.headline, `headline for article ${id}`),
      published: str(art.published, `published for article ${id}`),
      url: str(web.href, `link for article ${id}`),
      teamIds: arr(art.categories ?? [], "categories").map((c) => obj(c, "category"))
        .filter((c) => c.type === "team" && c.teamId !== undefined && c.teamId !== null).map((c) => String(c.teamId)),
    };
  });
}
