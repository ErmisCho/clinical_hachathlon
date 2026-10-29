# Query-plan format

The **parser** reads a request JSON and produces a `QueryPlan` object.  
The **engine** consumes that object and generates SQL against the Supabase Postgres database.  
Nothing outside the engine ever writes SQL (Decision A).

The canonical TypeScript definition lives in
[`supabase/functions/_shared/plan.ts`](../supabase/functions/_shared/plan.ts).

The validator rejects **unknown fields** at every level — a typo such as
`condition_filtr` on a filter is an error, not silently ignored.

---

## Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `request_id` | `string` | yes | Originating request ID, e.g. `"R01"` |
| `cohort_filters` | `CohortFilter[]` | yes | Filters applied with logical AND; may be empty (all eligible patients) |
| `count_unit` | `"patient" \| "encounter"` | yes | What to count: distinct patients or distinct encounters |
| `dimensions` | `Grouping[]` | no | 1 or 2 grouping dimensions; absent means the whole cohort is one row |
| `metrics` | `Metric[]` | yes | One or more metrics to compute per group |
| `spe_record_types` | `RecordType[]` | no | For SPE requests: the record tables to copy into the secure schema |
| `spe_observation_loincs` | `string[]` | no | When `"observations"` is in `spe_record_types`: restrict copied observations to these LOINC codes. Must be non-empty when present. |

Every query starts from the `eligible_patients` view, which silently excludes opted-out patients (Decision C).

---

## Cohort filters

All filters in `cohort_filters` must be satisfied simultaneously (logical AND).

### `has_condition`

Keep patients that have at least one diagnosis whose ICD-10 code starts with one of the listed prefixes.

```jsonc
{ "type": "has_condition", "icd10_prefixes": ["E11"] }
```

| Field | Required | Notes |
|---|---|---|
| `icd10_prefixes` | yes | Non-empty array of strings; matches `conditions.icd10` |

---

### `has_medication`

Keep (or exclude) patients with an active prescription on 31 Dec 2025.  
A medication is _active_ when `start_date ≤ 2025-12-31` AND (`end_date` is NULL OR `end_date ≥ 2025-12-31`).

```jsonc
{
  "type": "has_medication",
  "atc_prefixes": ["B01AA", "B01AF"],
  "active_on_ref_date": true,
  "negate": true
}
```

| Field | Required | Notes |
|---|---|---|
| `atc_prefixes` | yes | Non-empty array; matches `medications.atc` |
| `active_on_ref_date` | yes | Always `true`; makes the rule explicit |
| `negate` | no | `true` → keep patients **without** such a medication |

---

### `age`

Keep patients whose age on 31 Dec 2025 is within `[min_age, max_age]`.  
Age = `2025 − birth_year`.

```jsonc
{ "type": "age", "min_age": 18 }
{ "type": "age", "min_age": 65, "max_age": 74 }
```

| Field | Required | Notes |
|---|---|---|
| `min_age` | yes | Non-negative integer, inclusive |
| `max_age` | no | Non-negative integer, inclusive; absent means no upper bound |

---

### `sex`

Keep patients of a specific sex.

```jsonc
{ "type": "sex", "value": "female" }
```

| Field | Required | Notes |
|---|---|---|
| `value` | yes | `"female"` or `"male"` |

---

### `region`

Keep patients who live in a specific region.

```jsonc
{ "type": "region", "value": "Oberösterreich" }
```

| Field | Required | Notes |
|---|---|---|
| `value` | yes | Non-empty UTF-8 string matching `patients.region` |

---

### `has_observation`

Keep patients who have at least one observation with the given LOINC code.

```jsonc
{ "type": "has_observation", "loinc": "4548-4" }
```

| Field | Required | Notes |
|---|---|---|
| `loinc` | yes | Non-empty string matching `observations.loinc` |

---

### `encounter_filter`

Filter encounters. All sub-fields are optional; they are combined with AND.  
Typically used together with `count_unit: "encounter"`.

```jsonc
{
  "type": "encounter_filter",
  "encounter_type": "inpatient",
  "start_year": 2025,
  "primary_icd10_prefix": "J44"
}
```

| Field | Required | Notes |
|---|---|---|
| `encounter_type` | no | `"inpatient"`, `"outpatient"`, or `"emergency"` |
| `start_year` | no | Four-digit year; keeps encounters where `start_date` falls in this year |
| `primary_icd10_prefix` | no | Matches `encounters.primary_icd10`; only populated on inpatient stays |

