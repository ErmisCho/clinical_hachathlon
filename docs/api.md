# API reference

Base URL: `https://<project-ref>.supabase.co/functions/v1`. The Lovable client
supplies its Supabase anon key (`Authorization: Bearer <key>`; `apikey` may also
be supplied). The functions use `SUPABASE_DB_URL` as their service database
connection. Tables are inaccessible to anon/authenticated roles. The demo has an
applicant/staff UI switch, with no separate staff authentication.

The `requests` function allows origin `*` (including
`https://health-data-access-compass.lovable.app` and Lovable previews), headers
`authorization, x-client-info, apikey, content-type`, and methods
`GET, POST, OPTIONS`. Preflight `OPTIONS` returns an empty HTTP 204 without
connecting to the database. All other `requests` responses are JSON and include
these CORS headers.

## `POST /requests`

Lovable: `supabase.functions.invoke("requests", { body })`. Runs
`answerRequest(body, sql)` synchronously: decision first (rejections never query
patient data), then a review hold, then parsing and aggregate execution or SPE creation. Saves the
complete submitted JSON and pipeline response in `public.request_log` before
returning HTTP 200. Every successful submission creates a new row, even when the
request id has been submitted before. Invalid HTTP input is not saved; execution
or persistence failure returns HTTP 500 without a successful result.

The body must be a JSON object with nonempty string fields `id`, `requested_as`,
`purpose`, and `question`, plus `definitions` as an array of strings. IDs contain
1–59 ASCII letters, digits or underscores. Text fields are limited to 8000
characters, definitions to 50 entries of at most 2000 characters, and the body
to 64 KB. Other metadata is preserved but not validated by the
HTTP handler. The pipeline interprets `requested_as` (`health data request` or
`health data access application`) and the purpose. Missing or unsupported query
definitions produce a saved review result with `parse_errors`, not HTTP 400.

```json
{
  "id": "R01",
  "submitted": "2026-10-29T18:30:00+01:00",
  "applicant": {
    "name": "Dr. Sophie Lechner",
    "organisation": "Danube Institute for Diabetes Research",
    "country": "AT"
  },
  "requested_as": "health data request",
  "requested_format": "anonymised statistics",
  "purpose": "Public health research on diabetes prevalence.",
  "question": "How many adults have type 2 diabetes in each region?",
  "definitions": [
    "Adult = aged 18 or older on 31 December 2025.",
    "Type 2 diabetes = any condition with an ICD-10 code starting with E11.",
    "Report per region: adults with type 2 diabetes."
  ]
}
```

The response is the complete pipeline result:

| Field                | Shape                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `request_id`         | Submitted `id`                                                                                           |
| `decision`           | `REJECT`, `APPROVE_STATISTICAL`, or `APPROVE_SPE`                                                        |
| `articles`           | Array of article number strings                                                                          |
| `reason`             | Explanation string                                                                                       |
| `needs_review`       | Boolean; also true for parse failures                                                                    |
| `status`             | `staff_review` when held; otherwise `decided` |
| `answer`             | Aggregate object, SPE `{ "cohort_size": number }`, or `null` for rejection or any review hold                 |
| `spe_schema`         | Present only for successful SPE creation, e.g. `spe_r05`                                                 |
| `parse_errors`       | Present for parse failure: array of `{ "definition": string, "reason": string }`                         |
| `explanation`        | Present when quote verification passes (see below); omitted otherwise                                   |
| `explanation_error`  | Present when explanation could not be verified; omitted otherwise                                        |
| `population`         | Present only after successful execution: `{ "eligible_patients": number }` — count from the `eligible_patients` view (opted-out rows already excluded) |
| `timeline`           | Ordered lifecycle events: `[{ "status": string, "at": string }]`. Statuses: `submitted`, `assessed`, `staff_review` (held only), `decided`, `fulfilled` (non-REJECT only). `at` is an ISO 8601 timestamp with milliseconds (e.g. `"2026-10-30T01:20:07.123Z"`). Present on POST, review, and `GET ?id`. The review endpoint returns the full timeline (all prior events plus new ones). |
| `lifecycle_status`   | Last status in `timeline` (e.g. `"fulfilled"`). Backwards-compatible: top-level `status` stays `"staff_review"` or `"decided"` as before. |

