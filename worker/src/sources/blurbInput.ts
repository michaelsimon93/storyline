// The matchup facts a blurb may use (STO-77): the player's team and the opponent, from our own tables. A story's own team is the one
// the story job stored for it (story_shortlist.team_id: the player's team for that game, kept even if he is traded later).

import type { Db } from "../lib/db.js";
import type { CurationInput, Selection } from "../domain/curationRules.js";
import type { TeamsOf } from "../domain/blurbRules.js";

/** One query for the picked stories' teams and games, then a pure lookup. A story missing from the table is a bug, not a thinner blurb. */
export async function loadTeamsOf(db: Db, shown: CurationInput, selection: Selection): Promise<TeamsOf> {
  const ids = selection.picks.map((p) => Number(p.storyId));
  const { rows } = await db.query<{ id: string; team: string; opponent: string; home: boolean }>(
    `select s.id::text as id, t.name as team, o.name as opponent, (g.home_team_id = s.team_id) as home
       from story_shortlist s
       join games g on g.id = s.game_id
       join teams t on t.id = s.team_id
       join teams o on o.id = case when g.home_team_id = s.team_id then g.away_team_id else g.home_team_id end
      where s.id = any($1::bigint[])`, [ids]);
  const byStory = new Map(rows.map((r) => [r.id, { team: r.team, opponent: r.opponent, home: r.home }]));
  return (s) => {
    const t = byStory.get(s.storyId);
    if (!t) throw new Error(`blurbs: no team or game found for story ${s.storyId}`);
    return t;
  };
}
