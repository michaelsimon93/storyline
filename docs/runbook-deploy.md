# Runbook: deploy the database and worker

How the backend runs in production: the schema on **Supabase**, the worker on **Railway**. The web app deploys separately (STO-21). Secrets live only in Railway and Supabase, never in the repo.

| Piece | Where | Config in the repo |
|---|---|---|
| Database | Supabase project (Postgres 17) | `supabase/migrations/` |
| Worker | Railway service, root directory `worker/` | `worker/railpack.json` (start command) |
| Alerts | Discord channel webhook | none (`ALERT_WEBHOOK_URL` is a secret) |

## 1. First-time setup (Michael)

### Supabase
1. Create a project. Note its **project ref** (the id in the dashboard URL).
2. Copy the **session pooler** connection string: **Connect** → **Direct (Connection string)** → method **Session pooler**. It looks like `postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres`.
   - **Not the direct connection** (`db.<ref>.supabase.co`). That host is IPv6-only unless Supabase's paid IPv4 add-on is on, and Railway can't connect out over IPv6: the first deploy crashed with `ENETUNREACH 2600:…:5432`.
   - **Never the transaction pooler (port 6543).** It breaks the advisory locks that stop two copies of a job from running at once. Session mode (port 5432) keeps them.
3. Append **`?uselibpqcompat=true&sslmode=require`** to the URL. Without it, the worker's Postgres client connects **unencrypted**, sending the `postgres` password and every query over the internet in plaintext. Don't use a bare `sslmode=require`: node-postgres treats it as `verify-full`, which needs Supabase's CA certificate.
4. **Database → Settings → Enforce SSL:** turn it on. Then a URL missing the SSL setting fails loudly instead of quietly connecting in plaintext.

