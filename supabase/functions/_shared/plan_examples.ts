/**
 * Example query plans — one per request R01–R10, plus two extra plans that
 * demonstrate features not covered by the 10 requests:
 *   - EX_INPATIENT_ICD10: filter inpatient stays by primary_icd10 prefix
 *   - EX_GROUP_DATA_HOLDER: group a count by data_holder
 */
import type { QueryPlan } from "./plan.ts";

// ---------------------------------------------------------------------------
// R01: Type 2 diabetes prevalence per region
// Cohort: all adults (age >= 18); within each region group also count the
// subset with an E11 condition for the numerator of prevalence.
// ---------------------------------------------------------------------------
export const R01: QueryPlan = {
  request_id: "R01",
  cohort_filters: [
    { type: "age", min_age: 18 },
  ],
  count_unit: "patient",
  dimensions: [{ by: "region" }],
  metrics: [
    { type: "count", label: "adults" },
    {
      type: "count",
      label: "type2_diabetes",
      filters: [{ type: "has_condition", icd10_prefixes: ["E11"] }],
    },
    {
      type: "percentage",
      label: "prevalence_pct",
      numerator_label: "type2_diabetes",
      denominator_label: "adults",
    },
  ],
};

// ---------------------------------------------------------------------------
// R02: Mean HbA1c of adults with type 2 diabetes by 10-year age band.
// Cohort: adults with E11 and at least one HbA1c observation.
// use_latest: true — take the most-recent HbA1c per patient.
// ---------------------------------------------------------------------------
export const R02: QueryPlan = {
  request_id: "R02",
  cohort_filters: [
    { type: "age", min_age: 18 },
    { type: "has_condition", icd10_prefixes: ["E11"] },
    { type: "has_observation", loinc: "4548-4" },
  ],
  count_unit: "patient",
  dimensions: [
    {
      by: "age_band",
      bands: [
        { label: "18-29", min_age: 18, max_age: 29 },
        { label: "30-39", min_age: 30, max_age: 39 },
        { label: "40-49", min_age: 40, max_age: 49 },
        { label: "50-59", min_age: 50, max_age: 59 },
        { label: "60-69", min_age: 60, max_age: 69 },
        { label: "70-79", min_age: 70, max_age: 79 },
        { label: "80+", min_age: 80 },
      ],
    },
  ],
  metrics: [
    { type: "count", label: "patients_with_hba1c" },
    { type: "mean_observation", label: "mean_hba1c", loinc: "4548-4", use_latest: true },
  ],
};

// ---------------------------------------------------------------------------
// R03: AF patients aged 65+ without active oral anticoagulant by age band.
// Cohort: patients aged 65+ with an I48 condition.
// "without_oac" counts the sub-set that has NO active B01AA/B01AF medication
// on the reference date, expressed with filters on the count metric.
// ---------------------------------------------------------------------------
export const R03: QueryPlan = {
  request_id: "R03",
  cohort_filters: [
    { type: "age", min_age: 65 },
    { type: "has_condition", icd10_prefixes: ["I48"] },
  ],
  count_unit: "patient",
  dimensions: [
    {
      by: "age_band",
      bands: [
        { label: "65-74", min_age: 65, max_age: 74 },
        { label: "75-84", min_age: 75, max_age: 84 },
        { label: "85+", min_age: 85 },
      ],
    },
  ],
  metrics: [
    { type: "count", label: "af_patients" },
    {
      type: "count",
      label: "without_oac",
      filters: [
        {
          type: "has_medication",
          atc_prefixes: ["B01AA", "B01AF"],
          active_on_ref_date: true,
          negate: true,
        },
      ],
    },
    {
      type: "percentage",
      label: "share_without_oac_pct",
      numerator_label: "without_oac",
      denominator_label: "af_patients",
    },
  ],
};

// ---------------------------------------------------------------------------
// R04: Patients with an active SGLT2 inhibitor prescription, by region.
// ---------------------------------------------------------------------------
export const R04: QueryPlan = {
  request_id: "R04",
  cohort_filters: [
    {
      type: "has_medication",
      atc_prefixes: ["A10BK"],
      active_on_ref_date: true,
    },
  ],
  count_unit: "patient",
  dimensions: [{ by: "region" }],
  metrics: [
    { type: "count", label: "patients_with_sglt2" },
  ],
};

// ---------------------------------------------------------------------------
// R05: SPE — adults with type 2 diabetes who have at least one HbA1c value.
// spe_record_types lists the tables to copy into the secure schema.
// ---------------------------------------------------------------------------
export const R05: QueryPlan = {
  request_id: "R05",
  cohort_filters: [
    { type: "age", min_age: 18 },
    { type: "has_condition", icd10_prefixes: ["E11"] },
    { type: "has_observation", loinc: "4548-4" },
  ],
  count_unit: "patient",
  metrics: [
    { type: "count", label: "cohort_size" },
  ],
  spe_record_types: ["conditions", "medications", "observations"],
  spe_observation_loincs: ["4548-4"],
};

// ---------------------------------------------------------------------------
// R06: SPE — adults with depression in Oberösterreich.
// Region value uses the UTF-8 string as it appears in the data.
// ---------------------------------------------------------------------------
export const R06: QueryPlan = {
  request_id: "R06",
  cohort_filters: [
    { type: "age", min_age: 18 },
    { type: "has_condition", icd10_prefixes: ["F32"] },
    { type: "region", value: "Oberösterreich" },
  ],
  count_unit: "patient",
  metrics: [
    { type: "count", label: "cohort_size" },
  ],
  spe_record_types: ["conditions"],
};

