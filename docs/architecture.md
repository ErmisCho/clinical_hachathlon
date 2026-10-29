# Architecture

> Last updated: 2026-10-29  
> These decisions were agreed in the comments on issue #1 (first comment) and then revised in the second comment. The revised decisions supersede the originals where marked.

---

## Stack

| Layer | Technology |
|---|---|
| Front end | **Lovable** (its own repo, UI only) |
| Backend | **Supabase Edge Functions** (Deno / TypeScript) |
| Database | **Supabase Postgres** |
| Data loading | Migration SQL + a seed script (#12) |
| Deployment | **Supabase CLI** (`supabase db push`, `supabase functions deploy`) — no Docker, no separate hosting |
| CI | GitHub Actions (#17) |

The backend code and all issues live in **this repo**. The Lovable repo holds only the UI (Decision M).

---

## Component map

```
Lovable UI
    │  POST /requests
    │  GET  /requests
    │  GET  /requests/{id}
    │  GET  /spe/{id}/download  → always 403
    ▼
Supabase Edge Functions
    ├── parser        (request JSON → QueryPlan)
    ├── decision      (QueryPlan + purpose → REJECT / APPROVE_STATISTICAL / APPROVE_SPE)
    ├── engine        (QueryPlan → SQL → run against Postgres → small-cell filter)
    ├── spe           (provisions Postgres schema, copies cohort, blocks download)
    └── api           (HTTP routing, saves to requests table, returns result)
         │
         ▼
    Supabase Postgres
         ├── public schema   (patients, conditions, medications, observations, encounters)
         ├── eligible_patients view  (excludes opted_out = true)
         └── spe_<id> schema per approved SPE request
```

---

## Architecture decisions

| # | Decision | Rationale |
|---|---|---|
| A | The **parser** produces a JSON query plan (TypeScript `QueryPlan` type). Only the **engine** turns it into SQL; the parser never writes SQL. | One place to enforce privacy. No SQL injection. Plans are testable fixtures (#5). |
| B | The **small-cell rule** is one output filter that every statistical answer passes through. | A query cannot skip it by accident. |
| C | **Opt-outs** are removed in one base view (`eligible_patients`) that every query starts from. | "Leave out opted-out patients everywhere" holds by construction. Art. 71. |
| D | **Art. 54** prohibited purposes are detected with keyword rules; unclear purposes are flagged "needs staff review" rather than guessed. | Same result on every run (scored); no LLM needed. |
| E *(revised)* | The **secure processing environment** is a **separate Postgres schema per approved request**, holding only the selected patients and requested record types. The browser role cannot read it; the download endpoint always returns HTTP 403 and logs the attempt. | Postgres has no separate files; schema + RLS gives the same isolation as a separate DuckDB file. |
| F *(revised)* | The 5 CSVs are loaded once into Supabase Postgres by a seed script (#12). Every query starts from the `eligible_patients` view (Decision C). | One database, no file shipping. |
| G | The API is **synchronous**: `POST /requests` returns the full answer. No job queue. | Answers are fast (target < 60 s); less to build. |
| H | Every request and decision is **saved** to Postgres, so staff see the history and the blocked-download log. | Staff view and audit trail. |
| I | **No login**: the Lovable UI has an applicant/staff role switch. | Saves time; synthetic data only. |
| J *(revised)* | **No Docker, no separate hosting.** Lovable publishes the front end; the Supabase CLI deploys the edge functions. | Fastest path to a live URL. |
| K | The eval against `expected.json` (#2) is the final check; pytest → **Deno tests** per module. | Matches how the jury scores. |
| L | The **parser is rules-based**; watsonx is an optional fallback (#15), and only request text is ever sent to it. | All 10 requests name their codes in fixed phrasings. |
| M | The **issues and backend code stay in this repo**. The Lovable repo holds only the UI. | Keeps one place for tasks and logic. |
| N | A thin **R04 end-to-end slice (#16)** goes live before the layers are finished, and **CI (#17)** runs tests and eval on every push. | Site live early; checks are independent of the author. |

---

## Data flow for a statistical request

```
1. Lovable → POST /requests  (request JSON)
2. api edge function
   ├── 2a. parser → QueryPlan
   ├── 2b. decision module
   │        Art. 54 check → REJECT?  (stop, return immediately)
   │        "health data request" or justification for SPE? → APPROVE_STATISTICAL or APPROVE_SPE
   ├── 2c. engine (APPROVE_STATISTICAL path)
   │        Build SQL from QueryPlan
   │        Run against Postgres (eligible_patients view)
   │        Apply small-cell rule
   └── 2d. Save request + result to Postgres
3. api edge function → 200 response with decision + answer
4. Lovable renders the result
```

## Data flow for an SPE request

```
1. Lovable → POST /requests  (request JSON)
2. api edge function
   ├── 2a–2b. parser + decision → APPROVE_SPE
   ├── 2c. spe module
   │        Create schema spe_<id>
   │        Copy cohort patients + requested record tables
   │        Revoke all access from browser roles
   └── 2d. Save request + cohort_size to Postgres
3. api edge function → 200 response with decision + cohort_size
4. Lovable shows cohort size and "secure environment provisioned"
5. Any GET /spe/{id}/download → 403 (logged)
```

---

## Privacy invariants

1. **Opted-out patients** never appear in any query result (Decision C, `eligible_patients` view).
2. **Statistical answers** never contain a count below 10 without suppression (Decision B).
3. **SPE data** is never returned through the API. The download endpoint always returns 403 (Decision E).
4. **SQL is only generated** inside the engine module (Decision A); the parser and decision modules never produce SQL.
5. **External services** (watsonx fallback) receive only request text — never patient data (Decision L).

---

## Evaluation

The jury runs the 10 requests against `expected.json` (#2). CI also runs this eval on every push (#17). The targets are:

| Metric | Target |
|---|---|
| Correct decisions | 10 of 10 |
| Correct numbers | 6 of 6 approved statistical requests |
| Privacy leaks | 0 |
| Consistency across 3 runs | 10 of 10 |
| Time to answer (slowest request) | < 60 s |