### Railway
1. New project → **Deploy from GitHub repo** → this repo.
2. Service **Settings**:
   - **Root Directory:** `worker`
   - **Watch Paths:** `/worker/**`, so docs and web changes don't redeploy the worker.
   - **Start Command:** leave **empty**. The start command comes from `worker/railpack.json`. Don't set it to `npm start` (see [Why not `npm start`](#why-not-npm-start)).
   - **Restart Policy:** On Failure, 10 retries (Railway's default).
   - **Healthcheck:** none. The worker has no HTTP server.
   - **Region:** the one nearest the Supabase project's region (e.g. US East for `us-east-1`). The worker makes many small queries, and each one crosses the distance.
3. Service **Variables**:

| Variable | Value |
|---|---|
| `DATABASE_URL` | The session pooler string from above, with the password filled in and ending in `?uselibpqcompat=true&sslmode=require` |
| `ALERT_WEBHOOK_URL` | The Discord alerts channel's webhook URL |
| `ANTHROPIC_API_KEY` | The worker's Anthropic API key, from the Anthropic Console. Curation (`npm run job -- curate`) calls Claude with it and fails with an authentication error without it. Needs billing or credit on the account. Never in the repo or in chat |
| `XAI_API_KEY` | The worker's xAI API key (console.x.ai). The X search (`npm run job -- context:x`) calls Grok with it; unset, the job alerts and skips, and curation is unaffected. Needs credit on the account (about $0.14 per search). Never in the repo or in chat |
| `DISCORD_TEST_WEBHOOK_URL` | Optional. The Discord `#testing` channel's webhook URL: each ingest posts a summary there. Unset = off. Never the alerts URL |
| `DISCORD_TEST_FEED_ENABLED` | Optional. `false` turns the test feed off but keeps its URL. Takes effect when Railway applies the variable change (it restarts the same build; no code change or PR) |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `120` (time between SIGTERM and SIGKILL; Railway's default is 0) |

Don't set `TZ`. Schedules are in ET in code (`America/New_York`) and the slate day comes from `storyline_day()` in the database, so the container's time zone doesn't matter.

> Railway's config-as-code (`railway.json`) is deprecated and stops being read on 2026-12-01, so none is used here. Its replacement (`.railway/railway.ts`) is still in beta. The settings above are few enough to set by hand.

## 2. Migrations: merged = deployed

Migrations apply automatically. On every push to `main`, after the tests pass, the `migrate` job in `.github/workflows/tests.yml` runs `supabase db push` against production (STO-130). Nobody runs it by hand.

**One-time setup (Michael):**
1. GitHub → repo **Settings → Secrets and variables → Actions → New repository secret**: name `SUPABASE_DB_URL`, value the **session pooler** string from §1 with the password filled in, ending in **`?sslmode=require`**. Not the worker's `uselibpqcompat` version: that parameter is for node-postgres, and the Supabase CLI doesn't use it. URL-encode the password if it has special characters (`@`, `:`, `/`, `#`).
2. Railway → worker service **Settings → Wait for CI**: on. Railway then holds each deploy until the whole workflow, `migrate` included, succeeds. If any job fails, the deploy is skipped and the old worker keeps running.

**What protects the order:**
- `migrate` only runs after the `schema`, `real-supabase` and `worker` jobs pass on `main`.
- Wait for CI holds the worker deploy until `migrate` finishes.
- Railway's docs say not to rely on Wait for CI alone, so the worker checks for itself at startup: if the database doesn't have `REQUIRED_MIGRATION` (`worker/src/lib/schema.ts`), it alerts Discord, waits up to 15 minutes for it, then stops with "worker failed to start".
- CI fails any PR that edits, deletes or renames a migration already on `main`, or adds one dated before the newest one on `main` (`scripts/check-migrations-frozen.sh`).

**If `migrate` fails:** the Actions run shows the SQL error, and the worker deploy is skipped.

**Expected noise, not a problem:**
- Several quick merges can leave a `migrate` run **cancelled** (GitHub keeps one pending run per group). The newest run applies everything, so only that commit deploys.
- Two schema PRs merged in the reverse of their migration dates make the second `db push` fail ("migration before last remote"). Before merging a schema PR, update its branch from `main` so CI re-checks the order.
- If a migration never lands, the worker alerts "database is behind", then "worker failed to start", and Railway's restarts repeat both. Fix the migration and the next restart recovers. Fix it with a **new** migration in a PR; never edit one that's on `main`. To see what production has applied, from the repo root:

```bash
supabase migration list --db-url "<session pooler URL>?sslmode=require"
```

## 3. Check the worker is healthy

**Railway logs** after a deploy should show, in order:

```
scheduled ingest: next run …
scheduled price_poll: next run …
```

If they show `worker failed to start` instead, it's almost always `DATABASE_URL` or a missing `app_config` row (that is, migrations not applied). Discord gets the same alert.

**The database** (Supabase SQL editor). Runs in the last 24 hours, by job and status:

```sql
select job, status, count(*), max(started_at) as latest
from pipeline_runs
where started_at > now() - interval '24 hours'
group by 1, 2
order by 1, 2;
```

Healthy means:
- `price_poll`: about 2 `ok` runs a minute. Until curation ships there are no cards, so each run reports `carded: 0` and makes no Kalshi calls.
- `ingest`: one `ok` run every 2 hours from 8am to 10pm ET (`ingest_schedule_et`), with games and markets in `outputs`.
- No rows stuck in `running` for more than a few minutes, and no `failed` rows (or each one has an explanation in `error`).

Real data landed:

```sql
select slate_date, count(*) from games group by 1 order by 1 desc limit 3;
select count(*) from markets where updated_at > now() - interval '1 day';
```

### Force a failure to test alerts

With the [Railway CLI](https://docs.railway.com/guides/cli) linked to the service (`railway link`), run the worker locally with Railway's real variables, but point it at a database that doesn't exist:

```bash
cd worker && npm ci
```

```bash
railway run -- env DATABASE_URL=postgres://nobody:none@127.0.0.1:1/none npm start
```

Within a few seconds Discord should get **`[storyline-worker] … worker failed to start`**. That tests the deployed `ALERT_WEBHOOK_URL` without touching production. If nothing arrives, the terminal shows why (`alerts webhook returned 4xx`, or `ALERT_WEBHOOK_URL not set`).

## 4. Roll back

- **Worker:** Railway → service → **Deployments** → pick the last good deployment → **Redeploy**. Then revert the bad commit on `main`, so the next merge doesn't bring it back.
- **Stop the worker entirely:** Railway → the active deployment → **Remove**. Jobs in flight get the draining window to finish. Redeploy to start it again.
- **Schema:** migrations are forward-only and frozen once deployed. Undo a change with a **new** migration that reverses it; it applies when its PR merges. Never edit or delete a deployed migration.
- **Bad data from a job:** every run is in `pipeline_runs` with its inputs and outputs. Find the run, fix the cause, and re-run the job (jobs are safe to re-run):

```bash
railway run -- npm run job -- ingest
```

## Why not `npm start`

Railway stops the old worker with SIGTERM on every deploy. The worker catches it, stops scheduling, waits for running jobs to finish, and exits. That only works if SIGTERM reaches the worker:

- **npm** doesn't pass SIGTERM on. npm dies, the worker is orphaned, and Railway then SIGKILLs it, mid-job.
- **A shell in between** has the same problem. Railpack runs the start command as `bash -c <command>`, so the command starts with `exec`, which replaces the shell with node.

`worker/test/shutdown.integration.test.ts` runs the exact command in `railpack.json` and fails if either regression comes back.
