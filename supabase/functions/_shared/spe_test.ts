/**
 * Unit tests for spe.ts — no database required.
 *
 * Tests cover:
 *  1. Schema-name validation (schemaName)
 *  2. Which tables are planned for a given plan (plannedTables)
 *  3. LOINC restriction params (observationLoincParams)
 *  4. Patient columns selected (patientColumns)
 *  5. No remote imports; pure logic only.
 */

import {
  assertEquals,
  assertThrows,
} from "jsr:@std/assert";

import {
  observationLoincParams,
  patientColumns,
  plannedTables,
  schemaName,
} from "./spe.ts";
import type { QueryPlan } from "./plan.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid plan without SPE fields. */
function basePlan(): QueryPlan {
  return {
    request_id: "R00",
    cohort_filters: [],
    count_unit: "patient",
    metrics: [{ type: "count", label: "n" }],
  };
}

// ---------------------------------------------------------------------------
// schemaName tests
// ---------------------------------------------------------------------------

Deno.test("schemaName: lowercase requestId returns spe_ prefix", () => {
  assertEquals(schemaName("r05"), "spe_r05");
});

Deno.test("schemaName: mixed-case requestId is lower-cased", () => {
  assertEquals(schemaName("R05"), "spe_r05");
});

Deno.test("schemaName: numeric requestId is allowed", () => {
  assertEquals(schemaName("123"), "spe_123");
});

Deno.test("schemaName: underscores in requestId are allowed", () => {
  assertEquals(schemaName("req_01"), "spe_req_01");
});

Deno.test("schemaName: requestId with hyphen throws", () => {
  assertThrows(
    () => schemaName("R-05"),
    Error,
    "invalid schema name",
  );
});

Deno.test("schemaName: requestId with space throws", () => {
  assertThrows(
    () => schemaName("R 05"),
    Error,
    "invalid schema name",
  );
});

Deno.test("schemaName: requestId with dots throws", () => {
  assertThrows(
    () => schemaName("R05.1"),
    Error,
    "invalid schema name",
  );
});

Deno.test("schemaName: requestId with unicode throws", () => {
  assertThrows(
    () => schemaName("Ö5"),
    Error,
    "invalid schema name",
  );
});

// ---------------------------------------------------------------------------
// plannedTables tests
// ---------------------------------------------------------------------------

Deno.test("plannedTables: returns empty array when spe_record_types absent", () => {
  const plan = basePlan();
  assertEquals(plannedTables(plan), []);
});

Deno.test("plannedTables: returns only the listed record types", () => {
  const plan: QueryPlan = {
    ...basePlan(),
    spe_record_types: ["conditions", "medications"],
  };
  assertEquals(plannedTables(plan), ["conditions", "medications"]);
});

Deno.test("plannedTables: returns all four record types", () => {
  const plan: QueryPlan = {
    ...basePlan(),
    spe_record_types: ["conditions", "medications", "observations", "encounters"],
  };
  assertEquals(plannedTables(plan), [
    "conditions",
    "medications",
    "observations",
    "encounters",
  ]);
});

Deno.test("plannedTables: observations only", () => {
  const plan: QueryPlan = {
    ...basePlan(),
    spe_record_types: ["observations"],
  };
  assertEquals(plannedTables(plan), ["observations"]);
});

Deno.test("plannedTables: R05 fixture produces conditions, medications, observations", () => {
  const plan: QueryPlan = {
    request_id: "R05",
    cohort_filters: [
      { type: "age", min_age: 18 },
      { type: "has_condition", icd10_prefixes: ["E11"] },
      { type: "has_observation", loinc: "4548-4" },
    ],
    count_unit: "patient",
    metrics: [{ type: "count", label: "cohort_size" }],
    spe_record_types: ["conditions", "medications", "observations"],
    spe_observation_loincs: ["4548-4"],
  };
  assertEquals(plannedTables(plan), ["conditions", "medications", "observations"]);
});

