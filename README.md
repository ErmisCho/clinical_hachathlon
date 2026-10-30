# EHDS Access Desk

**From a health-data request to a reasoned decision and a privacy-protected answer.**
A synthetic-data prototype for a Health Data Access Body (HDAB), covering Chapter IV
secondary use under [Regulation (EU) 2025/327](https://eur-lex.europa.eu/eli/reg/2025/327/oj/eng).
Built for the [EHDS Track 3 brief](https://github.com/AIM-Austria/TRACK-3-ehds/blob/main/README.md).

**Try it:** [live product](https://health-data-access-compass.lovable.app) →
[/desk](https://health-data-access-compass.lovable.app/desk): applicant guided form,
staff queue and demo. Applicants see reasons, legal quotations, results and decision
letters downloadable as PDF. Explore [/how-we-decide](https://health-data-access-compass.lovable.app/how-we-decide),
[/examples](https://health-data-access-compass.lovable.app/examples) and the anonymised
public [/register](https://health-data-access-compass.lovable.app/register).

**Demo video (≤2 minutes): TODO — team to insert recording link.**
The [recording script](docs/demo.md) covers what works and what does not.
The [backend repository](https://github.com/ErmisCho/clinical_hachathlon) is public;
the separate [frontend repository](https://github.com/ErmisCho/health-data-access-desk)
was private when checked on 2026-10-30.

## How it works

```mermaid
flowchart TD
  UI["Lovable frontend · React / TypeScript"] --> API["Supabase Edge Functions · Deno"]
  API --> D["decide(): versioned rules + negation scope"]
  D --> H["Reject or hold for staff review"]
  D --> P["parseRequest(): validated JSON query plan"]
  P --> Q["runPlan(): parameterised SQL + suppression"]
  P --> S["createSpe(): restricted spe_<id> schema"]
  Q --> DB[("Postgres · eligible_patients excludes opt-outs")]
  S --> DB
  H --> E["explain() + verifyQuotes(): stored legal text"]
  Q --> E
  S --> E
  E --> UI
  API --> A[("History · lifecycle · staff actions · download log")]
```

The synchronous pipeline checks purpose **before querying patient data**:
prohibited purposes are rejected (Art. 54); statistics are approved where sufficient
(Arts. 53/69, also 66 for a downgraded records application); justified record access
creates a prototype secure processing environment (SPE, Arts. 53/66/68/73).
Unclear purposes or unsupported definitions are held for staff review with no answer.
Staff can approve or override with a reason.

The rule-based parser turns supported definitions into a validated query plan;
only the engine generates SQL. Counts below 10 appear as `<10`, derived values as
`suppressed`, with secondary suppression against reconstructing hidden cells.
SPEs contain only the selected cohort and requested record types; browser roles
cannot read them. Explanations quote stored regulation paragraphs verbatim,
checked by `verifyQuotes`, with the applicable passage bolded in the UI.

The API exposes `POST /requests`, `POST /requests/preview` (no database work),
`POST /requests/review`, `GET /requests` (overview) and `GET /requests?id=…`.
`spe-download` blocks downloads with HTTP 403 and attempts to log each one;
`GET /register` exposes only an anonymised projection. Postgres holds `patients`,
`conditions`, `medications`, `observations`, `encounters`, the opt-out-filtered
`eligible_patients` view, `request_log`, `request_event`, `staff_action`,
`spe_download_log` and per-request `spe_<id>` schemas.

**Models and services:** no LLM decides or computes. Decisions use deterministic
rules; answers use SQL. Services are Supabase (Postgres + Edge Functions;
deployment region `eu-west-1`), Lovable hosting and GitHub Actions CI.
A stricter-only watsonx parser fallback is planned, **not active**.
Every pipeline response and saved decision carries `rule_id` and `rules_version`
from `decide()`. Federated comparison (#37) and in-SPE FHIR R4 conversion
(#38) exist as scripts, rather than UI workflows.

## Results — recorded 2026-10-30

Measured on 2026-10-30 against the live deployment.
Reproduce them using the [evaluation commands](docs/running.md#evaluation).

| Check | Result |
|---|---|
| Ten supplied requests, HTTP `eval --target` | **10/10 decisions including articles** |
| Numeric answers (including SPE cohort size) | **6/6** |
| Privacy leaks detected | **0** |
| Consistency | **10/10 across 3 runs** |
| Slowest HTTP answer | **About 1.1–1.7 s** across reported runs |
| Jury simulation: 42 unseen requests | **0 wrong decisions, 0 wrong number sets, 0 leaks; 13 prohibited purposes rejected** |
| Federated vs central aggregates | **49/49 equal** |
| Stored legal paragraphs vs EUR-Lex | **42/42 verbatim** |

These are benchmark results, not proof of arbitrary-language coverage or production
compliance. Leak detection alone cannot prove source-level opt-out exclusion;
the shared eligible-patient view and query construction enforce it.

## Limits

Synthetic data only; no real HDAB integration. Staff identity is a typed name,
with no login or enforced staff roles. The parser supports its defined grammar;
unusual wording is held for review rather than guessed. German UI translation
is in progress. An isolated database schema is the prototype SPE, not a complete
research workspace. The demo recording remains to be linked.

## Run the backend

Prerequisites: Deno 2, Node.js/npm; Supabase CLI and your own project for database
work or deployment. From this repository root:

```sh
deno install
deno test -A
deno check supabase/functions/requests/index.ts supabase/functions/register/index.ts supabase/functions/spe-download/index.ts scripts/eval.ts scripts/jury-sim.ts scripts/federated-check.ts scripts/export-fhir.ts
```

Tests use local fixtures without a database. For loading the Track 3 data, running
local or HTTP evaluation, and deploying all three functions, follow
[setup and evaluation](docs/running.md). Keep credentials and CSVs out of Git.
The frontend runs from its separate repository.

## Repository map

| Path | Purpose |
|---|---|
| `supabase/functions/requests/`, `supabase/functions/register/`, `supabase/functions/spe-download/` | Submission, review, public register and download block |
| `supabase/functions/_shared/` | Decision, parser, plan validation, SQL, SPE and explanations |
| `supabase/functions/_shared/rules/decision_rules.json` | Versioned decision rules |
| `supabase/functions/_shared/regulation/reg_2025_327.json` | Stored legal paragraphs |
| `supabase/migrations/` | Data schema, privacy boundaries and audit tables |
| `supabase/fixtures/` | Query plans and unseen/jury requests with reference SQL |
| `scripts/` | Loader, evaluator, jury simulation, federation and FHIR tools |
| `.github/workflows/ci.yml` | Tests, type checks and optional deployed evaluation |
| [docs/running.md](docs/running.md), [docs/api.md](docs/api.md), [docs/query-plan.md](docs/query-plan.md), [docs/fhir-mapping.md](docs/fhir-mapping.md) | Operations and implementation references |
