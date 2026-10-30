# Setup and evaluation

Run commands from the backend repository root. Prerequisites: Deno 2,
Node.js/npm, Git, and Supabase CLI available through `npx supabase`.
Database work needs your own Supabase project and a privileged Postgres direct
connection or session pooler connection, never a browser key.

## Install and check

```sh
deno install
deno test -A
deno check supabase/functions/requests/index.ts supabase/functions/register/index.ts supabase/functions/spe-download/index.ts scripts/eval.ts scripts/jury-sim.ts scripts/federated-check.ts scripts/export-fhir.ts
```

`deno install` installs the `postgres` dependency declared in `package.json`.
Tests use local fixtures without network or database access. CI also type-checks
all function and script TypeScript files.

## Database and synthetic data

Clone the [track repository](https://github.com/AIM-Austria/TRACK-3-ehds)
beside this checkout as `../TRACK-3-ehds`. It supplies `data/` and `requests/`,
including `requests/expected.json`; these are external inputs, not backend files.
Keep CSVs outside this repository.

```sh
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

POSIX shell:

```sh
export DATABASE_URL='postgresql://postgres:YOUR_PASSWORD@YOUR_DB_HOST:5432/postgres'
npm run load-data
```

PowerShell:

```powershell
$env:DATABASE_URL = 'postgresql://postgres:YOUR_PASSWORD@YOUR_DB_HOST:5432/postgres'
npm run load-data
```

The loader (`scripts/load-data.mjs`) reads `DATABASE_URL` from the environment,
not an environment file. Optional `EHDS_DATA_DIR` overrides `../TRACK-3-ehds/data`;
relative paths resolve against the repository root. It **replaces all five data
tables** in one transaction using UTF-8 CSV COPY, checks imported counts against
CSV record counts, and rolls back on failure. Empty fields become SQL NULL,
including medication end dates and non-inpatient primary diagnoses.
For the supplied dataset expect 20,000 patients, 839 opted out and 19,161 eligible.

Every cohort query starts from `public.eligible_patients` and joins record tables
by `patient_id`; the fixed reference date is 2025-12-31. The view uses invoker
security. All five tables have RLS enabled, with browser privileges revoked on
them and the view. Use trusted backend database access only.

## Deploy

Once migrations and data are ready, the linked project's functions use
`SUPABASE_DB_URL`, supplied by the hosted Supabase runtime. Ensure it is available
server-side; never put a privileged database URL or service credential in the
frontend. Function JWT verification is disabled in `supabase/config.toml`; this
prototype has no staff authentication.

```sh
npx supabase functions deploy requests
npx supabase functions deploy spe-download
npx supabase functions deploy register
```

The frontend is in [its own repository](https://github.com/ErmisCho/health-data-access-desk).
Configure its Supabase project URL and publishable/anon key for your deployment;
this backend checkout does not contain the UI build. Keep secrets in environment
variables or service secret stores, out of Git and recorded terminal output.

## Evaluation

The evaluator reads ten requests and `expected.json` from the sibling track
checkout. Optional `EHDS_TRACK_DIR` overrides the track root (relative paths use
the working directory). HTTP evaluation submits requests and persists them;
local evaluation bypasses HTTP but can create/rebuild SPE schemas.

Live HTTP (replace placeholders with your own deployment values):

```sh
deno run --allow-read --allow-net --allow-env=EHDS_TRACK_DIR scripts/eval.ts --target https://YOUR_PROJECT.supabase.co/functions/v1 --key YOUR_ANON_KEY
```

`--key` is optional in HTTP mode and sets both Bearer Authorization and `apikey`.
With `DATABASE_URL` already exported/set as above, direct local evaluation is:

```sh
deno run --allow-read --allow-net --allow-env=DATABASE_URL,EHDS_TRACK_DIR scripts/eval.ts --local
```

For saved responses, replace `YOUR_RESPONSE_DIR` with an existing directory:

```sh
deno run --allow-read --allow-env=EHDS_TRACK_DIR scripts/eval.ts --responses YOUR_RESPONSE_DIR
```

That directory must contain `R01.json` through `R10.json`, each an API response
or an array of three independently saved responses. Re-reading one response
three times does not establish live consistency. The evaluator scores all
three runs, prints decision/article and numeric matches, leaks, inconsistent
requests and slowest run, and exits nonzero on failure. Local/offline timing is
pipeline/parse time, not submission-to-answer HTTP latency. Leak checks detect
exposed patient fields/IDs, small counts and missing suppression; aggregate-only
answers cannot prove exclusion of opted-out source patients.

Additional database checks (same `DATABASE_URL`):

```sh
deno run --allow-read --allow-env --allow-net scripts/jury-sim.ts
deno run -A scripts/federated-check.ts
```

The jury simulation uses 42 unseen fixtures with independently authored reference
SQL and rolls back its transaction, including SPE creation. The federated check
runs plans centrally and separately by hospital in the same database, combines
aggregates before suppression and compares outputs; it is not a deployed
multi-hospital network.

For an already provisioned R05 SPE:

```sh
deno run -A scripts/export-fhir.ts R05
```

This stores FHIR R4 resources inside `spe_r05.fhir_resources`; it does not download
patient records. It aborts unless a round trip reproduces the source rows.
See [FHIR mapping](fhir-mapping.md).

CI (`.github/workflows/ci.yml`) runs tests and type checks on pushes and pull
requests. Deployed evaluation runs only when repository secret `EVAL_BASE_URL`
is set, with `EVAL_KEY` for the publishable/anon key; otherwise it is skipped.
Branch protection must be configured separately if required checks should block
merging. See the README for dated, team-reported results; preserve fresh evaluator
output with its mode and date when re-measuring.
