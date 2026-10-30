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

### Curated demo submissions

`scripts/seed-demo.ts` has two independently re-runnable steps. Reserve its fixed
reference list `AT20260412`–`AT20260424` for these applications (the API does not
accept hyphens). Run one maintenance process at
a time, with grading/submission jobs stopped. `clean` needs `DATABASE_URL` and
removes only grading IDs matching
`^(Q34|T49|P43|H47|UI47|L45|M45|N45)[A-Za-z0-9]*_`, legacy IDs starting `D_`,
and the exact fixed reference list. Other `AT` reference numbers are preserved.
It deletes their staff actions, lifecycle events, download logs and submissions,
and drops their SPE schemas in one transaction, including orphan audit rows and
SPEs. It prints IDs, row counts and schemas. Other IDs, including R01–R10, remain.
`--dry-run` reports the same cleanup scope without writes.

`seed` needs `BASE_URL` pointing to the functions root. It checks each ID via
`GET /requests/<id>` and submits missing IDs through `POST /requests`, so existing
R01–R10 and partial runs are preserved. New submissions have invented Austrian
applicants and `submitted` dates across the past three weeks; database audit
timestamps still reflect the actual API calls. It adds eight varied decisions,
three purpose holds left in the staff queue, and two purpose holds resolved through
`POST /requests/review` with written reasons. If staff review returns 401/403,
it continues and reports the missing actions; set `STAFF_TOKEN` and rerun `seed`
to finish them. The token is sent as Bearer Authorization only on review calls.
The summary table shows the outcomes; unexpected curated outcomes fail the run.
`seed --dry-run` previews the portfolio offline without HTTP calls. Optional
`EHDS_TRACK_DIR` has the same meaning as for evaluation.

With `DATABASE_URL` set as above, PowerShell:

```powershell
$env:BASE_URL = 'https://YOUR_PROJECT.supabase.co/functions/v1'
# Optional, when staff authentication is enabled:
# $env:STAFF_TOKEN = 'YOUR_STAFF_TOKEN'
deno run --allow-read --allow-env --allow-net scripts/seed-demo.ts clean --dry-run
deno run --allow-read --allow-env --allow-net scripts/seed-demo.ts clean
deno run --allow-read --allow-env --allow-net scripts/seed-demo.ts seed
```

With no step argument (or `all`), cleanup runs before seeding. Review the public
register and staff queue after running. Then use the evaluator below to verify
10/10 decisions, 6/6 numbers and zero leaks; live validation requires an explicit
run against your deployment and is not part of the offline tests.

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
