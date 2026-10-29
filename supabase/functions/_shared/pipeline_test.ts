/**
 * Tests for the end-to-end pipeline (Issue #13, EHDS Track 3).
 *
 * Uses a fake sql client — no database, no network, no remote imports.
 *
 * Covered:
 *   1. REJECT never queries the database.
 *   2. A parse failure returns the decision + needs_review + parse_errors, answer null.
 *   3. APPROVE_STATISTICAL calls runPlan (engine queries fired).
 *   4. APPROVE_SPE calls createSpe (schema DDL queries fired) and returns cohort_size.
 */

import { answerRequest, type SqlClient } from "./pipeline.ts";

function assert(ok: boolean, message = "Assertion failed"): asserts ok {
  if (!ok) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Minimal request fixtures
// ---------------------------------------------------------------------------

/** A request whose purpose is prohibited (Art. 54) → REJECT */
const REJECT_REQUEST = {
  id: "T-REJ",
  requested_as: "health data request",
  purpose: "Align insurance premiums with patient risk profiles.",
  question: "How many patients have diabetes?",
  definitions: [
    "Adult = aged 18 or older on 31 December 2025.",
    "Report per region: adults.",
  ],
};

/** A request with a valid APPROVE_STATISTICAL decision but broken definitions. */
const PARSE_FAIL_REQUEST = {
  id: "T-FAIL",
  requested_as: "health data request",
  purpose: "Public health research on diabetes prevalence.",
  question: "How many adults have diabetes?",
  definitions: [
    // Missing "Report …" clause → parseRequest returns ok:false
    "Adult = aged 18 or older on 31 December 2025.",
  ],
};

/** A minimal APPROVE_STATISTICAL request (health data request, simple count). */
const STAT_REQUEST = {
  id: "T-STAT",
  requested_as: "health data request",
  purpose: "Public health research on diabetes prevalence.",
  question: "How many adults have type 2 diabetes?",
  definitions: [
    "Adult = aged 18 or older on 31 December 2025.",
    "Type 2 diabetes = any condition with an ICD-10 code starting with E11.",
    "Report per region: adults with type 2 diabetes.",
  ],
};

/**
 * APPROVE_SPE request — mirrors the real R05 fixture from parser_fixtures.ts.
 * Purpose cites "individual-level histories; aggregates are not enough" → SPE trigger.
 */
const SPE_REQUEST = {
  id: "R05",
  requested_as: "health data access application",
  requested_format: "pseudonymised records",
  purpose:
    "We train and validate a model that predicts which patients with type 2 diabetes will have an HbA1c above 8% in the next 12 months, so that GPs can intervene earlier. Training needs individual-level histories; aggregates are not enough.",
  question:
    "Provide pseudonymised conditions, medications and HbA1c values for adults with type 2 diabetes who have at least one HbA1c value. We will only export model weights and performance metrics.",
  definitions: [
    "Adult = aged 18 or older on 31 December 2025.",
    "Type 2 diabetes = any condition with an ICD-10 code starting with E11.",
    "Cohort = adults with type 2 diabetes who have at least one HbA1c value (LOINC 4548-4).",
    "Report the size of the cohort you would make available.",
  ],
};

// ---------------------------------------------------------------------------
// Fake sql client
// ---------------------------------------------------------------------------

/** A sql client that records every unsafe() call and returns canned answers. */
function makeFakeSql(
  responses: Record<string, unknown>[][] = [],
): SqlClient & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    unsafe(_text: string, _params?: (string | number | boolean)[]) {
      calls++;
      const rows = responses.shift() ?? [];
      return Promise.resolve(rows);
    },
    begin<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
      // Run the transaction fn with the same fake client.
      return fn(this as unknown as SqlClient);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. REJECT — never queries the database
// ---------------------------------------------------------------------------
Deno.test("REJECT: answer is null and sql is never called", async () => {
  const sql = makeFakeSql();
  const resp = await answerRequest(REJECT_REQUEST, sql);
  assert(resp.decision === "REJECT", `expected REJECT, got ${resp.decision}`);
  assert(resp.answer === null, "answer must be null for REJECT");
  assert(sql.calls === 0, `expected 0 sql calls, got ${sql.calls}`);
  assert(resp.articles.includes("54"), "must cite Art. 54");
});

// ---------------------------------------------------------------------------
// 2. Parse failure — needs_review true, answer null, parse_errors present
// ---------------------------------------------------------------------------
Deno.test("parse failure: needs_review is true, answer is null, parse_errors present", async () => {
  const sql = makeFakeSql();
  const resp = await answerRequest(PARSE_FAIL_REQUEST, sql);
  assert(
    resp.decision === "APPROVE_STATISTICAL",
    `expected APPROVE_STATISTICAL, got ${resp.decision}`,
  );
  assert(resp.answer === null, "answer must be null when parse fails");
  assert(resp.needs_review === true, "needs_review must be true when parse fails");
  assert(
    Array.isArray(resp.parse_errors) && resp.parse_errors.length > 0,
    "parse_errors must be a non-empty array",
  );
  // No patient data queried.
  assert(sql.calls === 0, `expected 0 sql calls, got ${sql.calls}`);
});

// ---------------------------------------------------------------------------
// 3. APPROVE_STATISTICAL — engine is called, answer is returned
// ---------------------------------------------------------------------------
Deno.test("APPROVE_STATISTICAL: runPlan is called, answer returned", async () => {
  // Engine expects: universe query per dimension + count query per metric.
  // STAT_REQUEST has one region dimension and one count metric.
  const sql = makeFakeSql([
    // universe for region dimension
    [{ value: "Wien" }, { value: "Steiermark" }],
    // count metric rows
    [{ g0: "Wien", n: "120" }, { g0: "Steiermark", n: "95" }],
  ]);
  const resp = await answerRequest(STAT_REQUEST, sql);
  assert(
    resp.decision === "APPROVE_STATISTICAL",
    `expected APPROVE_STATISTICAL, got ${resp.decision}`,
  );
  assert(resp.answer !== null, "answer must not be null");
  assert(sql.calls > 0, "sql must have been called");
  assert(!("spe_schema" in resp), "spe_schema must not be present for STATISTICAL");
  assert(
    !Array.isArray(resp.parse_errors),
    "parse_errors must not be present on success",
  );
});

// ---------------------------------------------------------------------------
// 4. APPROVE_SPE — createSpe is called, cohort_size returned, spe_schema set
// ---------------------------------------------------------------------------
Deno.test("APPROVE_SPE: createSpe is called, cohort_size and spe_schema returned", async () => {
  // createSpe issues: DROP SCHEMA, CREATE SCHEMA, REVOKE, GRANT, CREATE TABLE patients,
  // ALTER TABLE (RLS), REVOKE, GRANT (for patients), then per-record-table (conditions):
  // CREATE, ALTER, REVOKE, GRANT (4 stmts), then a COUNT query outside the transaction.
  // The fake sql above returns [] for all DDL and [{n:"42"}] for the COUNT.
  const ddlRows: Record<string, unknown>[][] = Array.from({ length: 20 }, () => []);
  // Final call: SELECT COUNT(*) → cohort size
  ddlRows.push([{ n: "42" }]);
  const sql = makeFakeSql(ddlRows);
  const resp = await answerRequest(SPE_REQUEST, sql);
  assert(
    resp.decision === "APPROVE_SPE",
    `expected APPROVE_SPE, got ${resp.decision}`,
  );
  assert(resp.answer !== null, "answer must not be null");
  assert(
    typeof (resp.answer as Record<string, unknown>).cohort_size === "number",
    "answer.cohort_size must be a number",
  );
  assert(
    typeof resp.spe_schema === "string" && resp.spe_schema.startsWith("spe_"),
    `spe_schema must start with 'spe_', got ${resp.spe_schema}`,
  );
  assert(sql.calls > 0, "sql must have been called");
  assert(
    !Array.isArray(resp.parse_errors),
    "parse_errors must not be present on success",
  );
});