The `explanation` object provides plain-language reasoning and verbatim regulation quotes:

| Field                         | Shape                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `explanation.rule`            | Plain-language rule name, e.g. `"Prohibited purpose (Art. 54)"`                                        |
| `explanation.trigger_phrases` | Array of exact substrings from the request purpose/question that triggered the decision                |
| `explanation.articles`        | Array of `{ number, title, summary, quote, ref }` — one entry per cited article                       |
| `explanation.articles[].quote`| Verbatim paragraph text from Regulation (EU) 2025/327 (fetched from EUR-Lex; verified word-for-word)   |
| `explanation.plan_summary`    | Plain-English description of the query plan, e.g. `"Patients aged 18+, with ICD-10 E11, counted per region"` |

Quote verification: every `explanation.articles[].quote` is confirmed to be a verbatim (whitespace-normalised) substring of the stored regulation text in `supabase/functions/_shared/regulation/reg_2025_327.json`, and every `trigger_phrase` is a verbatim substring of the submitted request. If any check fails, `explanation` is omitted and `explanation_error` is set.

Example statistical result (values illustrative):

```json
{
  "request_id": "R01",
  "decision": "APPROVE_STATISTICAL",
  "articles": ["53", "69"],
  "reason": "Your purpose is an allowed use of health data (Art. 53). Anonymised statistics are sufficient to answer the question (Art. 69).",
  "needs_review": false,
  "status": "decided",
  "answer": {
    "Wien": { "cohort": 263 },
    "Tirol": { "cohort": "<10" }
  },
  "population": { "eligible_patients": 9658 },
  "explanation": {
    "rule": "Approved for anonymised statistics – health data request (Art. 53, 69)",
    "trigger_phrases": ["…We study regional differences in type 2 diabetes to plan a prevention programme…"],
    "articles": [
      {
        "number": "53",
        "title": "Purposes for which electronic health data can be processed for secondary use",
        "summary": "Lists the allowed purposes for accessing health data for secondary use, including research, statistics, education, and quality improvement.",
        "quote": "1. Health data access bodies shall only grant access to electronic health data referred to in Article 51 for secondary use to a health data user where the processing of the data by that health data user is necessary for one of the following purposes: …",
        "ref": "Art. 53(1)"
      },
      {
        "number": "69",
        "title": "Health data request",
        "summary": "Allows applicants to request anonymised statistical answers (a 'health data request') without needing a full data permit.",
        "quote": "1. The health data applicant may submit a health data request for the purposes referred to in Article 53 with the aim of obtaining a response only in an anonymised format …",
        "ref": "Art. 69(1)"
      }
    ],
    "plan_summary": "Patients aged 18+ on 31 Dec 2025; counted per region; metrics: count of patients (adults), count of patients (type2_diabetes), prevalence_pct as a percentage"
  }
}
```

Statistical answers contain aggregate numbers only. Counts below 10 (including
zero) are `"<10"`; unsafe means/percentages are `"suppressed"`. A value of 10 or
more is also `"suppressed"` when it would let a hidden cell be recomputed from
the rest of the answer (secondary suppression, see `docs/query-plan.md`). Empty
groups are included. SPE responses contain only the cohort size and schema name, never
patient records. Rejection is an HTTP 200 result with `decision: "REJECT"` and
`answer: null`.

Whenever `needs_review` is true (including unclear purposes and unreadable
definitions), `status` is `staff_review`, `answer` is null, and neither
`population` nor `spe_schema` is returned. No engine queries or SPE creation run.
Decision, reason, articles and verified explanation remain available. Applicant
fields such as `needs_review`, `decision` or `review` cannot bypass the hold.

## `POST /requests/preview`

