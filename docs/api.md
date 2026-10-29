# API reference

All endpoints are **Supabase Edge Functions** (Deno, TypeScript).  
Base URL: `https://<project-ref>.supabase.co/functions/v1`

Authentication: every call from the Lovable front end passes the Supabase **anon key** in the `Authorization: Bearer <key>` header. The functions run as `service_role` internally (they never expose patient-level data).

Statistical responses never contain patient-level records. Individual patient IDs, birth dates or diagnoses are only ever accessible inside the secure processing environment and cannot be retrieved through this API.

---

## `POST /requests`

Submit a health-data request. The function runs the full pipeline synchronously (Decision G — answers are fast; no job queue):

1. Validates the request JSON.
2. Parses the natural-language definitions into a `QueryPlan` (parser module).
3. Decides REJECT / APPROVE_STATISTICAL / APPROVE_SPE (decision module, Art. 54 / 53 / 66 / 68 / 73).
4. If approved as statistical: runs the query and applies the small-cell rule.
5. If approved as SPE: provisions the secure schema and copies the cohort.
6. Saves the request, decision and answer to Postgres (Decision H).
7. Returns the full result.

### Request body

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
  "purpose": "We study regional differences in type 2 diabetes…",
  "question": "How many adults have type 2 diabetes in each region?",
  "definitions": [
    "Adult = aged 18 or older on 31 December 2025.",
    "Type 2 diabetes = any condition with an ICD-10 code starting with E11.",
    "Prevalence = adults with type 2 diabetes / all adults in the region × 100, one decimal.",
    "Report per region: adults, adults with type 2 diabetes and the prevalence."
  ]
}
```

| Field | Type | Required |
|---|---|---|
| `id` | string | yes |
| `submitted` | ISO-8601 datetime string | yes |
| `applicant.name` | string | yes |
| `applicant.organisation` | string | yes |
| `applicant.country` | ISO-3166-1 alpha-2 | yes |
| `requested_as` | `"health data request"` \| `"health data access application"` | yes |
| `requested_format` | `"anonymised statistics"` \| `"pseudonymised records"` | yes |
| `purpose` | string | yes |
| `question` | string | yes |
| `definitions` | string[] | yes |

### Response — approved statistical (HTTP 200)

```json
{
  "request_id": "R01",
  "decision": "APPROVE_STATISTICAL",
  "articles": ["53", "69"],
  "reason": "Research and public health are allowed purposes (Art. 53). Statistics answer the question (Art. 69).",
  "answer": {
    "Wien": {
      "adults": 3247,
      "type2_diabetes": 263,
      "prevalence_pct": 8.1
    },
    "NiederAsterreich": {
      "adults": 2740,
      "type2_diabetes": 227,
      "prevalence_pct": 8.3
    }
  }
}
```

All groups appear in `answer`, even empty ones. Counts below 10 appear as `"<10"`. Suppressed values appear as `"suppressed"`.

### Response — approved SPE (HTTP 200)

```json
{
  "request_id": "R05",
  "decision": "APPROVE_SPE",
  "articles": ["53", "66", "68", "73"],
  "reason": "Training and testing algorithms is an allowed purpose (Art. 53). The model needs patient-level data, so pseudonymised data is justified (Art. 66). Access only under a data permit inside a secure processing environment (Art. 68, 73).",
  "answer": {
    "cohort_size": 1152
  },
  "spe_schema": "spe_r05"
}
```

`cohort_size` is the only number returned. The patient records themselves live in schema `spe_<request_id>` and are not accessible through this API.

### Response — rejected (HTTP 200)

The HTTP status is always 200; rejection is expressed in `decision`.

```json
{
  "request_id": "R02",
  "decision": "REJECT",
  "articles": ["54"],
  "reason": "Using health data to set insurance premiums is prohibited (Art. 54).",
  "answer": null
}
```

### Error responses

| HTTP status | When |
|---|---|
| `400 Bad Request` | Request body fails JSON parsing or required fields are missing |
| `500 Internal Server Error` | Unexpected engine error (details in server logs) |

---

## `GET /requests`

List all past requests. Intended for the staff view (Decision H).

### Query parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `limit` | integer | no | Maximum rows to return (default 50, max 200) |
| `offset` | integer | no | Pagination offset (default 0) |

### Response (HTTP 200)

```json
[
  {
    "request_id": "R01",
    "submitted": "2026-10-29T18:30:00+01:00",
    "applicant_name": "Dr. Sophie Lechner",
    "applicant_organisation": "Danube Institute for Diabetes Research",
    "decision": "APPROVE_STATISTICAL",
    "created_at": "2026-10-29T18:30:05.123Z"
  },
  {
    "request_id": "R02",
    "submitted": "2026-10-29T18:40:00+01:00",
    "applicant_name": "Markus Gruber",
    "applicant_organisation": "Alpenland Versicherung AG",
    "decision": "REJECT",
    "created_at": "2026-10-29T18:40:03.456Z"
  }
]
```

No patient-level data is returned. The full result of any request is fetched with `GET /requests/{id}`.

---

## `GET /requests/{id}`

Fetch the saved result of a single request.

### Path parameter

| Parameter | Description |
|---|---|
| `id` | The `request_id` of the saved request, e.g. `R01` |

### Response (HTTP 200)

Same shape as the `POST /requests` response for the same request:

```json
{
  "request_id": "R01",
  "decision": "APPROVE_STATISTICAL",
  "articles": ["53", "69"],
  "reason": "Research and public health are allowed purposes (Art. 53). Statistics answer the question (Art. 69).",
  "answer": {
    "Wien": { "adults": 3247, "type2_diabetes": 263, "prevalence_pct": 8.1 }
  }
}
```

### Error responses

| HTTP status | When |
|---|---|
| `404 Not Found` | No saved request with that ID |

---

## `GET /spe/{id}/download`

Attempt to download the patient records from a secure processing environment. **Always returns HTTP 403.** The attempt is logged (Decision E).

### Path parameter

| Parameter | Description |
|---|---|
| `id` | The `request_id` of an approved SPE request, e.g. `R05` |

### Response (HTTP 403)

```json
{
  "error": "Download is not permitted. This attempt has been logged.",
  "request_id": "R05"
}
```

This endpoint exists to satisfy the track requirement that the download block is visible in the demo. There is no HTTP status that returns actual records.

---

## Notes

- **No login** (Decision I). The Lovable UI has an applicant/staff role switch; no authentication token represents a user identity.
- **Synchronous** (Decision G). `POST /requests` blocks until the answer is ready. The target is under 60 seconds for all 10 requests.
- **Statistical responses only** contain aggregate numbers. The API never returns individual patient IDs, birth dates, diagnoses or any field from `patients`, `conditions`, `medications`, `observations` or `encounters`.
