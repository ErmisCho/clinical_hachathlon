/**
 * Deno tests for the query-plan validator.
 * No remote imports — only local assert helper style (same as patients_test.ts).
 */
import { validatePlan } from "./plan.ts";
import { ALL_EXAMPLES, R01, R02, R03, R06, R07, R08, R09, R10 } from "./plan_examples.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// All example plans must pass validation
// ---------------------------------------------------------------------------

Deno.test("all example plans validate without errors", () => {
  for (const plan of ALL_EXAMPLES) {
    const result = validatePlan(plan);
    if (!result.ok) {
      const msgs = result.errors.map((e) => `${e.path}: ${e.message}`).join(
        "\n",
      );
      throw new Error(`Plan ${plan.request_id} failed validation:\n${msgs}`);
    }
    assert(result.plan.request_id === plan.request_id, "request_id round-trips");
  }
});

// ---------------------------------------------------------------------------
// Structural invariants on example plans
// ---------------------------------------------------------------------------

Deno.test("every example plan has at least one metric", () => {
  for (const plan of ALL_EXAMPLES) {
    assert(
      plan.metrics.length > 0,
      `${plan.request_id} must have at least one metric`,
    );
  }
});

Deno.test("R07 and EX_INPATIENT_ICD10 use count_unit encounter", () => {
  const r07 = ALL_EXAMPLES.find((p) => p.request_id === "R07");
  assert(r07 !== undefined, "R07 not found");
  assert(r07.count_unit === "encounter", "R07 must count encounters");

  const ex = ALL_EXAMPLES.find((p) => p.request_id === "EX_INPATIENT_ICD10");
  assert(ex !== undefined, "EX_INPATIENT_ICD10 not found");
  assert(ex.count_unit === "encounter", "EX_INPATIENT_ICD10 must count encounters");
});

Deno.test("SPE plans declare spe_record_types", () => {
  const r05 = ALL_EXAMPLES.find((p) => p.request_id === "R05");
  assert(r05 !== undefined, "R05 not found");
  assert(
    Array.isArray(r05.spe_record_types) && r05.spe_record_types.length > 0,
    "R05 must declare spe_record_types",
  );

  const r06 = ALL_EXAMPLES.find((p) => p.request_id === "R06");
  assert(r06 !== undefined, "R06 not found");
  assert(
    Array.isArray(r06.spe_record_types) && r06.spe_record_types.length > 0,
    "R06 must declare spe_record_types",
  );
});

Deno.test("EX_GROUP_DATA_HOLDER groups by data_holder", () => {
  const ex = ALL_EXAMPLES.find((p) => p.request_id === "EX_GROUP_DATA_HOLDER");
  assert(ex !== undefined, "EX_GROUP_DATA_HOLDER not found");
  assert(
    Array.isArray(ex.dimensions) && ex.dimensions.length > 0,
    "must have dimensions",
  );
  assert(ex.dimensions![0].by === "data_holder", "must group by data_holder");
});

Deno.test("EX_INPATIENT_ICD10 has encounter_filter with primary_icd10_prefix", () => {
  const ex = ALL_EXAMPLES.find((p) => p.request_id === "EX_INPATIENT_ICD10");
  assert(ex !== undefined, "EX_INPATIENT_ICD10 not found");
  const ef = ex.cohort_filters.find((f) => f.type === "encounter_filter");
  assert(ef !== undefined, "must have encounter_filter");
  // EncounterFilter has primary_icd10_prefix as an optional field — access directly
  assert(
    ef.type === "encounter_filter" && ef.primary_icd10_prefix !== undefined,
    "encounter_filter must have primary_icd10_prefix",
  );
});

// ---------------------------------------------------------------------------
// New fields introduced in the revision
// ---------------------------------------------------------------------------

Deno.test("R01 type2_diabetes count has a filters array with has_condition", () => {
  const countMetric = R01.metrics.find(
    (m) => m.type === "count" && m.label === "type2_diabetes",
  );
  assert(countMetric !== undefined, "type2_diabetes count not found");
  assert(countMetric.type === "count", "must be a count metric");
  assert(
    Array.isArray(countMetric.filters) && countMetric.filters.length > 0,
    "must have filters",
  );
  assert(
    countMetric.filters![0].type === "has_condition",
    "filter must be has_condition",
  );
});

Deno.test("R03 without_oac count has a negated has_medication filter", () => {
  const m = R03.metrics.find(
    (m) => m.type === "count" && m.label === "without_oac",
  );
  assert(m !== undefined, "without_oac count not found");
  assert(m.type === "count", "must be a count metric");
  assert(Array.isArray(m.filters) && m.filters.length > 0, "must have filters");
  const medFilter = m.filters![0];
  assert(medFilter.type === "has_medication", "filter must be has_medication");
  assert(medFilter.negate === true, "filter must be negated");
});