// ---------------------------------------------------------------------------
// observationLoincParams tests
// ---------------------------------------------------------------------------

Deno.test("observationLoincParams: returns null when no spe_observation_loincs", () => {
  const plan = basePlan();
  assertEquals(observationLoincParams(plan), null);
});

Deno.test("observationLoincParams: returns null when spe_observation_loincs is empty", () => {
  // Empty array means no restriction — the field must be non-empty per spec;
  // but if somehow empty we treat it as no restriction.
  const plan: QueryPlan = {
    ...basePlan(),
    spe_record_types: ["observations"],
    spe_observation_loincs: [],
  };
  assertEquals(observationLoincParams(plan), null);
});

Deno.test("observationLoincParams: returns single LOINC array", () => {
  const plan: QueryPlan = {
    ...basePlan(),
    spe_record_types: ["observations"],
    spe_observation_loincs: ["4548-4"],
  };
  assertEquals(observationLoincParams(plan), ["4548-4"]);
});

Deno.test("observationLoincParams: returns multiple LOINCs", () => {
  const plan: QueryPlan = {
    ...basePlan(),
    spe_record_types: ["observations"],
    spe_observation_loincs: ["4548-4", "2339-0", "6768-6"],
  };
  assertEquals(observationLoincParams(plan), ["4548-4", "2339-0", "6768-6"]);
});

Deno.test("observationLoincParams: returns a copy, not the original array", () => {
  const loincs = ["4548-4"];
  const plan: QueryPlan = {
    ...basePlan(),
    spe_record_types: ["observations"],
    spe_observation_loincs: loincs,
  };
  const result = observationLoincParams(plan)!;
  result.push("mutated");
  assertEquals(loincs, ["4548-4"]); // original unchanged
});

// ---------------------------------------------------------------------------
// patientColumns tests
// ---------------------------------------------------------------------------

Deno.test("patientColumns: R05 plan selects only patient_id (no demographics)", () => {
  const plan: QueryPlan = {
    request_id: "R05",
    cohort_filters: [
      { type: "age", min_age: 18 },
      { type: "has_condition", icd10_prefixes: ["E11"] },
      { type: "has_observation", loinc: "4548-4" },
    ],
    count_unit: "patient",
    metrics: [{ type: "count", label: "cohort_size" }],
    spe_record_types: ["conditions", "medications", "observations"],
    spe_observation_loincs: ["4548-4"],
  };
  assertEquals(patientColumns(plan), ["patient_id"]);
});

Deno.test("patientColumns: plan without spe_record_types selects only patient_id", () => {
  const plan = basePlan();
  assertEquals(patientColumns(plan), ["patient_id"]);
});

Deno.test("patientColumns: plan with only non-patient record types selects only patient_id", () => {
  const plan: QueryPlan = {
    ...basePlan(),
    spe_record_types: ["conditions", "encounters"],
  };
  assertEquals(patientColumns(plan), ["patient_id"]);
});

Deno.test("patientColumns: plan requesting 'patients' record type gets all demographic columns", () => {
  // RecordType in plan.ts does not list "patients", but createSpe checks for it
  // as a string; cast to test the branch without changing plan.ts.
  const plan = {
    ...basePlan(),
    spe_record_types: ["patients"] as unknown as QueryPlan["spe_record_types"],
  } as QueryPlan;
  assertEquals(patientColumns(plan), [
    "patient_id",
    "sex",
    "birth_date",
    "region",
    "data_holder",
  ]);
});

Deno.test("patientColumns: plan requesting 'patients' alongside other types gets demographics", () => {
  const plan = {
    ...basePlan(),
    spe_record_types: ["conditions", "patients"] as unknown as QueryPlan["spe_record_types"],
  } as QueryPlan;
  assertEquals(patientColumns(plan), [
    "patient_id",
    "sex",
    "birth_date",
    "region",
    "data_holder",
  ]);
});
