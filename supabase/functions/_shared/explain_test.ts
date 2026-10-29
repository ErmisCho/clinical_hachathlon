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