---

## Grouping dimensions

`dimensions` is a list of **1 or 2** grouping objects. When two dimensions are
given the output is a cross-tab (outer × inner). More than 2 is an error.

### `{ "by": "region" }`

One row per distinct value of `patients.region`.

### `{ "by": "data_holder" }`

One row per distinct value of `patients.data_holder` (or `encounters.data_holder`
when `count_unit` is `"encounter"`).

### `{ "by": "age_band", "bands": [...] }`

One row per explicitly-listed age band. Each band must appear in the output even
when empty (small-cell rule).

```jsonc
{
  "by": "age_band",
  "bands": [
    { "label": "65-74", "min_age": 65, "max_age": 74 },
    { "label": "75-84", "min_age": 75, "max_age": 84 },
    { "label": "85+",   "min_age": 85 }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `label` | yes | Output row key |
| `min_age` | yes | Non-negative integer, inclusive |
| `max_age` | no | Absent for open-ended band |

---

## Metrics

### `count`

Count distinct patients (or encounters when `count_unit` is `"encounter"`).

```jsonc
{ "type": "count", "label": "adults" }
```

The optional `filters` field sub-filters within the group's cohort (logical AND
on top of `cohort_filters`). This allows computing a sub-count alongside a wider
count in a single plan — for example, counting all adults AND the subset with
an E11 condition in the same per-region query (R01), or counting patients
without an active OAC within an AF cohort (R03).

```jsonc
{
  "type": "count",
  "label": "type2_diabetes",
  "filters": [{ "type": "has_condition", "icd10_prefixes": ["E11"] }]
}
```

```jsonc
{
  "type": "count",
  "label": "without_oac",
  "filters": [{
    "type": "has_medication",
    "atc_prefixes": ["B01AA", "B01AF"],
    "active_on_ref_date": true,
    "negate": true
  }]
}
```

| Field | Required | Notes |
|---|---|---|
| `label` | yes | Non-empty string |
| `filters` | no | Array of `CohortFilter`; all must be satisfied |

---

### `percentage`

`numerator ÷ denominator × 100`, rounded to one decimal.

`denominator_label` must match the `label` of a `count` metric in the same plan.

For the numerator, supply **exactly one** of:
- `numerator_label` — reference to an existing `count` metric label.
- `numerator_filters` — inline `CohortFilter[]` applied to the denominator
  cohort to compute the numerator count on the fly, without a separate named
  count metric. Used in R09 for ACE inhibitor and ARB percentages.

Supplying both or neither is a validation error.

```jsonc
{
  "type": "percentage",
  "label": "prevalence_pct",
  "numerator_label": "type2_diabetes",
  "denominator_label": "adults"
}
```

```jsonc
{
  "type": "percentage",
  "label": "ace_inhibitor_pct",
  "numerator_filters": [{
    "type": "has_medication",
    "atc_prefixes": ["C09AA"],
    "active_on_ref_date": true
  }],
  "denominator_label": "adults_with_hypertension"
}
```

If numerator or denominator count is below 10, the output is `"suppressed"`
(small-cell rule).

---

### `mean_observation`

Mean of observations for a LOINC code across the cohort.  
`use_latest: true` (required) means: for each patient take only their
most-recent observation row before computing the mean.

```jsonc
{
  "type": "mean_observation",
  "label": "mean_hba1c",
  "loinc": "4548-4",
  "use_latest": true
}
```

| Field | Required | Notes |
|---|---|---|
| `label` | yes | Non-empty string |
| `loinc` | yes | Non-empty LOINC code |
| `use_latest` | yes | Always `true`; makes the intent explicit |

Patients without any observation for the code are excluded from the mean.  
If fewer than 10 patients have a value, the output is `"suppressed"` (small-cell rule).

---

## SPE record types

When `spe_record_types` is present the request is an SPE. The engine copies
only the selected patients' rows from the listed tables into a dedicated Postgres
schema. The browser role cannot read it; any download attempt returns HTTP 403
(Decision E).

Valid values: `"conditions"`, `"medications"`, `"observations"`, `"encounters"`.

## SPE observation filter (`spe_observation_loincs`)

When `"observations"` is listed in `spe_record_types`, the optional
`spe_observation_loincs` field restricts which observation rows are copied into
the secure schema to only those whose `loinc` column matches one of the listed
codes. Absent means all observation rows for the cohort are copied.

Must be a **non-empty array of strings** when present.

```jsonc
{
  "spe_record_types": ["conditions", "medications", "observations"],
  "spe_observation_loincs": ["4548-4"]
}
```

| Field | Required | Notes |
|---|---|---|
| `spe_observation_loincs` | no | Non-empty `string[]`; filters observations by LOINC when present |

---

## Small-cell rule (Decision B)

Applied by the engine to every output row:

- Counts **below 10** (including 0) are replaced with `"<10"`.
- A percentage or mean is replaced with `"suppressed"` when its count is below 10.
- All requested groups appear in the output, even empty ones.
- Round to one decimal; halves round up.

---

## Unknown-field rejection

The validator reports an error for every key not listed in the type. For example:

```json
{ "type": "has_condition", "icd10_prefixes": ["E11"], "condition_filtr": true }
```

produces:

```json
{ "path": "$.cohort_filters[0].condition_filtr", "message": "unknown field \"condition_filtr\"" }
```

---

## Worked example — R01

**Request:** How many adults have type 2 diabetes in each region and what is the prevalence?

```json
{
  "request_id": "R01",
  "cohort_filters": [
    { "type": "age", "min_age": 18 }
  ],
  "count_unit": "patient",
  "dimensions": [{ "by": "region" }],
  "metrics": [
    { "type": "count", "label": "adults" },
    {
      "type": "count",
      "label": "type2_diabetes",
      "filters": [{ "type": "has_condition", "icd10_prefixes": ["E11"] }]
    },
    {
      "type": "percentage",
      "label": "prevalence_pct",
      "numerator_label": "type2_diabetes",
      "denominator_label": "adults"
    }
  ]
}
```

**How the engine reads it:**

1. Start from `eligible_patients` (no opted-out patients).
2. Apply `age ≥ 18` on 31 Dec 2025.
3. Group by `patients.region`.
4. Per region: count all patients → `adults`; count the subset that also has any
   E11 condition → `type2_diabetes`; compute the ratio → `prevalence_pct`.
5. Apply small-cell suppression.

**Example output row:**

```json
{
  "Wien": {
    "adults": 3247,
    "type2_diabetes": 263,
    "prevalence_pct": 8.1
  }
}
```

---

## Worked example — R10 (cross-tab)

R10 uses two dimensions: `age_band` (outer) × `region` (inner).

```json
{
  "request_id": "R10",
  "cohort_filters": [
    { "type": "has_condition", "icd10_prefixes": ["J44"] }
  ],
  "count_unit": "patient",
  "dimensions": [
    { "by": "age_band", "bands": [{ "label": "50-59", "min_age": 50, "max_age": 59 }, "..."] },
    { "by": "region" }
  ],
  "metrics": [{ "type": "count", "label": "copd_patients" }]
}
```

The engine produces one row per `(age_band, region)` pair.

---

## Validator

[`validatePlan(raw: unknown)`](../supabase/functions/_shared/plan.ts) returns:

```ts
{ ok: true; plan: QueryPlan }
// or
{ ok: false; errors: Array<{ path: string; message: string }> }
```

`path` uses `$` dot-notation (e.g. `$.cohort_filters[0].icd10_prefixes`).  
No external libraries. Suitable for Deno edge functions.

---

## Extra features (not in R01-R10)

Demonstrated in [`plan_examples.ts`](../supabase/functions/_shared/plan_examples.ts):

| Plan | Feature |
|---|---|
| `EX_INPATIENT_ICD10` | `encounter_filter` with `primary_icd10_prefix` |
| `EX_GROUP_DATA_HOLDER` | `dimensions: [{ by: "data_holder" }]` |

---

## What the format cannot currently express

- **More than two grouping dimensions.** Three-way cross-tabs are not supported.
- **OR logic between cohort filters.** All filters are AND-combined; there is no
  union or disjunction at the plan level.
- **Observations as a cohort qualifier with a value threshold** (e.g. "HbA1c > 8%").
  The `has_observation` filter only checks presence; value-based selection must be
  handled by the engine outside the plan.
- **Date-range filters on conditions** (e.g. "onset in the last 5 years"). There
  is no `onset_date` range in `HasCondition`.
- **Multiple LOINC codes** in a single `mean_observation` or `has_observation`.
  Each observation filter targets exactly one LOINC code.