Deno.test("R07 count uses encounter unit (stays, not patients)", () => {
  assert(R07.count_unit === "encounter", "R07 must count encounters");
  const m = R07.metrics.find((m) => m.label === "inpatient_stays");
  assert(m !== undefined, "inpatient_stays metric not found");
});

Deno.test("R08 and R02 mean_observation metrics have use_latest true", () => {
  const r02Mean = R02.metrics.find((m) => m.type === "mean_observation");
  assert(r02Mean !== undefined, "R02 mean_observation not found");
  assert(r02Mean.type === "mean_observation", "type guard");
  assert(r02Mean.use_latest === true, "R02 must have use_latest: true");

  const r08Mean = R08.metrics.find((m) => m.type === "mean_observation");
  assert(r08Mean !== undefined, "R08 mean_observation not found");
  assert(r08Mean.type === "mean_observation", "type guard");
  assert(r08Mean.use_latest === true, "R08 must have use_latest: true");
});

Deno.test("R09 percentage metrics use numerator_filters (no separate count)", () => {
  const aceMetric = R09.metrics.find(
    (m) => m.type === "percentage" && m.label === "ace_inhibitor_pct",
  );
  assert(aceMetric !== undefined, "ace_inhibitor_pct not found");
  assert(aceMetric.type === "percentage", "type guard");
  assert(
    Array.isArray(aceMetric.numerator_filters) &&
      aceMetric.numerator_filters.length > 0,
    "ace_inhibitor_pct must have numerator_filters",
  );
  assert(
    aceMetric.numerator_label === undefined,
    "ace_inhibitor_pct must not have numerator_label",
  );

  const arbMetric = R09.metrics.find(
    (m) => m.type === "percentage" && m.label === "arb_pct",
  );
  assert(arbMetric !== undefined, "arb_pct not found");
  assert(arbMetric.type === "percentage", "type guard");
  assert(
    Array.isArray(arbMetric.numerator_filters) &&
      arbMetric.numerator_filters.length > 0,
    "arb_pct must have numerator_filters",
  );
});

Deno.test("R10 has two dimensions (age_band then region)", () => {
  assert(
    Array.isArray(R10.dimensions) && R10.dimensions.length === 2,
    "R10 must have 2 dimensions",
  );
  assert(R10.dimensions![0].by === "age_band", "first dimension must be age_band");
  assert(R10.dimensions![1].by === "region", "second dimension must be region");
});

Deno.test("R06 region filter uses Oberösterreich (UTF-8)", () => {
  const regionFilter = R06.cohort_filters.find((f) => f.type === "region");
  assert(regionFilter !== undefined, "region filter not found");
  assert(regionFilter.type === "region", "type guard");
  assert(
    regionFilter.value === "Oberösterreich",
    `expected "Oberösterreich", got "${regionFilter.value}"`,
  );
});

// ---------------------------------------------------------------------------
// Malformed plans are rejected
// ---------------------------------------------------------------------------

Deno.test("missing request_id is rejected", () => {
  const bad = {
    cohort_filters: [],
    count_unit: "patient",
    metrics: [{ type: "count", label: "n" }],
  };
  const r = validatePlan(bad);
  assert(!r.ok, "must fail");
  assert(
    r.errors.some((e) => e.path === "$.request_id"),
    "error must mention request_id",
  );
});

Deno.test("invalid count_unit is rejected", () => {
  const bad = {
    request_id: "TEST",
    cohort_filters: [],
    count_unit: "visit",
    metrics: [{ type: "count", label: "n" }],
  };
  const r = validatePlan(bad);
  assert(!r.ok, "must fail");
  assert(
    r.errors.some((e) => e.path === "$.count_unit"),
    "error must mention count_unit",
  );
});

Deno.test("empty metrics array is rejected", () => {
  const bad = {
    request_id: "TEST",
    cohort_filters: [],
    count_unit: "patient",
    metrics: [],
  };
  const r = validatePlan(bad);
  assert(!r.ok, "must fail");
  assert(
    r.errors.some((e) => e.path === "$.metrics"),
    "error must mention metrics",
  );
});

Deno.test("unknown top-level field is rejected", () => {
  const bad = {
    request_id: "TEST",
    cohort_filters: [],
    count_unit: "patient",
    metrics: [{ type: "count", label: "n" }],
    grouping: { by: "region" }, // old field name — must be rejected
  };
  const r = validatePlan(bad);
  assert(!r.ok, "must fail");
  assert(
    r.errors.some((e) => e.path === "$.grouping"),
    "error must mention unknown field grouping",
  );
});