Lovable: `supabase.functions.invoke("requests/preview", { body })`. Validates the
body like a full submission (same field rules, same size limits) but does **not**
save anything, does not query patient data, and does not create or modify any SPE
schema. It is safe to call repeatedly; there are no side effects.

`id` and `submitted` are optional — the handler fills `"preview"` / current
timestamp when absent. All other fields follow the same constraints as
`POST /requests`.

```json
{
  "requested_as": "health data request",
  "purpose": "Public health research on diabetes prevalence.",
  "question": "How many adults have type 2 diabetes in each region?",
  "definitions": [
    "Adult = aged 18 or older on 31 December 2025.",
    "Type 2 diabetes = any condition with an ICD-10 code starting with E11.",
    "Report per region: adults with type 2 diabetes."
  ]
}
```

The response contains the decision, plain-language explanation and any definitions
the parser could not understand:

| Field             | Shape                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `decision`        | `REJECT`, `APPROVE_STATISTICAL`, or `APPROVE_SPE`                                          |
| `articles`        | Array of article number strings                                                            |
| `reason`          | Plain-language decision reason                                                             |
| `needs_review`    | Boolean; true when the purpose is unclear                                                  |
| `rule`            | Plain-language rule name, e.g. `"Approved for anonymised statistics – health data request"` |
| `trigger_phrases` | Exact substrings of purpose/question that triggered the decision                           |
| `plan_summary`    | Plain-English description of the parsed query plan (present when parsing succeeded)       |
| `unreadable`      | Array of `{ index, definition, reason }` — definitions the parser could not consume; `index` is the 0-based position in the submitted `definitions` array |

```json
{
  "decision": "APPROVE_STATISTICAL",
  "articles": ["53", "69"],
  "reason": "Your purpose is an allowed use of health data (Art. 53). Anonymised statistics are sufficient to answer the question (Art. 69).",
  "needs_review": false,
  "rule": "Approved for anonymised statistics – health data request (Art. 53, 69)",
  "trigger_phrases": ["prevention"],
  "plan_summary": "Patients aged 18+, with type 2 diabetes (ICD-10 E11), counted per region; metrics: adults with type 2 diabetes (ICD-10 E11)",
  "unreadable": []
}
```

