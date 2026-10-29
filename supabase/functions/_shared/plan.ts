/**
 * Query-plan types and runtime validator.
 *
 * The parser produces a QueryPlan; the engine turns it into SQL.
 * No SQL is ever written by the parser (Decision A).
 */

// ---------------------------------------------------------------------------
// Cohort filters
// ---------------------------------------------------------------------------

/** Keep patients that have at least one condition whose ICD-10 code starts with
 *  one of the listed prefixes. */
export interface HasCondition {
  type: "has_condition";
  icd10_prefixes: string[]; // e.g. ["E11"]
}

/** Keep patients that have (or lack) an active medication on the reference date.
 *  A medication is active when start_date <= 2025-12-31 AND
 *  (end_date is null OR end_date >= 2025-12-31). */
export interface HasMedication {
  type: "has_medication";
  atc_prefixes: string[]; // e.g. ["B01AA", "B01AF"]
  active_on_ref_date: true; // always true; present to make the rule explicit
  negate?: boolean; // true => keep patients WITHOUT such a medication
}

/** Keep patients whose age on 31 Dec 2025 is within [min_age, max_age].
 *  Age = 2025 − birth_year. Omit max_age for open-ended bands (80+). */
export interface AgeFilter {
  type: "age";
  min_age: number;
  max_age?: number; // inclusive; absent means no upper bound
}

/** Keep patients of a specific sex. */
export interface SexFilter {
  type: "sex";
  value: "female" | "male";
}

/** Keep patients who live in a specific region. */
export interface RegionFilter {
  type: "region";
  value: string; // e.g. "Oberösterreich"
}

/** Keep patients who have at least one observation with the given LOINC code. */
export interface HasObservation {
  type: "has_observation";
  loinc: string; // e.g. "4548-4"
}

/** Filter encounters (used together with count_unit: "encounter") by
 *  encounter type, date range, or primary_icd10 prefix. */
export interface EncounterFilter {
  type: "encounter_filter";
  encounter_type?: "inpatient" | "outpatient" | "emergency";
  start_year?: number; // keep encounters where start_date year = this
  primary_icd10_prefix?: string; // e.g. "J44" — matches encounters.primary_icd10
}

export type CohortFilter =
  | HasCondition
  | HasMedication
  | AgeFilter
  | SexFilter
  | RegionFilter
  | HasObservation
  | EncounterFilter;

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** Count distinct patients (or encounters when count_unit is "encounter").
 *
 *  Optional `filters` sub-filter within the group's base cohort using logical
 *  AND. This allows computing a sub-count (e.g. "adults with E11") alongside
 *  a wider count (e.g. "all adults") in the same plan without requiring a
 *  separate cohort query. */
export interface CountMetric {
  type: "count";
  label: string;
  /** Additional filters applied on top of the group's cohort to select the
   *  subset to count. All must be satisfied (logical AND). */
  filters?: CohortFilter[];
}

/** Percentage = numerator / denominator × 100, one decimal.
 *
 *  `denominator_label` must match the `label` of a CountMetric in the same
 *  plan. Instead of also requiring a named CountMetric for the numerator, a
 *  `numerator_filters` list may be supplied: the numerator count is then
 *  computed by applying those filters on top of the denominator cohort.
 *
 *  Exactly one of `numerator_label` or `numerator_filters` must be present. */
export interface PercentageMetric {
  type: "percentage";
  label: string;
  /** Reference to a CountMetric label when the numerator is already computed
   *  as a separate count. */
  numerator_label?: string;
  /** Inline filters applied to the denominator cohort to compute the
   *  numerator count without a separate named CountMetric. */
  numerator_filters?: CohortFilter[];
  denominator_label: string;
}

/** Mean of observations for a given LOINC code across the cohort.
 *
 *  `use_latest: true` (required) means: for each patient take only their
 *  most-recent observation row before computing the mean.  This is the only
 *  supported aggregation strategy; the field is explicit so the intent is
 *  unambiguous. */
export interface MeanObservationMetric {
  type: "mean_observation";
  label: string;
  loinc: string; // e.g. "4548-4"
  use_latest: true; // always true; take the latest value per patient
}

export type Metric = CountMetric | PercentageMetric | MeanObservationMetric;

// ---------------------------------------------------------------------------
// Grouping dimensions
// ---------------------------------------------------------------------------

/** Break output into per-region rows. */
export interface RegionGroup {
  by: "region";
}

/** Break output into age-band rows. */
export interface AgeBandGroup {
  by: "age_band";
  bands: AgeBand[];
}

export interface AgeBand {
  label: string; // e.g. "65-74"
  min_age: number;
  max_age?: number; // absent for open-ended band (85+)
}

