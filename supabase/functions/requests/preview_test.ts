/**
 * Tests for POST /requests/preview (Issue #43, EHDS Track 3)
 *
 * Covered:
 *   1. R01 body returns APPROVE_STATISTICAL with a plan_summary.
 *   2. A nonsense definition is reported with its index in unreadable[].
 *   3. A fake database passed to createHandler receives zero queries for preview.
 */

import { createHandler, type RequestDatabase } from "./handler.ts";

function assert(ok: boolean, message = "Assertion failed"): asserts ok {
  if (!ok) throw new Error(message);
}

/** Build a minimal POST /requests/preview request. */
function previewRequest(body: unknown): Request {
  return new Request("https://example.com/requests/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A fake sql client that throws if it is ever called. */
function makeGuardSql(): RequestDatabase {
  const boom = () => {
    throw new Error("SQL must not be called during preview");
  };
  // Satisfy the full RequestDatabase interface (template-tag + json + unsafe + begin + end).
  const client = boom as unknown as RequestDatabase;
  (client as unknown as Record<string, unknown>)["unsafe"] = boom;
  (client as unknown as Record<string, unknown>)["begin"] = boom;
  (client as unknown as Record<string, unknown>)["json"] = boom;
  (client as unknown as Record<string, unknown>)["end"] = () => Promise.resolve();
  return client;
}

const handler = createHandler(() => makeGuardSql());

const R01_BODY = {
  requested_as: "health data request",
  requested_format: "anonymised statistics",
  purpose:
    "We study regional differences in type 2 diabetes to plan a prevention programme with the regional health authorities.",
  question:
    "How many adults have type 2 diabetes in each region and what is the prevalence?",
  definitions: [
    "Adult = aged 18 or older on 31 December 2025.",
    "Type 2 diabetes = any condition with an ICD-10 code starting with E11.",
    "Prevalence = adults with type 2 diabetes / all adults in the region × 100, one decimal.",
    "Report per region: adults, adults with type 2 diabetes and the prevalence.",
  ],
};

// ---------------------------------------------------------------------------
// 1. R01 preview: APPROVE_STATISTICAL + plan_summary
// ---------------------------------------------------------------------------
Deno.test("preview R01: APPROVE_STATISTICAL with plan_summary, no sql", async () => {
  const res = await handler(previewRequest(R01_BODY));
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json() as Record<string, unknown>;
  assert(
    body.decision === "APPROVE_STATISTICAL",
    `expected APPROVE_STATISTICAL, got ${body.decision}`,
  );
  assert(
    typeof body.plan_summary === "string" && body.plan_summary.length > 0,
    `plan_summary must be a non-empty string, got ${body.plan_summary}`,
  );
  assert(
    Array.isArray(body.unreadable) && body.unreadable.length === 0,
    `unreadable must be empty for R01`,
  );
  assert(
    Array.isArray(body.articles) && body.articles.includes("53"),
    "articles must include 53",
  );
  assert(typeof body.rule === "string" && body.rule.length > 0, "rule must be set");
});

// ---------------------------------------------------------------------------
// 2. Nonsense definition is reported with its index in unreadable[]
// ---------------------------------------------------------------------------
Deno.test("preview: nonsense definition reported with index", async () => {
  const body = {
    ...R01_BODY,
    definitions: [
      "Adult = aged 18 or older on 31 December 2025.",
      "This is completely made up and the parser cannot understand it at all.",
      "Report per region: adults.",
    ],
  };
  const res = await handler(previewRequest(body));
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const result = await res.json() as {
    unreadable: { index: number; definition: string; reason: string }[];
    decision: string;
  };
  assert(
    Array.isArray(result.unreadable) && result.unreadable.length >= 1,
    "must have at least one unreadable entry",
  );
  const bad = result.unreadable.find((u) =>
    u.definition.includes("completely made up")
  );
  assert(bad !== undefined, "must report the nonsense definition");
  assert(bad.index === 1, `expected index 1, got ${bad.index}`);
  assert(typeof bad.reason === "string" && bad.reason.length > 0, "reason must be set");
});

// ---------------------------------------------------------------------------
// 3. Preview issues zero SQL queries (guard sql throws if called)
// ---------------------------------------------------------------------------
Deno.test("preview: zero SQL queries for any preview request", async () => {
  // The guard sql would throw if unsafe() or begin() were called.
  // If this test reaches the assertion the handler never touched sql.
  const res = await handler(previewRequest(R01_BODY));
  assert(res.status === 200, `expected 200, got ${res.status}`);
  // Also check with a REJECT body — still no sql.
  const rejectBody = {
    ...R01_BODY,
    purpose: "Align insurance premiums with patient risk profiles.",
  };
  const res2 = await handler(previewRequest(rejectBody));
  assert(res2.status === 200, `expected 200 for REJECT preview, got ${res2.status}`);
  const body2 = await res2.json() as { decision: string };
  assert(body2.decision === "REJECT", `expected REJECT, got ${body2.decision}`);
});

// ---------------------------------------------------------------------------
// 4. Missing required fields return 400
// ---------------------------------------------------------------------------
Deno.test("preview: missing required field returns 400", async () => {
  const res = await handler(previewRequest({ purpose: "research" }));
  assert(res.status === 400, `expected 400, got ${res.status}`);
});
