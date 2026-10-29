# EHDS Health Data Access Body — Track 3

Supabase backend for the hackathon. The Lovable frontend lives in a separate repo.
The synthetic Track 3 CSVs stay outside this repository and must never be committed.

## Setup

With Node.js, Deno and the Supabase CLI available, and your own Supabase project
already linked, run from the repository root (POSIX shell):

```sh
npm install
npx supabase db push
DATABASE_URL='postgresql://postgres:YOUR_PASSWORD@YOUR_DB_HOST:5432/postgres' npm run load-data
deno test
```

In PowerShell, the load command is:

```powershell
$env:DATABASE_URL = 'postgresql://postgres:YOUR_PASSWORD@YOUR_DB_HOST:5432/postgres'; npm run load-data
```

Use a privileged server database connection (the direct connection or session
pooler), never a browser key. Keep the connection string out of source control.
The loader reads `DATABASE_URL` from the environment; it does not read `.env` files.
It defaults to `../TRACK-3-ehds/data`, resolved relative to this repository, or uses
`EHDS_DATA_DIR` (relative paths are also resolved against the repository root):

```sh
EHDS_DATA_DIR='/path/to/data' DATABASE_URL='postgresql://...' npm run load-data
```

The loader replaces all five tables in one transaction using UTF-8 CSV COPY,
checks imported counts against CSV record counts, and prints each table's count
after commit. Empty CSV fields become SQL NULL, including medication end dates
and non-inpatient primary diagnosis codes. A failed load rolls back the replacement.
For the supplied dataset expect 20,000 patients, 839 opted out, and 19,161 eligible.

All backend cohort queries must start from `public.eligible_patients` and join
conditions, medications, observations or encounters by `patient_id`. The shared
module provides the initial query and the fixed reference date, 2025-12-31.
The view uses invoker security; all five tables have RLS enabled and no browser
policies. Both `anon` and `authenticated` have their privileges revoked on all five
tables and the view. Only trusted backend database access should query these data.
Deno tests use local imports and require no network or data access.

## Eval

From the repository root, with `../TRACK-3-ehds/requests` available:

```sh
# Live HTTP (deployed edge function)
deno run --allow-read --allow-net --allow-env=EHDS_TRACK_DIR scripts/eval.ts --target https://YOUR_PROJECT.supabase.co/functions/v1 --key YOUR_ANON_KEY

# Offline (saved responses)
deno run --allow-read --allow-env=EHDS_TRACK_DIR scripts/eval.ts --responses ./saved-responses

# Local (direct pipeline, no HTTP) — requires DATABASE_URL
DATABASE_URL='postgresql://postgres:YOUR_PASSWORD@YOUR_DB_HOST:5432/postgres' \
  deno run --allow-read --allow-net --allow-env=DATABASE_URL,EHDS_TRACK_DIR scripts/eval.ts --local
```

In PowerShell:

```powershell
$env:DATABASE_URL = 'postgresql://postgres:YOUR_PASSWORD@YOUR_DB_HOST:5432/postgres'
deno run --allow-read --allow-net --allow-env=DATABASE_URL,EHDS_TRACK_DIR scripts/eval.ts --local
```

Set `EHDS_TRACK_DIR` to override the track repository root (relative paths use the working directory); requests and `expected.json` are read from its `requests/` directory.
CI runs tests and type checks on every push and pull request; deployed eval runs when repository secret `EVAL_BASE_URL` is set, using `EVAL_KEY` for the publishable/anon key, and is skipped otherwise. Require the `test` and `eval` checks in branch protection to block merging on failures.

`--key` is optional (HTTP mode only) and sets both Authorization (Bearer) and apikey headers.
Saved files are `R01.json` through `R10.json`, each containing an API response
or an array of three responses to check independent runs. Single responses are
read three times and cannot establish live backend consistency. The evaluator
scores all three runs, prints decision/article and number matches, privacy leaks,
inconsistent requests and the slowest run, and exits non-zero on any failure.
Offline and local timing measures pipeline/parse time, not HTTP latency. Privacy checks detect
exposed patient fields/IDs, small counts and missing suppression; aggregate-only
answers cannot prove that opted-out patients were excluded from source queries.

### `--local` mode

`--local` calls `answerRequest()` from `supabase/functions/_shared/pipeline.ts` directly,
bypassing HTTP. It uses a postgres.js connection (`npm:postgres`) opened once for all 10
requests and closed on completion. The same scoring, three-run consistency check, leak
detection and timing as the other modes apply.
