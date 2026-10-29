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
patient data), then parsing, then aggregate execution or SPE creation. Saves the
complete submitted JSON and pipeline response in `public.request_log` before
returning HTTP 200. Every successful submission creates a new row, even when the
request id has been submitted before. Invalid HTTP input is not saved; execution
or persistence failure returns HTTP 500 without a successful result.

The body must be a JSON object with nonempty string fields `id`, `requested_as`,
and `purpose`. If provided, `question` must be a string and `definitions` must
be an array of strings. Other metadata is preserved but not validated by the
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

| Field          | Shape                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------- |
| `request_id`   | Submitted `id`                                                                           |
| `decision`     | `REJECT`, `APPROVE_STATISTICAL`, or `APPROVE_SPE`                                        |
| `articles`     | Array of article number strings                                                          |
| `reason`       | Explanation string                                                                       |
| `needs_review` | Boolean; also true for parse failures                                                    |
| `answer`       | Aggregate object, SPE `{ "cohort_size": number }`, or `null` for rejection/parse failure |
| `spe_schema`   | Present only for successful SPE creation, e.g. `spe_r05`                                 |
| `parse_errors` | Present for parse failure: array of `{ "definition": string, "reason": string }`         |

Example statistical result (values illustrative):

```json
{
  "request_id": "R01",
  "decision": "APPROVE_STATISTICAL",
  "articles": ["53", "69"],
  "reason": "Your purpose is an allowed use of health data (Art. 53). Anonymised statistics are sufficient to answer the question (Art. 69).",
  "needs_review": false,
  "answer": {
    "Wien": { "cohort": 263 },
    "Tirol": { "cohort": "<10" }
  }
}
```

Statistical answers contain aggregate numbers only. Counts below 10 (including
zero) are `"<10"`; unsafe means/percentages are `"suppressed"`. Empty groups are
included. SPE responses contain only the cohort size and schema name, never
patient records. Rejection is an HTTP 200 result with `decision: "REJECT"` and
`answer: null`.

## `GET /requests?id=R01` or `GET /requests/R01`

Returns the latest saved pipeline response for the request id, with the same
shape as POST. URL-encode ids. The query parameter takes precedence over the
trailing path segment if both are supplied. Rows are ordered by `submitted_at`
descending, then database row `id` descending to break ties.

Returns HTTP 404 with `{ "error": "request not found" }` if no result exists. An
empty/whitespace query id or malformed percent encoding in a path id returns
HTTP 400. Both `/requests` and `/requests/` are accepted.

## `GET /requests`

Without an id, returns all submission history and the blocked-download log, each
newest first (timestamp descending, then database row id descending). There is
no pagination; `limit` and `offset` have no effect. Repeated request ids appear
once per saved submission.

```json
{
  "requests": [
    {
      "request_id": "R05",
      "submitted_at": "2026-10-29T18:30:05.123Z",
      "decision": "APPROVE_SPE",
      "articles": ["53", "66", "68", "73"],
      "needs_review": false,
      "spe_schema": "spe_r05"
    },
    {
      "request_id": "R01",
      "submitted_at": "2026-10-29T18:29:05.123Z",
      "decision": "APPROVE_STATISTICAL",
      "articles": ["53", "69"],
      "needs_review": false,
      "spe_schema": null
    }
  ],
  "downloads": [
    {
      "request_id": "R05",
      "attempted_at": "2026-10-29T18:31:00.123Z"
    }
  ]
}
```

`submitted_at` is the server's save timestamp, not the submitted request's
`submitted` metadata. `spe_schema` is null when absent. Empty history returns
`{ "requests": [], "downloads": [] }`. The overview never contains answers,
request bodies, applicant metadata, patient data, or download user agents.

## Errors from `requests`

| Status | Meaning                                                                                                              |
| ------ | -------------------------------------------------------------------------------------------------------------------- |
| 400    | Malformed JSON, non-object body, missing/invalid required string, invalid question/definitions, or invalid lookup id |
| 404    | Unknown route or no saved result for the id                                                                          |
| 405    | Unsupported HTTP method, or POST to a result-id path                                                                 |
| 500    | Database connection, pipeline, or history read/write failure                                                         |

Errors use `{ "error": "message" }`. Internal failures always return
`{ "error": "internal server error" }`; exception text and stack traces are
never returned.

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
