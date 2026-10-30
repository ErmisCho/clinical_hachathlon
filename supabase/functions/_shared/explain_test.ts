/**
 * Tests for the explain module (Issue #33, EHDS Track 3).
 *
 * No database, no remote imports.
 *
 * Covered:
 *   1. verifyQuotes accepts real quotes from reg_2025_327.json
 *   2. verifyQuotes rejects a tampered quote
 *   3. verifyQuotes rejects a non-verbatim trigger phrase
 *   4. R01–R10 explanations all pass verifyQuotes
 *   5. Decisions and articles are unchanged (smoke-check)
 */

import { explain, verifyQuotes } from "./explain.ts";
import { decide } from "./decision.ts";
import { REQUESTS } from "./decision_fixtures.ts";
import * as planExamples from "./plan_examples.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// 1. verifyQuotes accepts real quotes
// ---------------------------------------------------------------------------
Deno.test("verifyQuotes: accepts real quotes from stored regulation", () => {
  const req = REQUESTS["R01"];
  const dr = decide(req);
  const exp = explain(req, dr, planExamples.R01);
  const ok = verifyQuotes(exp, req);
  assert(ok, "verifyQuotes must return true for real regulation quotes");
});

// ---------------------------------------------------------------------------
// 2. verifyQuotes rejects a tampered quote
// ---------------------------------------------------------------------------
Deno.test("verifyQuotes: rejects a tampered article quote", () => {
  const req = REQUESTS["R01"];
  const dr = decide(req);
  const exp = explain(req, dr, planExamples.R01);
  // Tamper the first article's quote
  const tampered = {
    ...exp,
    articles: exp.articles.map((a, i) =>
      i === 0 ? { ...a, quote: a.quote + " [TAMPERED]" } : a
    ),
  };
  const ok = verifyQuotes(tampered, req);
  assert(!ok, "verifyQuotes must return false for a tampered quote");
});

// ---------------------------------------------------------------------------
// 3a. verifyQuotes rejects a phrase containing "…" (context window with ellipsis)
// ---------------------------------------------------------------------------
Deno.test("verifyQuotes: rejects a trigger phrase containing '…' (ellipsis)", () => {
  const req = REQUESTS["R02"]; // REJECT
  const dr = decide(req);
  const exp = explain(req, dr);
  // Insert an ellipsis-context phrase; this must FAIL verbatim check
  const bad = {
    ...exp,
    trigger_phrases: ["…health insurance premiums…"],
  };
  const ok = verifyQuotes(bad, req);
  assert(!ok, "verifyQuotes must return false for a phrase with '…'");
});

// ---------------------------------------------------------------------------
// 3b. verifyQuotes rejects a phrase not present in the request at all
// ---------------------------------------------------------------------------
Deno.test("verifyQuotes: rejects a phrase not in the request", () => {
  const req = REQUESTS["R02"];
  const dr = decide(req);
  const exp = explain(req, dr);
  const bad = {
    ...exp,
    trigger_phrases: ["this phrase does not appear in the request at all"],
  };
  const ok = verifyQuotes(bad, req);
  assert(!ok, "verifyQuotes must return false for a non-verbatim trigger phrase");
});

// ---------------------------------------------------------------------------
// 4. R01–R10 explanations all pass verifyQuotes
// ---------------------------------------------------------------------------
const PLAN_EXAMPLES: Record<string, unknown> = {
  R01: planExamples.R01,
  R02: planExamples.R02,
  R03: planExamples.R03,
  R04: planExamples.R04,
  R05: planExamples.R05,
  R06: planExamples.R06,
  R07: planExamples.R07,
  R08: planExamples.R08,
  R09: planExamples.R09,
  R10: planExamples.R10,
};

import type { QueryPlan } from "./plan.ts";