// ---------------------------------------------------------------------------
// R07: Inpatient stays that started in 2025, counted per region.
// count_unit is "encounter" because the request asks to count stays, not patients.
// ---------------------------------------------------------------------------
export const R07: QueryPlan = {
  request_id: "R07",
  cohort_filters: [
    {
      type: "encounter_filter",
      encounter_type: "inpatient",
      start_year: 2025,
    },
  ],
  count_unit: "encounter",
  dimensions: [{ by: "region" }],
  metrics: [
    { type: "count", label: "inpatient_stays" },
  ],
};

// ---------------------------------------------------------------------------
// R08: Mean BMI of women with breast cancer by region.
// use_latest: true — take the most-recent BMI observation per patient.
// ---------------------------------------------------------------------------
export const R08: QueryPlan = {
  request_id: "R08",
  cohort_filters: [
    { type: "sex", value: "female" },
    { type: "has_condition", icd10_prefixes: ["C50"] },
    { type: "has_observation", loinc: "39156-5" },
  ],
  count_unit: "patient",
  dimensions: [{ by: "region" }],
  metrics: [
    { type: "count", label: "women_with_bmi" },
    { type: "mean_observation", label: "mean_bmi", loinc: "39156-5", use_latest: true },
  ],
};

// ---------------------------------------------------------------------------
// R09: Adults with hypertension — percentage with ACE inhibitor / ARB,
// by age band.
// The denominator is adults_with_hypertension (a count metric).
// numerator_filters on each percentage metric compute the numerators inline
// without requiring separate named count metrics.
// ---------------------------------------------------------------------------
export const R09: QueryPlan = {
  request_id: "R09",
  cohort_filters: [
    { type: "age", min_age: 18 },
    { type: "has_condition", icd10_prefixes: ["I10"] },
  ],
  count_unit: "patient",
  dimensions: [
    {
      by: "age_band",
      bands: [
        { label: "18-49", min_age: 18, max_age: 49 },
        { label: "50-64", min_age: 50, max_age: 64 },
        { label: "65+", min_age: 65 },
      ],
    },
  ],
  metrics: [
    { type: "count", label: "adults_with_hypertension" },
    {
      type: "percentage",
      label: "ace_inhibitor_pct",
      numerator_filters: [
        {
          type: "has_medication",
          atc_prefixes: ["C09AA"],
          active_on_ref_date: true,
        },
      ],
      denominator_label: "adults_with_hypertension",
    },
    {
      type: "percentage",
      label: "arb_pct",
      numerator_filters: [
        {
          type: "has_medication",
          atc_prefixes: ["C09CA"],
          active_on_ref_date: true,
        },
      ],
      denominator_label: "adults_with_hypertension",
    },
  ],
};

// ---------------------------------------------------------------------------
// R10: COPD patients by 10-year age band AND region (cross-tab).
// Two dimensions: age_band (outer) × region (inner).
// ---------------------------------------------------------------------------
export const R10: QueryPlan = {
  request_id: "R10",
  cohort_filters: [
    { type: "has_condition", icd10_prefixes: ["J44"] },
  ],
  count_unit: "patient",
  dimensions: [
    {
      by: "age_band",
      bands: [
        { label: "0-9", min_age: 0, max_age: 9 },
        { label: "10-19", min_age: 10, max_age: 19 },
        { label: "20-29", min_age: 20, max_age: 29 },
        { label: "30-39", min_age: 30, max_age: 39 },
        { label: "40-49", min_age: 40, max_age: 49 },
        { label: "50-59", min_age: 50, max_age: 59 },
        { label: "60-69", min_age: 60, max_age: 69 },
        { label: "70-79", min_age: 70, max_age: 79 },
        { label: "80-89", min_age: 80, max_age: 89 },
        { label: "90+", min_age: 90 },
      ],
    },
    { by: "region" },
  ],
  metrics: [
    { type: "count", label: "copd_patients" },
  ],
};

// ---------------------------------------------------------------------------
// EX_INPATIENT_ICD10: count inpatient stays filtered by primary_icd10 prefix.
// Scenario: inpatient stays with primary diagnosis J44 (COPD), by region.
// ---------------------------------------------------------------------------
export const EX_INPATIENT_ICD10: QueryPlan = {
  request_id: "EX_INPATIENT_ICD10",
  cohort_filters: [
    {
      type: "encounter_filter",
      encounter_type: "inpatient",
      primary_icd10_prefix: "J44",
    },
  ],
  count_unit: "encounter",
  dimensions: [{ by: "region" }],
  metrics: [
    { type: "count", label: "inpatient_stays_copd" },
  ],
};

// ---------------------------------------------------------------------------
// EX_GROUP_DATA_HOLDER: group by data_holder (hospital).
// Scenario: adults with type 2 diabetes per hospital.
// ---------------------------------------------------------------------------
export const EX_GROUP_DATA_HOLDER: QueryPlan = {
  request_id: "EX_GROUP_DATA_HOLDER",
  cohort_filters: [
    { type: "age", min_age: 18 },
    { type: "has_condition", icd10_prefixes: ["E11"] },
  ],
  count_unit: "patient",
  dimensions: [{ by: "data_holder" }],
  metrics: [
    { type: "count", label: "adults_with_t2d" },
  ],
};

/** All example plans in a single array for test iteration. */
export const ALL_EXAMPLES: QueryPlan[] = [
  R01,
  R02,
  R03,
  R04,
  R05,
  R06,
  R07,
  R08,
  R09,
  R10,
  EX_INPATIENT_ICD10,
  EX_GROUP_DATA_HOLDER,
];