/** Break output by data_holder (hospital). */
export interface DataHolderGroup {
  by: "data_holder";
}

export type Grouping = RegionGroup | AgeBandGroup | DataHolderGroup;

// ---------------------------------------------------------------------------
// Record types for an SPE
// ---------------------------------------------------------------------------

export type RecordType =
  | "conditions"
  | "medications"
  | "observations"
  | "encounters";

// ---------------------------------------------------------------------------
// Root query plan
// ---------------------------------------------------------------------------

export interface QueryPlan {
  /** Originating request ID, e.g. "R01". */
  request_id: string;

  /** Base cohort filters — ALL must be satisfied (logical AND).
   *  Every query implicitly starts from the eligible_patients view (Decision C). */
  cohort_filters: CohortFilter[];

  /** What to count: "patient" (default) or "encounter". */
  count_unit: "patient" | "encounter";

  /** One or two grouping dimensions. When two are given the output is a
   *  cross-tab (e.g. age_band × region for R10). The first dimension is the
   *  outer key; the second is the inner key. */
  dimensions?: Grouping[];

  /** Metrics to compute for each group (or for the whole cohort if no
   *  dimensions). */
  metrics: Metric[];

  /** For SPE requests: the record tables to copy into the secure schema.
   *  Absent for statistical requests. */
  spe_record_types?: RecordType[];
}

// ---------------------------------------------------------------------------
// Runtime validator — no external libraries
// ---------------------------------------------------------------------------

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: true;
  plan: QueryPlan;
}

export interface ValidationFailure {
  ok: false;
  errors: ValidationError[];
}

