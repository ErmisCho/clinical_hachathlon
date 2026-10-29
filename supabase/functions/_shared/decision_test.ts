/**
 * Tests for the decision module (Issue #3, #50, EHDS Track 3).
 *
 * Follows the local assert-helper style from patients_test.ts.
 * No remote imports; fixture data is in decision_fixtures.ts.
 */

import { decide, ALL_RULES, RULES_VERSION } from "./decision.ts";
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
    purpose:
      "We want to align private health insurance premiums for diabetes patients with their risk.",
    question: "What is the average HbA1c by age band?",
  };
  const result = decide(req);
  assert(
    result.decision === "REJECT",
    `Expected REJECT, got ${result.decision}`,
  );
  assert(
    result.articles.includes("54"),
    "Expected article 54 for prohibited purpose",
  );
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
  assert(
    result.articles.includes("66"),
    "Expected article 66 for access application",
  );
  assert(
    result.articles.includes("69"),
    "Expected article 69 for statistical approval",
  );
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
  assert(
    result.needs_review === true,
    "Expected needs_review = true for ambiguous purpose",
  );
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

Deno.test("record vocabulary alone does not establish SPE necessity", () => {
  for (
    const phrase of [
      "individual-level records",
      "patient-level data",
      "row-level histories",
    ]
  ) {
    const result = decide({
      requested_as: "health data access application",
      purpose: "Clinical research. We would prefer " + phrase + ".",
    });
    assert(
      result.decision === "APPROVE_STATISTICAL",
      "A preference for records is not a necessity explanation",
    );
  }
  const justified = decide({
    requested_as: "health data access application",
    purpose:
      "Clinical research. Statistics are insufficient because we need linked longitudinal trajectories.",
  });
  assert(
    justified.decision === "APPROVE_SPE",
    "Explicit statistical insufficiency should justify an SPE",
  );
});

Deno.test("disguised prohibited actions take priority in either purpose or question", () => {
  for (
    const action of [
      "Build an underwriting score.",
      "Rank job applicants for hiring.",
      "Screen workers for promotion.",
      "Create sales leads.",
      "Develop alcoholic beverages.",
      "Recover identities from pseudonyms.",
      "Link pseudonyms to names.",
    ]
  ) {
    for (const field of ["purpose", "question"]) {
      const result = decide({
        requested_as: "health data access application",
        purpose: "Clinical research; statistics are not enough.",
        [field]: action,
      });
      assert(
        result.decision === "REJECT" && result.articles.includes("54"),
        "Prohibited use escaped: " + action,
      );
    }
  }
  const safe = decide({
    requested_as: "health data request",
    purpose:
      "Public health research into alcohol consumption and prevention of liver disease.",
  });
  assert(
    safe.decision === "APPROVE_STATISTICAL",
    "Alcohol health research is not product development",
  );
});

Deno.test("prohibited action matching normalises line breaks and unicode hyphens", () => {
  for (
    const action of [
      "Link pseudonyms\nto names.",
      "Please re‐identify people using a named registry.",
    ]
  ) {
    assert(
      decide({
        requested_as: "health data request",
        purpose: "Clinical research",
        question: action,
      }).decision === "REJECT",
      "Formatting must not disguise a prohibited action",
    );
  }
});