Deno.test("unknown filter type is rejected", () => {
  const bad = {
    request_id: "TEST",
    cohort_filters: [{ type: "unknown_type" }],
    count_unit: "patient",
    metrics: [{ type: "count", label: "n" }],
  };
  const r = validatePlan(bad);
  assert(!r.ok, "must fail");
  assert(
    r.errors.some((e) => e.path.startsWith("$.cohort_filters[0].type")),
    "error must mention the bad filter type",
  );
});

Deno.test("unknown field on has_condition filter is rejected", () => {
  const bad = {
    request_id: "TEST",
    cohort_filters: [{
      type: "has_condition",
      icd10_prefixes: ["E11"],
      condition_filtr: true, // typo — must be caught
    }],
    count_unit: "patient",
    metrics: [{ type: "count", label: "n" }],
  };
  const r = validatePlan(bad);
  assert(!r.ok, "must fail");
  assert(
    r.errors.some((e) => e.path === "$.cohort_filters[0].condition_filtr"),
    "error must mention the unknown field",
  );
});

Deno.test("unknown metric type is rejected", () => {
  const bad = {
    request_id: "TEST",
    cohort_filters: [],
    count_unit: "patient",
    metrics: [{ type: "histogram", label: "n" }],
  };
  const r = validatePlan(bad);
  assert(!r.ok, "must fail");
  assert(
    r.errors.some((e) => e.path.startsWith("$.metrics[0].type")),
    "error must mention the bad metric type",
  );
});

Deno.test("unknown field on count metric is rejected", () => {
  const bad = {
    request_id: "TEST",
    cohort_filters: [],
    count_unit: "patient",
    metrics: [{ type: "count", label: "n", condition_filtr: {} }], // typo
  };
  const r = validatePlan(bad);
  assert(!r.ok, "must fail");
  assert(
    r.errors.some((e) => e.path === "$.metrics[0].condition_filtr"),
    "error must mention unknown field condition_filtr",
  );
});

Deno.test("unknown field on mean_observation metric is rejected", () => {
  const bad = {
    request_id: "TEST",
    cohort_filters: [],
    count_unit: "patient",
    metrics: [{
      type: "mean_observation",
      label: "x",
      loinc: "4548-4",
      use_latest: true,
      latest: true, // extra unknown field
    }],
  };
  const r = validatePlan(bad);
  assert(!r.ok, "must fail");
  assert(
    r.errors.some((e) => e.path === "$.metrics[0].latest"),
    "error must mention unknown field latest",
  );
});

Deno.test("has_condition with empty icd10_prefixes is rejected", () => {
  const bad = {
    request_id: "TEST",
    cohort_filters: [{ type: "has_condition", icd10_prefixes: [] }],
    count_unit: "patient",
    metrics: [{ type: "count", label: "n" }],
  };
  const r = validatePlan(bad);
  assert(!r.ok, "must fail");
  assert(
    r.errors.some((e) => e.path === "$.cohort_filters[0].icd10_prefixes"),
    "error must mention empty icd10_prefixes",
  );
});

Deno.test("has_medication missing active_on_ref_date is rejected", () => {
  const bad = {
    request_id: "TEST",
    cohort_filters: [{
      type: "has_medication",
      atc_prefixes: ["A10BK"],
    }],
    count_unit: "patient",
    metrics: [{ type: "count", label: "n" }],
  };
  const r = validatePlan(bad);
  assert(!r.ok, "must fail");
  assert(
    r.errors.some((e) => e.path === "$.cohort_filters[0].active_on_ref_date"),
    "error must mention active_on_ref_date",
  );
});

Deno.test("sex filter with invalid value is rejected", () => {
  const bad = {
    request_id: "TEST",
    cohort_filters: [{ type: "sex", value: "other" }],
    count_unit: "patient",
    metrics: [{ type: "count", label: "n" }],
  };
  const r = validatePlan(bad);
  assert(!r.ok, "must fail");
  assert(
    r.errors.some((e) => e.path === "$.cohort_filters[0].value"),
    "error must mention value",
  );
});

Deno.test("age_band dimension with empty bands array is rejected", () => {
  const bad = {
    request_id: "TEST",
    cohort_filters: [],
    count_unit: "patient",
    dimensions: [{ by: "age_band", bands: [] }],
    metrics: [{ type: "count", label: "n" }],
  };
  const r = validatePlan(bad);
  assert(!r.ok, "must fail");
  assert(
    r.errors.some((e) => e.path === "$.dimensions[0].bands"),
    "error must mention bands",
  );
});

