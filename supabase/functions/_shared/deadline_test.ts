/**
 * Tests for computeDeadline() — Issue #74
 *
 * Key assertion: basis_quote is a verbatim substring of the stored regulation text.
 */

import REG from "./regulation/reg_2025_327.json" with { type: "json" };
import { computeDeadline } from "./deadline.ts";

function assert(ok: boolean, message = "Assertion failed"): asserts ok {
  if (!ok) throw new Error(message);
}

// ---------------------------------------------------------------------------
// 1. basis_quote is a verbatim substring of the stored regulation text
// ---------------------------------------------------------------------------

Deno.test("Art. 68(4) basis_quote is a verbatim substring of stored text", () => {
  const deadline = computeDeadline("health data access application", "2026-01-15T00:00:00Z");
  assert(deadline !== null, "computeDeadline must not return null for a valid data access application");
  const para = (REG.articles as Record<string, { paragraphs: { ref: string; text: string }[] }>)["68"]
    ?.paragraphs.find((p) => p.ref === "4");
  assert(para !== undefined, "Art. 68(4) must exist in stored regulation");
  assert(
    para.text.includes(deadline.basis_quote),
    `basis_quote must be a verbatim substring of Art. 68(4).\n` +
      `  basis_quote: "${deadline.basis_quote}"\n` +
      `  paragraph:   "${para.text.slice(0, 120)}…"`,
  );
});

Deno.test("Art. 69(4) basis_quote is a verbatim substring of stored text", () => {
  const deadline = computeDeadline("health data request", "2026-01-15T00:00:00Z");
  assert(deadline !== null, "computeDeadline must not return null for a valid health data request");
  const para = (REG.articles as Record<string, { paragraphs: { ref: string; text: string }[] }>)["69"]
    ?.paragraphs.find((p) => p.ref === "4");
  assert(para !== undefined, "Art. 69(4) must exist in stored regulation");
  assert(
    para.text.includes(deadline.basis_quote),
    `basis_quote must be a verbatim substring of Art. 69(4).\n` +
      `  basis_quote: "${deadline.basis_quote}"\n` +
      `  paragraph:   "${para.text.slice(0, 120)}…"`,
  );
});

// ---------------------------------------------------------------------------
// 2. Due date is 3 months after submission
// ---------------------------------------------------------------------------

Deno.test("deadline due is 3 calendar months after submission", () => {
  const deadline = computeDeadline("health data access application", "2026-01-15T00:00:00Z");
  assert(deadline !== null, "must return a deadline");
  assert(deadline.due === "2026-04-15", `expected 2026-04-15, got ${deadline.due}`);
  assert(deadline.basis_ref === "Art. 68(4)", `expected Art. 68(4), got ${deadline.basis_ref}`);
});

Deno.test("health data request: due is 3 months after submission", () => {
  const deadline = computeDeadline("health data request", "2026-10-31T00:00:00Z");
  assert(deadline !== null, "must return a deadline");
  assert(deadline.due === "2027-01-31", `expected 2027-01-31, got ${deadline.due}`);
  assert(deadline.basis_ref === "Art. 69(4)", `expected Art. 69(4), got ${deadline.basis_ref}`);
});

// ---------------------------------------------------------------------------
// 3. Edge cases
// ---------------------------------------------------------------------------

Deno.test("unknown requested_as returns null", () => {
  const result = computeDeadline("unknown type", "2026-01-15T00:00:00Z");
  assert(result === null, "unknown requested_as must return null");
});

Deno.test("invalid submitted date returns null", () => {
  const result = computeDeadline("health data request", "not-a-date");
  assert(result === null, "invalid date must return null");
});

Deno.test("empty submitted returns null", () => {
  const result = computeDeadline("health data request", "");
  assert(result === null, "empty submitted must return null");
});