When a definition cannot be parsed its entry has `index` (0-based position in the
request's `definitions` array), the original `definition` text, and the `reason`
the parser rejected it. The preview always runs the full parser even for rejected
requests so the caller can highlight every problematic line.

Invalid fields return HTTP 400 with `{ "error": "invalid request", "problems": [...] }`.
There is no HTTP 500 path: the preview never connects to the database.

## `POST /requests/review`

Staff reviews the latest saved submission for `request_id`:

```json
{
  "action": "approve",
  "request_id": "R01",
  "reason": "The applicant clarified the public health research purpose.",
  "staff_name": "Demo reviewer"
}
```

`action` is `approve` or `override`. Both require `request_id`, nonblank `reason`
and `staff_name` (at most 8000 characters each). `approve` accepts no `decision`;
it retains the pipeline decision and clears the purpose review flag. It requires
a held, non-REJECT request, otherwise HTTP 409. `override` requires `decision`
as `REJECT`, `APPROVE_STATISTICAL` or `APPROVE_SPE` and can change a decided request.
Unknown ids return HTTP 404; invalid review fields return HTTP 400.

Approvals rerun the saved request through the same parser and execution pipeline,
with purpose review forced off by a server-only argument. Small-cell suppression,
opt-out exclusion and SPE restrictions remain unchanged; download attempts remain
blocked. Unreadable definitions still return `staff_review`, `answer: null` and
`parse_errors`; staff must obtain a corrected submission. A REJECT override
stores a rejection without reading patient data or creating an SPE.

The endpoint returns the updated pipeline response. A transaction locks the
latest submission, updates its response in place (preserving `submitted_at` and
the original request), and inserts a `public.staff_action` audit row with action,
effective decision, reason, staff name and server timestamp. It links to the exact
request-log row so repeated ids have separate review histories. Execution or save
failure rolls back the review. Review attempts that remain held are also recorded.
Subsequent GET lookups return the updated response.

The demo uses the same applicant/staff UI switch and function key described
above; `staff_name` is a supplied audit label, not an authenticated identity.
The audit table has RLS enabled and no anon/authenticated table access.

## `GET /requests?id=R01` or `GET /requests/R01`

Returns the latest saved pipeline response for the request id, with the same
shape as POST. URL-encode ids. The query parameter takes precedence over the
trailing path segment if both are supplied. Rows are ordered by `submitted_at`
descending, then database row `id` descending to break ties.

Returns HTTP 404 with `{ "error": "request not found" }` if no result exists. An
empty/whitespace query id or malformed percent encoding in a path id returns
HTTP 400. Both `/requests` and `/requests/` are accepted.

## `GET /requests`

Without an id, returns a bounded submission overview, the newest 100 entries
of the blocked-download log, and the newest 100 staff audit entries. The overview
reserves space for submissions still awaiting staff review (`needs_review: true`),
then fills the remaining places with the newest decided submissions up to 100
total. All lists are newest first (timestamp descending, then database row id
descending). There is no pagination; `limit` and `offset` have no effect.
Repeated request ids appear once per selected saved submission. History selection
happens before overview JSON projection and staff-action lookup; legacy
JSON-string responses are decoded as needed to identify held submissions.

If more than 100 submissions await review, all held submissions are returned
and decided submissions are omitted; preserving the staff queue takes precedence
over the 100-row target in that case.

```json
{
  "requests": [
    {
      "request_id": "R05",
      "submitted_at": "2026-10-29T18:30:05.123Z",
      "decision": "APPROVE_SPE",
      "articles": ["53", "66", "68", "73"],
      "needs_review": false,
      "status": "decided",
      "last_staff_action": null,
      "spe_schema": "spe_r05"
    },
    {
      "request_id": "R01",
      "submitted_at": "2026-10-29T18:29:05.123Z",
      "decision": "APPROVE_STATISTICAL",
      "articles": ["53", "69"],
      "needs_review": false,
      "status": "decided",
      "last_staff_action": null,
      "spe_schema": null
    }
  ],
  "downloads": [
    {
      "request_id": "R05",
      "attempted_at": "2026-10-29T18:31:00.123Z"
    }
  ],
  "staff_actions": [
    {
      "request_id": "R01",
      "action": "approve",
      "decision": "APPROVE_STATISTICAL",
      "reason": "The applicant clarified the research purpose.",
      "staff_name": "Demo reviewer",
      "created_at": "2026-10-29T18:32:00.123Z"
    }
  ]
}
```

`submitted_at` is the server's save timestamp, not the submitted request's
`submitted` metadata. `spe_schema` is null when absent. Empty history returns
`{ "requests": [], "downloads": [], "staff_actions": [] }`. The overview never
contains answers, request bodies, applicant metadata, patient data, or download
user agents.
Each row includes `status` (`staff_review` or `decided`) and `last_staff_action`
(null or `{ id, request_id, action, decision, reason, staff_name, created_at }`).
The action is the latest for that exact submission, ordered by `created_at`, then
audit id descending. Staff can filter `status: "staff_review"` for their queue.
Legacy saved responses without status are classified using `needs_review`.

`staff_actions` lists up to 100 audit rows newest first. Each entry has
`request_id`, `action` (`approve` or `override`), `decision` (the effective
decision after the action), `reason`, `staff_name`, and `created_at`. Internal
ids are not included.

## Errors from `requests`

| Status | Meaning                                                                                                              |
| ------ | -------------------------------------------------------------------------------------------------------------------- |
| 400    | Malformed JSON, non-object body, missing/invalid required string, invalid question/definitions, or invalid lookup id |
| 404    | Unknown route or no saved result for the id                                                                          |
| 405    | Unsupported HTTP method, or POST to a result-id path                                                                 |
| 409    | Approval of a request that is not awaiting approval; use an explicit override to change a decision |
| 500    | Database connection, pipeline, or history read/write failure                                                         |

Errors use `{ "error": "message" }`. Internal failures always return
`{ "error": "internal server error", "code": "42501", "stage": "list_requests" }`.
`code` is the Postgres SQLSTATE when present, otherwise the error name. `stage`
identifies the failing step: `connect`, `list_requests`, `list_downloads`,
`list_staff_actions`, `load_request`, `answer_request`, `save_request`,
`review_request`, or `serialize`.
Only the code and stage are logged for these failures; exception text, SQL,
request bodies, row data, and stack traces are never returned.

## `GET /register`

Public transparency register, with JWT verification disabled. GET only; OPTIONS
returns 204. CORS allows origin `*`, headers `authorization, x-client-info, apikey,
content-type`, and methods `GET, OPTIONS`. Other methods return 405 and unknown
paths return 404. Internal failures return 500 with
`{ "error": "internal server error", "code": "42501", "stage": "list" }`.
`code` is a five-character SQLSTATE when available, otherwise the error name
(or `Error`). `stage` is `connect`, `list` (query), or `build` (public projection).
Only code and stage are logged; messages and saved data are never disclosed.

```json
{
  "entries": [{
    "reference": "HDAB-2026-000123",
    "date": "2026-10-30",
    "organisation_type": "Research institution",
    "purpose_category": "scientific research",
    "decision": "APPROVE_STATISTICAL",
    "articles": ["53", "69"]
  }]
}
```

Selects the latest submission per `request_id` (server `submitted_at` descending,
then row id descending), then excludes responses with `needs_review: true` and
returns at most 100, newest first. A newer held submission hides any older decision
for that request. There is no pagination; query parameters do not change the limit.
Empty history returns `{ "entries": [] }`. Legacy JSON-string objects are supported.

SQL transfers only the row id, request id and submission timestamp, the request's
`requested_as`, `requested_format`, `purpose`, `question`, `definitions` and
`applicant.organisation`, and the response's `decision`, `articles` and
`needs_review`. Whole request/response JSONB values and answers never cross the
database connection. `decide()` currently reads only `requested_as`, `purpose`
and `question`; the other projected request fields retain the minimal request shape.

`reference` uses only the database row id and submission year, never the applicant's
request identifier. `date` is the server submission date in UTC, without a time.
Organisation keyword categories are Research institution (university/research/institute),
Healthcare provider (hospital/clinic), Public body (ministry/agency/authority/public),
Insurer (insurance/insurer), Company (pharma/company/GmbH/AG/Ltd/marketing), or Other.
Insurer and explicit company terms take priority, then research, healthcare and
public terms; thus a marketing agency is a Company and a public agency a Public body.
`purpose_category` is the standard rule label from `decision_rules.json`, selected
by rerunning the pure `decide()` on the saved request; it is never free text.
`decision` and legal article numbers come from the saved response, preserving staff
overrides. Only recognised decisions and article numbers are published.

The response explicitly projects these six fields. It never includes personal or
organisation names, original request ids, purpose/question text, definitions,
answers, cohort sizes, SPE schema names, staff details or patient data. It reads
only `public.request_log`; it never queries patient tables.

## `GET /spe-download?id=R05` or `POST /spe-download`

The deployed download function is named `spe-download`; there is no
`/spe/{id}/download` route. For POST, provide `{ "id": "R05" }` as JSON, or use
the query parameter (a nonempty query id takes precedence). Missing or invalid
body ids become null. GET/POST attempts are logged to `public.spe_download_log`
on a best-effort basis and blocked with HTTP 403:

```json
{
  "error": "Download blocked: data in a secure processing environment cannot be downloaded (EHDS Art. 73).",
  "request_id": "R05"
}
```

The existing function returns 204 for OPTIONS and 405 for other methods. No
method returns patient records. Its CORS allows origin `*` and headers
`authorization, x-client-info, apikey, content-type`. This function must have a
working service database configuration: its existing connection setup/cleanup
errors are outside the best-effort logging catch.
