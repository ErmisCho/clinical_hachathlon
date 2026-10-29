/**
 * Tests for the decision module (Issue #3, EHDS Track 3).
 *
 * Follows the local assert-helper style from patients_test.ts.
 * No remote imports; fixture data is in decision_fixtures.ts.
 */

import { decide } from "./decision.ts";
import type { HealthDataRequest } from "./decision.ts";
import { EXPECTED, REQUESTS } from "./decision_fixtures.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// 1. All 10 requests match expected.json (decision + articles)
// ---------------------------------------------------------------------------
for (const id of Object.keys(REQUESTS)) {
  Deno.test(`${id}: decision and articles match expected.json`, () => {
    const result = decide(REQUESTS[id]);
    const expected = EXPECTED[id];

    assert(
      result.decision === expected.decision,
      `${id}: expected decision ${expected.decision}, got ${result.decision}`,
    );

    // Expected articles must all be present; extras are fine (track README allows Art. 67/71).
    for (const art of expected.articles) {
      assert(
        result.articles.includes(art),
        `${id}: expected article ${art} in [${result.articles.join(", ")}]`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// 2. Art. 54 is checked before anything else: a statistics request whose
//    purpose is setting insurance premiums must be REJECTED.
// ---------------------------------------------------------------------------
Deno.test("insurance premium purpose is rejected even as health data request", () => {
  const req: HealthDataRequest = {
    requested_as: "health data request",
    purpose: "We want to align private health insurance premiums for diabetes patients with their risk.",
    question: "What is the average HbA1c by age band?",
  };
  const result = decide(req);
  assert(result.decision === "REJECT", `Expected REJECT, got ${result.decision}`);
  assert(result.articles.includes("54"), "Expected article 54 for prohibited purpose");
});

// ---------------------------------------------------------------------------
// 3. R05 without its SPE justification becomes APPROVE_STATISTICAL.
// ---------------------------------------------------------------------------
Deno.test("R05 without aggregates-not-enough justification → APPROVE_STATISTICAL", () => {
  const r05modified: HealthDataRequest = {
    ...REQUESTS["R05"],
    // Remove the SPE justification sentence from purpose
    purpose:
      "We train and validate a model that predicts which patients with type 2 diabetes will have an HbA1c above 8% in the next 12 months, so that GPs can intervene earlier.",
  };
  const result = decide(r05modified);
  assert(
    result.decision === "APPROVE_STATISTICAL",
    `Expected APPROVE_STATISTICAL without SPE justification, got ${result.decision}`,
  );
  assert(result.articles.includes("66"), "Expected article 66 for access application");
  assert(result.articles.includes("69"), "Expected article 69 for statistical approval");
});

// ---------------------------------------------------------------------------
// 4. An ambiguous purpose (neither allowed nor prohibited) sets needs_review.
// ---------------------------------------------------------------------------
Deno.test("ambiguous purpose sets needs_review = true", () => {
  const req: HealthDataRequest = {
    requested_as: "health data request",
    purpose: "We want to explore some data for internal purposes.",
    question: "How many patients are there?",
  };
  const result = decide(req);
  assert(result.needs_review === true, "Expected needs_review = true for ambiguous purpose");
});

// ---------------------------------------------------------------------------
// 5. Consistency: the same input gives the same output twice.
// ---------------------------------------------------------------------------
Deno.test("same input gives same output twice (consistency)", () => {
  for (const id of Object.keys(REQUESTS)) {
    const r1 = decide(REQUESTS[id]);
    const r2 = decide(REQUESTS[id]);
    assert(
      r1.decision === r2.decision,
      `${id}: inconsistent decision: ${r1.decision} vs ${r2.decision}`,
    );
    assert(
      JSON.stringify(r1.articles.sort()) === JSON.stringify(r2.articles.sort()),
      `${id}: inconsistent articles`,
    );
  }
});