for (const id of Object.keys(REQUESTS)) {
  Deno.test(`${id}: explanation passes verifyQuotes`, () => {
    const req = REQUESTS[id];
    const dr = decide(req);
    const plan = PLAN_EXAMPLES[id] as QueryPlan | undefined;
    const exp = explain(req, dr, plan);
    const ok = verifyQuotes(exp, req);
    assert(
      ok,
      `${id}: verifyQuotes failed – check trigger_phrases or quotes`,
    );
    // Smoke-check structure
    assert(exp.rule.length > 0, `${id}: rule must be non-empty`);
    assert(exp.articles.length > 0, `${id}: articles must be non-empty`);
    for (const art of exp.articles) {
      assert(art.quote.length > 0, `${id}: article ${art.number} quote must be non-empty`);
      assert(art.summary.length > 0, `${id}: article ${art.number} summary must be non-empty`);
      assert(art.ref.length > 0, `${id}: article ${art.number} ref must be non-empty`);
    }
  });
}

// ---------------------------------------------------------------------------
// 5. Decisions and articles unchanged for R01–R10
// ---------------------------------------------------------------------------
Deno.test("decisions and articles unchanged after explain changes", () => {
  const EXPECTED: Record<string, { decision: string; articles: string[] }> = {
    R01: { decision: "APPROVE_STATISTICAL", articles: ["53", "69"] },
    R02: { decision: "REJECT", articles: ["54"] },
    R03: { decision: "APPROVE_STATISTICAL", articles: ["53", "69"] },
    R04: { decision: "REJECT", articles: ["54"] },
    R05: { decision: "APPROVE_SPE", articles: ["53", "66", "68", "73"] },
    R06: { decision: "REJECT", articles: ["54"] },
    R07: { decision: "APPROVE_STATISTICAL", articles: ["53", "69"] },
    R08: { decision: "APPROVE_STATISTICAL", articles: ["53", "69"] },
    R09: { decision: "APPROVE_STATISTICAL", articles: ["53", "66", "69"] },
    R10: { decision: "REJECT", articles: ["54"] },
  };
  for (const id of Object.keys(REQUESTS)) {
    const dr = decide(REQUESTS[id]);
    const ex = EXPECTED[id];
    assert(
      dr.decision === ex.decision,
      `${id}: expected decision ${ex.decision}, got ${dr.decision}`,
    );
    for (const art of ex.articles) {
      assert(
        dr.articles.includes(art),
        `${id}: expected article ${art} in [${dr.articles.join(", ")}]`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 6. trigger_phrases are verbatim substrings of the request for all R01-R10
//    (no ellipsis stripping needed — they must already be exact substrings)
// ---------------------------------------------------------------------------
Deno.test("trigger_phrases are verbatim substrings of the request for R01–R10", () => {
  for (const id of Object.keys(REQUESTS)) {
    const req = REQUESTS[id];
    const dr = decide(req);
    const text = `${req.purpose ?? ""} ${req.question ?? ""}`;
    for (const phrase of dr.matched) {
      if (phrase.length === 0) continue;
      // No ellipsis expected — exact substring check
      assert(
        !phrase.includes("\u2026"),
        `${id}: matched phrase must not contain '…': "${phrase}"`,
      );
      assert(
        text.includes(phrase),
        `${id}: matched phrase not found in request: "${phrase}"`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 7. plan_summary is set for approved requests with a plan
// ---------------------------------------------------------------------------
Deno.test("plan_summary is present for approved requests", () => {
  for (const id of ["R01", "R03", "R05", "R07", "R08", "R09"]) {
    const req = REQUESTS[id];
    const dr = decide(req);
    const plan = PLAN_EXAMPLES[id] as QueryPlan | undefined;
    if (!plan) continue;
    const exp = explain(req, dr, plan);
    assert(
      typeof exp.plan_summary === "string" && exp.plan_summary.length > 0,
      `${id}: plan_summary must be present and non-empty`,
    );
  }
});

// ---------------------------------------------------------------------------
// 8. Exact trigger phrases for specific requests — short and no ellipses
// ---------------------------------------------------------------------------
Deno.test("R02: trigger phrase is exact substring 'insurance premiums'", () => {
  const dr = decide(REQUESTS["R02"]);
  assert(dr.matched.length > 0, "R02: must have matched phrases");
  // The prohibited pattern /insurance\s+premium/i fires on "insurance premiums"
  const hasInsurance = dr.matched.some((p) =>
    /insurance.+premium/i.test(p) && !p.includes("\u2026")
  );
  assert(hasInsurance, `R02: expected an exact 'insurance premium*' phrase, got: ${JSON.stringify(dr.matched)}`);
  // Each matched phrase must be in the request text
  const text = `${REQUESTS["R02"].purpose} ${REQUESTS["R02"].question ?? ""}`;
  for (const p of dr.matched) {
    assert(text.includes(p), `R02: matched phrase not in request: "${p}"`);
  }
});

Deno.test("R05: trigger phrase is exact SPE justification, e.g. 'aggregates are not enough'", () => {
  const dr = decide(REQUESTS["R05"]);
  assert(dr.decision === "APPROVE_SPE", "R05 must be APPROVE_SPE");
  assert(dr.matched.length > 0, "R05: must have matched phrases");
  const text = `${REQUESTS["R05"].purpose} ${REQUESTS["R05"].question ?? ""}`;
  for (const p of dr.matched) {
    assert(!p.includes("\u2026"), `R05: matched phrase must not contain '…': "${p}"`);
    assert(text.includes(p), `R05: matched phrase not in request: "${p}"`);
  }
  // Check deduplication: no duplicate phrases
  assert(
    dr.matched.length === new Set(dr.matched).size,
    "R05: matched phrases must be deduplicated",
  );
});

Deno.test("R10: trigger phrase is exact substring matching 'nicotine' (tobacco rule)", () => {
  const dr = decide(REQUESTS["R10"]);
  assert(dr.matched.length > 0, "R10: must have matched phrases");
  // The first tobacco pattern (/\bnicotine\b/i) fires and matches "nicotine"
  const hasNicotine = dr.matched.some((p) =>
    /nicotine/i.test(p) && !p.includes("\u2026")
  );
  assert(hasNicotine, `R10: expected an exact nicotine phrase, got: ${JSON.stringify(dr.matched)}`);
  // Every phrase must be an exact verbatim substring of the request (no ellipses)
  const text = `${REQUESTS["R10"].purpose} ${REQUESTS["R10"].question ?? ""}`;
  for (const p of dr.matched) {
    assert(!p.includes("\u2026"), `R10: matched phrase must not contain '…': "${p}"`);
    assert(text.includes(p), `R10: matched phrase not in request: "${p}"`);
  }
});

// ---------------------------------------------------------------------------
// 9. trigger_context contains ellipsis-annotated display strings (parallel to matched)
// ---------------------------------------------------------------------------
Deno.test("matched_context contains '…' markers; matched does not", () => {
  // R02 is a clean REJECT with a well-known prohibited pattern
  const req = REQUESTS["R02"];
  const dr = decide(req);
  assert(dr.matched.length > 0, "R02 must have matched phrases");
  // matched: no ellipses
  for (const p of dr.matched) {
    assert(!p.includes("\u2026"), `matched phrase must not contain '…': "${p}"`);
  }
  // matched_context: at least one should have a context window (may or may not have '…'
  // depending on position, but must be present and non-empty)
  assert(
    dr.matched_context.length === dr.matched.length,
    "matched_context must be parallel to matched",
  );
  for (const ctx of dr.matched_context) {
    assert(ctx.length > 0, "matched_context entries must be non-empty");
  }
});


// ---------------------------------------------------------------------------
// 10. Every article has a non-empty `applies` that is a verbatim substring of `quote`
//     for R01–R10 (sample fixtures)
// ---------------------------------------------------------------------------
Deno.test("R01–R10: every article has non-empty applies that is a substring of quote", () => {
  for (const id of Object.keys(REQUESTS)) {
    const req = REQUESTS[id];
    const dr = decide(req);
    const plan = PLAN_EXAMPLES[id] as QueryPlan | undefined;
    const exp = explain(req, dr, plan);
    for (const art of exp.articles) {
      assert(
        art.applies.length > 0,
        `${id}: article ${art.number} must have a non-empty applies`,
      );
      assert(
        art.quote.includes(art.applies),
        `${id}: article ${art.number} applies must be a substring of quote.\napplies: "${art.applies}"\nquote: "${art.quote.slice(0, 120)}..."`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 11. R02 Art. 54 ref includes paragraph and point; applies is a verbatim
//     substring of the quote
// ---------------------------------------------------------------------------
Deno.test("R02: Art. 54 ref names a paragraph and point (Art. 54(1)(b))", () => {
  const req = REQUESTS["R02"];
  const dr = decide(req);
  const exp = explain(req, dr);
  const art54 = exp.articles.find((a) => a.number === "54");
  assert(art54 !== undefined, "R02: must include Art. 54");
  // Should include "(1)" (paragraph) and "(b)" (point for insurance premiums)
  assert(
    art54.ref.includes("(1)"),
    `R02: Art. 54 ref must include "(1)" paragraph, got: "${art54.ref}"`,
  );
  assert(
    art54.ref.includes("(b)"),
    `R02: Art. 54 ref must include the specific point "(b)", got: "${art54.ref}"`,
  );
  assert(
    art54.point === "(b)",
    `R02: Art. 54 point must be "(b)", got: "${art54.point}"`,
  );
  assert(
    art54.applies.length > 0,
    "R02: Art. 54 applies must be non-empty",
  );
  assert(
    art54.quote.includes(art54.applies),
    `R02: Art. 54 applies must be substring of quote.\napplies: "${art54.applies}"`,
  );
});

// ---------------------------------------------------------------------------
// 12. R05 Art. 53 maps to point (e)(ii) — algorithm training sub-point
// ---------------------------------------------------------------------------
Deno.test("R05: Art. 53 maps to point (e)(ii) for model training", () => {
  const req = REQUESTS["R05"];
  const dr = decide(req);
  const exp = explain(req, dr, PLAN_EXAMPLES["R05"] as QueryPlan);
  const art53 = exp.articles.find((a) => a.number === "53");
  assert(art53 !== undefined, "R05: must include Art. 53");
  assert(
    art53.point === "(e)(ii)",
    `R05: Art. 53 point must be "(e)(ii)" for model training, got: "${art53.point}"`,
  );
  assert(
    art53.ref.includes("(e)(ii)"),
    `R05: Art. 53 ref must include "(e)(ii)", got: "${art53.ref}"`,
  );
  assert(
    art53.applies.length > 0,
    "R05: Art. 53 applies must be non-empty",
  );
  assert(
    art53.quote.includes(art53.applies),
    `R05: Art. 53 applies must be substring of quote.\napplies: "${art53.applies}"`,
  );
});

// ---------------------------------------------------------------------------
// 13. R08 plan_summary uses readable names, not raw codes
// ---------------------------------------------------------------------------
Deno.test("R08: plan_summary uses readable names not raw codes", () => {
  const req = REQUESTS["R08"];
  const dr = decide(req);
  const exp = explain(req, dr, PLAN_EXAMPLES["R08"] as QueryPlan);
  assert(exp.plan_summary !== undefined, "R08: plan_summary must be present");
  const ps = exp.plan_summary!;
  // Must NOT contain raw snake_case metric labels or bare LOINC/ICD codes as labels
  assert(
    !ps.includes("mean_bmi"),
    `R08: plan_summary must not contain raw label 'mean_bmi', got: "${ps}"`,
  );
  assert(
    !ps.includes("women_with_bmi"),
    `R08: plan_summary must not contain raw label 'women_with_bmi', got: "${ps}"`,
  );
  // Must contain readable name for BMI
  assert(
    ps.toLowerCase().includes("bmi"),
    `R08: plan_summary must mention BMI, got: "${ps}"`,
  );
  // Must contain ICD-10 C50 (breast cancer) — with readable name
  assert(
    ps.includes("C50") || ps.toLowerCase().includes("breast cancer"),
    `R08: plan_summary must mention breast cancer or C50, got: "${ps}"`,
  );
  // Must contain LOINC 39156-5 in brackets
  assert(
    ps.includes("39156-5"),
    `R08: plan_summary must still include LOINC code in brackets, got: "${ps}"`,
  );
});

// ---------------------------------------------------------------------------
// 14. verifyQuotes also rejects a tampered applies field
// ---------------------------------------------------------------------------
Deno.test("verifyQuotes: rejects an applies field not in the quote", () => {
  const req = REQUESTS["R01"];
  const dr = decide(req);
  const exp = explain(req, dr, PLAN_EXAMPLES["R01"] as QueryPlan);
  const tampered = {
    ...exp,
    articles: exp.articles.map((a, i) =>
      i === 0 ? { ...a, applies: a.applies + " [TAMPERED]" } : a
    ),
  };
  const ok = verifyQuotes(tampered, req);
  assert(!ok, "verifyQuotes must return false when applies is not a substring of quote");
});

// ---------------------------------------------------------------------------
// 15. Exact ref for each of R01-R10 (point-level precision)
// ---------------------------------------------------------------------------
Deno.test("R01–R10: exact Art. 53/54 ref matches expected point", () => {
  const EXPECTED_REFS: Record<string, string> = {
    R01: "Art. 53(1)(a)",
    R02: "Art. 54(1)(b)",
    R03: "Art. 53(1)(b)",
    R04: "Art. 54(1)(c)",
    R05: "Art. 53(1)(e)(ii)",
    R06: "Art. 54(1)(b)",
    R07: "Art. 53(1)(c)",
    R08: "Art. 53(1)(e)",
    R09: "Art. 53(1)(d)",
    R10: "Art. 54(1)(d)",
  };
  for (const [id, expectedRef] of Object.entries(EXPECTED_REFS)) {
    const req = REQUESTS[id];
    const dr = decide(req);
    const exp = explain(req, dr);
    const art53 = exp.articles.find((a) => a.number === "53");
    const art54 = exp.articles.find((a) => a.number === "54");
    const artRef = art53 ? art53.ref : art54?.ref;
    assert(
      artRef === expectedRef,
      `${id}: expected ref "${expectedRef}", got "${artRef}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// 16. R01 plan_summary uses readable names, not raw snake_case
// ---------------------------------------------------------------------------
Deno.test("R01: plan_summary uses readable names not raw codes", () => {
  const req = REQUESTS["R01"];
  const dr = decide(req);
  const exp = explain(req, dr, PLAN_EXAMPLES["R01"] as QueryPlan);
  assert(exp.plan_summary !== undefined, "R01: plan_summary must be present");
  const ps = exp.plan_summary!;
  // Must NOT contain raw snake_case labels
  assert(!ps.includes("type2_diabetes"), `R01: must not contain 'type2_diabetes', got: "${ps}"`);
  assert(!ps.includes("prevalence_pct"), `R01: must not contain 'prevalence_pct', got: "${ps}"`);
  // Must contain readable form
  assert(
    ps.toLowerCase().includes("type 2 diabetes"),
    `R01: must mention 'type 2 diabetes', got: "${ps}"`,
  );
  assert(ps.includes("E11"), `R01: must include ICD-10 code E11, got: "${ps}"`);
  assert(
    ps.toLowerCase().includes("prevalence"),
    `R01: must mention 'prevalence', got: "${ps}"`,
  );
});

// ---------------------------------------------------------------------------
// 17. R03 plan_summary uses readable names, not raw snake_case
// ---------------------------------------------------------------------------
Deno.test("R03: plan_summary uses readable names not raw codes", () => {
  const req = REQUESTS["R03"];
  const dr = decide(req);
  const exp = explain(req, dr, PLAN_EXAMPLES["R03"] as QueryPlan);
  assert(exp.plan_summary !== undefined, "R03: plan_summary must be present");
  const ps = exp.plan_summary!;
  // Must NOT contain raw snake_case labels
  assert(!ps.includes("af_patients"), `R03: must not contain 'af_patients', got: "${ps}"`);
  assert(!ps.includes("without_oac"), `R03: must not contain raw 'without_oac', got: "${ps}"`);
  assert(!ps.includes("share_without_oac_pct"), `R03: must not contain 'share_without_oac_pct', got: "${ps}"`);
  // Must contain readable forms
  assert(
    ps.toLowerCase().includes("atrial fibrillation"),
    `R03: must mention 'atrial fibrillation', got: "${ps}"`,
  );
  assert(
    ps.toLowerCase().includes("anticoagulant"),
    `R03: must mention 'anticoagulant', got: "${ps}"`,
  );
  assert(
    ps.toLowerCase().includes("share"),
    `R03: must mention 'share', got: "${ps}"`,
  );
});