function err(path: string, message: string): ValidationError {
  return { path, message };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

function isStringArray(v: unknown, path: string): ValidationError[] {
  if (!isArray(v)) return [err(path, "must be an array")];
  const errs: ValidationError[] = [];
  (v as unknown[]).forEach((item, i) => {
    if (!isString(item)) errs.push(err(`${path}[${i}]`, "must be a string"));
  });
  return errs;
}

/** Report any keys in `obj` that are not in `allowed`. */
function unknownFields(
  obj: Record<string, unknown>,
  allowed: string[],
  path: string,
): ValidationError[] {
  return Object.keys(obj)
    .filter((k) => !allowed.includes(k))
    .map((k) => err(`${path}.${k}`, `unknown field "${k}"`));
}

function validateCohortFilter(
  v: unknown,
  path: string,
): ValidationError[] {
  if (!isObject(v)) return [err(path, "must be an object")];
  const errs: ValidationError[] = [];
  const type = v["type"];
  if (!isString(type)) {
    return [err(`${path}.type`, "must be a string")];
  }

  if (type === "has_condition") {
    errs.push(...unknownFields(v, ["type", "icd10_prefixes"], path));
    errs.push(...isStringArray(v["icd10_prefixes"], `${path}.icd10_prefixes`));
    if (
      isArray(v["icd10_prefixes"]) &&
      (v["icd10_prefixes"] as unknown[]).length === 0
    ) {
      errs.push(err(`${path}.icd10_prefixes`, "must not be empty"));
    }
  } else if (type === "has_medication") {
    errs.push(
      ...unknownFields(
        v,
        ["type", "atc_prefixes", "active_on_ref_date", "negate"],
        path,
      ),
    );
    errs.push(...isStringArray(v["atc_prefixes"], `${path}.atc_prefixes`));
    if (
      isArray(v["atc_prefixes"]) &&
      (v["atc_prefixes"] as unknown[]).length === 0
    ) {
      errs.push(err(`${path}.atc_prefixes`, "must not be empty"));
    }
    if (v["active_on_ref_date"] !== true) {
      errs.push(err(`${path}.active_on_ref_date`, "must be true"));
    }
    if (v["negate"] !== undefined && !isBoolean(v["negate"])) {
      errs.push(err(`${path}.negate`, "must be boolean if present"));
    }
  } else if (type === "age") {
    errs.push(...unknownFields(v, ["type", "min_age", "max_age"], path));
    if (!isNumber(v["min_age"]) || (v["min_age"] as number) < 0) {
      errs.push(err(`${path}.min_age`, "must be a non-negative number"));
    }
    if (
      v["max_age"] !== undefined &&
      (!isNumber(v["max_age"]) || (v["max_age"] as number) < 0)
    ) {
      errs.push(
        err(`${path}.max_age`, "must be a non-negative number if present"),
      );
    }
  } else if (type === "sex") {
    errs.push(...unknownFields(v, ["type", "value"], path));
    if (v["value"] !== "female" && v["value"] !== "male") {
      errs.push(err(`${path}.value`, 'must be "female" or "male"'));
    }
  } else if (type === "region") {
    errs.push(...unknownFields(v, ["type", "value"], path));
    if (!isString(v["value"]) || v["value"] === "") {
      errs.push(err(`${path}.value`, "must be a non-empty string"));
    }
  } else if (type === "has_observation") {
    errs.push(...unknownFields(v, ["type", "loinc"], path));
    if (!isString(v["loinc"]) || v["loinc"] === "") {
      errs.push(err(`${path}.loinc`, "must be a non-empty string"));
    }
  } else if (type === "encounter_filter") {
    errs.push(
      ...unknownFields(
        v,
        ["type", "encounter_type", "start_year", "primary_icd10_prefix"],
        path,
      ),
    );
    const validEncTypes = ["inpatient", "outpatient", "emergency"];
    if (
      v["encounter_type"] !== undefined &&
      !validEncTypes.includes(v["encounter_type"] as string)
    ) {
      errs.push(
        err(
          `${path}.encounter_type`,
          'must be "inpatient", "outpatient", or "emergency"',
        ),
      );
    }
    if (
      v["start_year"] !== undefined &&
      (!isNumber(v["start_year"]) || (v["start_year"] as number) < 1900)
    ) {
      errs.push(err(`${path}.start_year`, "must be a valid year number"));
    }
    if (
      v["primary_icd10_prefix"] !== undefined &&
      (!isString(v["primary_icd10_prefix"]) || v["primary_icd10_prefix"] === "")
    ) {
      errs.push(
        err(
          `${path}.primary_icd10_prefix`,
          "must be a non-empty string if present",
        ),
      );
    }
  } else {
    errs.push(err(`${path}.type`, `unknown filter type: "${type}"`));
  }
  return errs;
}

function validateCohortFilterList(
  v: unknown,
  path: string,
): ValidationError[] {
  if (!isArray(v)) return [err(path, "must be an array")];
  const errs: ValidationError[] = [];
  (v as unknown[]).forEach((f, i) => {
    errs.push(...validateCohortFilter(f, `${path}[${i}]`));
  });
  return errs;
}

function validateMetric(v: unknown, path: string): ValidationError[] {
  if (!isObject(v)) return [err(path, "must be an object")];
  const errs: ValidationError[] = [];
  const type = v["type"];
  if (!isString(type)) return [err(`${path}.type`, "must be a string")];

  if (type === "count") {
    errs.push(...unknownFields(v, ["type", "label", "filters"], path));
    if (!isString(v["label"]) || v["label"] === "") {
      errs.push(err(`${path}.label`, "must be a non-empty string"));
    }
    if (v["filters"] !== undefined) {
      errs.push(...validateCohortFilterList(v["filters"], `${path}.filters`));
    }
  } else if (type === "percentage") {
    errs.push(
      ...unknownFields(
        v,
        [
          "type",
          "label",
          "numerator_label",
          "numerator_filters",
          "denominator_label",
        ],
        path,
      ),
    );
    if (!isString(v["label"]) || v["label"] === "") {
      errs.push(err(`${path}.label`, "must be a non-empty string"));
    }
    if (!isString(v["denominator_label"]) || v["denominator_label"] === "") {
      errs.push(err(`${path}.denominator_label`, "must be a non-empty string"));
    }
    const hasNumeratorLabel =
      isString(v["numerator_label"]) && v["numerator_label"] !== "";
    const hasNumeratorFilters =
      v["numerator_filters"] !== undefined && isArray(v["numerator_filters"]);
    if (!hasNumeratorLabel && !hasNumeratorFilters) {
      errs.push(
        err(
          `${path}.numerator_label`,
          "exactly one of numerator_label or numerator_filters must be present",
        ),
      );
    }
    if (hasNumeratorLabel && hasNumeratorFilters) {
      errs.push(
        err(
          `${path}.numerator_label`,
          "numerator_label and numerator_filters are mutually exclusive",
        ),
      );
    }
    if (v["numerator_filters"] !== undefined) {
      errs.push(
        ...validateCohortFilterList(
          v["numerator_filters"],
          `${path}.numerator_filters`,
        ),
      );
    }
  } else if (type === "mean_observation") {
    errs.push(
      ...unknownFields(v, ["type", "label", "loinc", "use_latest"], path),
    );
    if (!isString(v["label"]) || v["label"] === "") {
      errs.push(err(`${path}.label`, "must be a non-empty string"));
    }
    if (!isString(v["loinc"]) || v["loinc"] === "") {
      errs.push(err(`${path}.loinc`, "must be a non-empty string"));
    }
    if (v["use_latest"] !== true) {
      errs.push(err(`${path}.use_latest`, "must be true"));
    }
  } else {
    errs.push(err(`${path}.type`, `unknown metric type: "${type}"`));
  }
  return errs;
}

function validateGrouping(v: unknown, path: string): ValidationError[] {
  if (!isObject(v)) return [err(path, "must be an object")];
  const errs: ValidationError[] = [];
  const by = v["by"];
  if (!isString(by)) return [err(`${path}.by`, "must be a string")];

  if (by === "region") {
    errs.push(...unknownFields(v, ["by"], path));
  } else if (by === "data_holder") {
    errs.push(...unknownFields(v, ["by"], path));
  } else if (by === "age_band") {
    errs.push(...unknownFields(v, ["by", "bands"], path));
    if (!isArray(v["bands"]) || (v["bands"] as unknown[]).length === 0) {
      errs.push(err(`${path}.bands`, "must be a non-empty array"));
    } else {
      (v["bands"] as unknown[]).forEach((band, i) => {
        const bp = `${path}.bands[${i}]`;
        if (!isObject(band)) {
          errs.push(err(bp, "must be an object"));
          return;
        }
        errs.push(...unknownFields(band, ["label", "min_age", "max_age"], bp));
        if (!isString(band["label"]) || band["label"] === "") {
          errs.push(err(`${bp}.label`, "must be a non-empty string"));
        }
        if (!isNumber(band["min_age"]) || (band["min_age"] as number) < 0) {
          errs.push(err(`${bp}.min_age`, "must be a non-negative number"));
        }
        if (
          band["max_age"] !== undefined &&
          (!isNumber(band["max_age"]) || (band["max_age"] as number) < 0)
        ) {
          errs.push(
            err(`${bp}.max_age`, "must be a non-negative number if present"),
          );
        }
      });
    }
  } else {
    errs.push(err(`${path}.by`, `unknown grouping: "${by}"`));
  }
  return errs;
}

/** Validate an unknown value as a QueryPlan.
 *  Returns the typed plan on success, or a list of errors on failure. */
export function validatePlan(
  raw: unknown,
): ValidationResult | ValidationFailure {
  const errs: ValidationError[] = [];

  if (!isObject(raw)) {
    return { ok: false, errors: [err("$", "plan must be an object")] };
  }

  // Unknown top-level fields
  errs.push(
    ...unknownFields(
      raw,
      [
        "request_id",
        "cohort_filters",
        "count_unit",
        "dimensions",
        "metrics",
        "spe_record_types",
      ],
      "$",
    ),
  );

  // request_id
  if (!isString(raw["request_id"]) || raw["request_id"] === "") {
    errs.push(err("$.request_id", "must be a non-empty string"));
  }

  // cohort_filters
  if (!isArray(raw["cohort_filters"])) {
    errs.push(err("$.cohort_filters", "must be an array"));
  } else {
    errs.push(
      ...validateCohortFilterList(raw["cohort_filters"], "$.cohort_filters"),
    );
  }

  // count_unit
  if (raw["count_unit"] !== "patient" && raw["count_unit"] !== "encounter") {
    errs.push(err("$.count_unit", 'must be "patient" or "encounter"'));
  }

  // dimensions (optional array of 1 or 2 groupings)
  if (raw["dimensions"] !== undefined) {
    if (!isArray(raw["dimensions"])) {
      errs.push(err("$.dimensions", "must be an array"));
    } else {
      const dims = raw["dimensions"] as unknown[];
      if (dims.length === 0 || dims.length > 2) {
        errs.push(err("$.dimensions", "must have 1 or 2 elements"));
      } else {
        dims.forEach((d, i) => {
          errs.push(...validateGrouping(d, `$.dimensions[${i}]`));
        });
      }
    }
  }

  // metrics
  if (!isArray(raw["metrics"]) || (raw["metrics"] as unknown[]).length === 0) {
    errs.push(err("$.metrics", "must be a non-empty array"));
  } else {
    (raw["metrics"] as unknown[]).forEach((m, i) => {
      errs.push(...validateMetric(m, `$.metrics[${i}]`));
    });
  }

  // spe_record_types (optional)
  const validRecordTypes: string[] = [
    "conditions",
    "medications",
    "observations",
    "encounters",
  ];
  if (raw["spe_record_types"] !== undefined) {
    if (!isArray(raw["spe_record_types"])) {
      errs.push(err("$.spe_record_types", "must be an array if present"));
    } else {
      (raw["spe_record_types"] as unknown[]).forEach((rt, i) => {
        if (!isString(rt) || !validRecordTypes.includes(rt)) {
          errs.push(
            err(
              `$.spe_record_types[${i}]`,
              `must be one of: ${validRecordTypes.join(", ")}`,
            ),
          );
        }
      });
    }
  }

  if (errs.length > 0) return { ok: false, errors: errs };
  return { ok: true, plan: raw as unknown as QueryPlan };
}