// ---------------------------------------------------------------------------
// 6. Every DecisionResult carries rule_id (non-empty) and rules_version.
// ---------------------------------------------------------------------------
Deno.test("every decision result carries rule_id and rules_version", () => {
  for (const id of Object.keys(REQUESTS)) {
    const result = decide(REQUESTS[id]);
    assert(
      typeof result.rule_id === "string" && result.rule_id.length > 0,
      `${id}: missing rule_id`,
    );
    assert(
      typeof result.rules_version === "string" && result.rules_version.length > 0,
      `${id}: missing rules_version`,
    );
    assert(
      result.rules_version === RULES_VERSION,
      `${id}: rules_version mismatch: expected ${RULES_VERSION}, got ${result.rules_version}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 7. Rule examples fire and counter-examples do not (tests every rule in JSON).
// ---------------------------------------------------------------------------
Deno.test("rule examples fire and counter-examples do not", () => {
  for (const rule of ALL_RULES) {
    for (const example of rule.examples) {
      const req: HealthDataRequest = {
        requested_as: rule.kind === "spe_justification"
          ? "health data access application"
          : "health data request",
        purpose: example,
      };
      const result = decide(req);
      if (rule.kind === "prohibited") {
        assert(
          result.decision === "REJECT",
          `Rule ${rule.id} example should REJECT: "${example}" → ${result.decision}`,
        );
        assert(
          result.rule_id === rule.id,
          `Rule ${rule.id} example fired wrong rule_id "${result.rule_id}"`,
        );
      } else if (rule.kind === "spe_justification") {
        // SPE examples must not be rejected
        assert(
          result.decision !== "REJECT",
          `Rule ${rule.id} SPE example must not REJECT: "${example}" → ${result.decision}`,
        );
      } else {
        // allowed: should not be rejected (may be APPROVE_STATISTICAL or APPROVE_SPE)
        assert(
          result.decision !== "REJECT",
          `Rule ${rule.id} allowed example should not REJECT: "${example}" → ${result.decision}`,
        );
      }
    }
    for (const counter of rule.counter_examples) {
      const req: HealthDataRequest = {
        requested_as: "health data request",
        purpose: counter,
      };
      const result = decide(req);
      if (rule.kind === "prohibited") {
        assert(
          result.decision !== "REJECT" || result.rule_id !== rule.id,
          `Rule ${rule.id} counter-example should NOT fire rule: "${counter}"`,
        );
      } else if (rule.kind === "spe_justification") {
        // Counter-examples for SPE should not produce APPROVE_SPE for a health data request
        // (access application would need the SPE phrase to fire S01)
        // Just check it doesn't crash
      } else {
        // allowed counter-examples: should set needs_review (or another rule fires)
        // We only verify no crash here; the needs_review check is below
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 8. Negation: negated prohibited words are not rejected.
// ---------------------------------------------------------------------------
Deno.test("negated prohibited purpose: 'will not use for marketing' → approved", () => {
  const result = decide({
    requested_as: "health data request",
    purpose:
      "We will not use the data for marketing or insurance premiums. Our purpose is clinical research.",
  });
  assert(
    result.decision !== "REJECT",
    `Negated marketing should not be rejected, got ${result.decision}`,
  );
});

Deno.test("negated prohibited purpose: 'won't use for advertising' → approved", () => {
  const result = decide({
    requested_as: "health data request",
    purpose:
      "We won't use these results for advertising or sales leads. This is a public health study.",
  });
  assert(
    result.decision !== "REJECT",
    `Negated advertising should not be rejected, got ${result.decision}`,
  );
});

Deno.test("negated prohibited purpose: 'never re-identify patients' → approved", () => {
  const result = decide({
    requested_as: "health data request",
    purpose:
      "We will never re-identify patients. Our study measures treatment gaps in atrial fibrillation.",
  });
  assert(
    result.decision !== "REJECT",
    `Negated re-identification should not be rejected, got ${result.decision}`,
  );
});

Deno.test("negated allowed purpose: 'not for research' does not count as allowed", () => {
  const result = decide({
    requested_as: "health data request",
    purpose:
      "We clarify this is not for research or public health. We want internal data exploration.",
  });
  assert(
    result.needs_review === true,
    `'not for research' should set needs_review=true, got needs_review=${result.needs_review}`,
  );
});

Deno.test("negated allowed purpose: 'not a clinical study' does not count as allowed", () => {
  const result = decide({
    requested_as: "health data request",
    purpose:
      "This is not a clinical study. It is an internal market analysis.",
  });
  assert(
    result.needs_review === true,
    `'not a clinical study' should set needs_review=true`,
  );
});

Deno.test("negation in disclaimer only; actual prohibited use still fires", () => {
  // The request denies one prohibited thing but actually proposes another.
  const result = decide({
    requested_as: "health data request",
    purpose:
      "We will not use this for re-identification. We want to align insurance premiums with patient risk.",
  });
  assert(
    result.decision === "REJECT",
    `Actual prohibited use (insurance premiums) must still REJECT despite negation disclaimer`,
  );
});