Deno.test("unknown grouping dimension is rejected", () => {
  const bad = {
    request_id: "TEST",
    cohort_filters: [],
    count_unit: "patient",
    dimensions: [{ by: "hospital" }],
    metrics: [{ type: "count", label: "n" }],
  };
  const r = validatePlan(bad);
  assert(!r.ok, "must fail");
  assert(
    r.errors.some((e) => e.path === "$.dimensions[0].by"),
    "error must mention grouping.by",
  );
});

Deno.test("more than two dimensions is rejected", () => {
  const bad = {
    request_id: "TEST",
    cohort_filters: [],
    count_unit: "patient",
    dimensions: [{ by: "region" }, { by: "data_holder" }, { by: "region" }],
    metrics: [{ type: "count", label: "n" }],
  };
  const r = validatePlan(bad);
  assert(!r.ok, "must fail");
  assert(
    r.errors.some((e) => e.path === "$.dimensions"),
    "error must mention dimensions",
  );
});

Deno.test("invalid spe_record_type is rejected", () => {
  const bad = {
    request_id: "TEST",
    cohort_filters: [],
    count_unit: "patient",
    metrics: [{ type: "count", label: "n" }],
    spe_record_types: ["patients"],
  };
  const r = validatePlan(bad);
  assert(!r.ok, "must fail");
  assert(
    r.errors.some((e) => e.path === "$.spe_record_types[0]"),
    "error must mention the invalid spe_record_types entry",
  );
});

Deno.test("non-object plan is rejected", () => {
  const r = validatePlan("not a plan");
  assert(!r.ok, "must fail");
  assert(r.errors[0].path === "$", "root error path must be $");
});

Deno.test("percentage metric with neither numerator_label nor numerator_filters is rejected", () => {
  const bad = {
    request_id: "TEST",
    cohort_filters: [],
    count_unit: "patient",
    metrics: [{ type: "percentage", label: "pct", denominator_label: "total" }],
  };
  const r = validatePlan(bad);
  assert(!r.ok, "must fail");
  assert(
    r.errors.some((e) => e.path === "$.metrics[0].numerator_label"),
    "error must mention numerator_label",
  );
});

Deno.test("percentage metric with both numerator_label and numerator_filters is rejected", () => {
  const bad = {
    request_id: "TEST",
    cohort_filters: [],
    count_unit: "patient",
    metrics: [{
      type: "percentage",
      label: "pct",
      denominator_label: "total",
      numerator_label: "sub",
      numerator_filters: [{ type: "has_condition", icd10_prefixes: ["E11"] }],
    }],
  };
  const r = validatePlan(bad);
  assert(!r.ok, "must fail");
  assert(
    r.errors.some((e) => e.path === "$.metrics[0].numerator_label"),
    "error must mention numerator_label mutual exclusion",
  );
});

Deno.test("mean_observation metric missing use_latest is rejected", () => {
  const bad = {
    request_id: "TEST",
    cohort_filters: [],
    count_unit: "patient",
    metrics: [{ type: "mean_observation", label: "x", loinc: "4548-4" }],
  };
  const r = validatePlan(bad);
  assert(!r.ok, "must fail");
  assert(
    r.errors.some((e) => e.path === "$.metrics[0].use_latest"),
    "error must mention use_latest",
  );
});

Deno.test("mean_observation metric missing loinc is rejected", () => {
  const bad = {
    request_id: "TEST",
    cohort_filters: [],
    count_unit: "patient",
    metrics: [{ type: "mean_observation", label: "x", use_latest: true }],
  };
  const r = validatePlan(bad);
  assert(!r.ok, "must fail");
  assert(
    r.errors.some((e) => e.path === "$.metrics[0].loinc"),
    "must mention loinc",
  );
});

Deno.test("encounter_filter with invalid encounter_type is rejected", () => {
  const bad = {
    request_id: "TEST",
    cohort_filters: [{
      type: "encounter_filter",
      encounter_type: "telehealth",
    }],
    count_unit: "encounter",
    metrics: [{ type: "count", label: "n" }],
  };
  const r = validatePlan(bad);
  assert(!r.ok, "must fail");
  assert(
    r.errors.some((e) => e.path === "$.cohort_filters[0].encounter_type"),
    "must mention encounter_type",
  );
});

Deno.test("count metric filters with an invalid sub-filter are rejected", () => {
  const bad = {
    request_id: "TEST",
    cohort_filters: [],
    count_unit: "patient",
    metrics: [{
      type: "count",
      label: "n",
      filters: [{ type: "has_condition", icd10_prefixes: [] }], // empty array
    }],
  };
  const r = validatePlan(bad);
  assert(!r.ok, "must fail");
  assert(
    r.errors.some((e) =>
      e.path === "$.metrics[0].filters[0].icd10_prefixes"
    ),
    "error must mention the invalid sub-filter field",
  );
});

