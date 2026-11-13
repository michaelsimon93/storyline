// The worker connects directly to Postgres (Supabase's direct connection string)
// as a privileged role, so it bypasses RLS. Users never get this access: they go
// through RLS policies and the place_pick / create_profile functions.

import pg from "pg";

export type Db = pg.Pool;

export function connect(url = process.env.DATABASE_URL): Db {
  if (!url) throw new Error("DATABASE_URL is not set");
  return new pg.Pool({ connectionString: url, max: 4 });
}

/** Record a job run in pipeline_runs: inputs, outputs, and any failure. */
export async function withRun<T extends object>(
  db: Db,
  job: string,
  slateDate: string,
  fn: (runId: number) => Promise<T>,
): Promise<T> {
  const { rows } = await db.query<{ id: number }>(
    `insert into pipeline_runs (job, slate_date) values ($1, $2) returning id`,
    [job, slateDate],
  );
  const runId = rows[0]!.id;
  try {
    const outputs = await fn(runId);
    await db.query(
      `update pipeline_runs set status='ok', finished_at=now(), outputs=$2 where id=$1`,
      [runId, JSON.stringify(outputs)],
    );
    return outputs;
  } catch (err) {
    await db.query(
      `update pipeline_runs set status='failed', finished_at=now(), error=$2 where id=$1`,
      [runId, err instanceof Error ? err.stack ?? err.message : String(err)],
    );
    throw err;
  }
}
