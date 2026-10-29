/**
 * Unit tests for r07.ts pure logic.
 * No remote imports — all assertions use the built-in Deno.test runner.
 */
import {
  applySmallCell,
  buildR07Answer,
  buildR07Response,
  R07_ARTICLES,
  R07_DECISION,
  R07_REASON,
} from "./r07.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

// ---------------------------------------------------------------------------
// applySmallCell
// ---------------------------------------------------------------------------

Deno.test("applySmallCell: 0 → '<10'", () => {
  assertEquals(applySmallCell(0), "<10", "zero should be suppressed");
});

Deno.test("applySmallCell: 9 → '<10'", () => {
  assertEquals(applySmallCell(9), "<10", "9 should be suppressed");
});

Deno.test("applySmallCell: 10 → 10", () => {
  assertEquals(applySmallCell(10), 10, "10 should pass through");
});

Deno.test("applySmallCell: 245 → 245", () => {
  assertEquals(applySmallCell(245), 245, "large count passes through");
});

// ---------------------------------------------------------------------------
// buildR07Answer
// ---------------------------------------------------------------------------

const REGIONS = ["Burgenland", "Wien", "Tirol"];

Deno.test("buildR07Answer: all regions present even if not in rows", () => {
  const answer = buildR07Answer([{ region: "Wien", stay_count: 50 }], REGIONS);
  assert("Burgenland" in answer, "Burgenland must appear");
  assert("Wien" in answer, "Wien must appear");
  assert("Tirol" in answer, "Tirol must appear");
});

Deno.test("buildR07Answer: missing regions treated as 0, hence '<10'", () => {
  const answer = buildR07Answer([], REGIONS);
  assertEquals(answer["Burgenland"], "<10", "empty region gets <10");
  assertEquals(answer["Wien"], "<10", "empty region gets <10");
});

Deno.test("buildR07Answer: region with count 28 passes through", () => {
  const answer = buildR07Answer([{ region: "Burgenland", stay_count: 28 }], [
    "Burgenland",
  ]);
  assertEquals(answer["Burgenland"], 28, "28 >= 10 so no suppression");
});

Deno.test("buildR07Answer: region with count 5 is suppressed", () => {
  const answer = buildR07Answer([{ region: "Tirol", stay_count: 5 }], [
    "Tirol",
  ]);
  assertEquals(answer["Tirol"], "<10", "5 < 10 so suppressed");
});

Deno.test("buildR07Answer: matches expected.json sample values", () => {
  const rows = [
    { region: "Burgenland", stay_count: 28 },
    { region: "KArnten", stay_count: 69 },
    { region: "NiederAsterreich", stay_count: 187 },
    { region: "OberAsterreich", stay_count: 194 },
    { region: "Salzburg", stay_count: 69 },
    { region: "Steiermark", stay_count: 140 },
    { region: "Tirol", stay_count: 86 },
    { region: "Vorarlberg", stay_count: 61 },
    { region: "Wien", stay_count: 245 },
  ];
  const regions = rows.map((r) => r.region);
  const answer = buildR07Answer(rows, regions);

  assertEquals(answer["Burgenland"], 28, "Burgenland");
  assertEquals(answer["KArnten"], 69, "KArnten");
  assertEquals(answer["NiederAsterreich"], 187, "NiederAsterreich");
  assertEquals(answer["OberAsterreich"], 194, "OberAsterreich");
  assertEquals(answer["Wien"], 245, "Wien");
});

// ---------------------------------------------------------------------------
// buildR07Response
// ---------------------------------------------------------------------------

Deno.test("buildR07Response: correct envelope fields", () => {
  const answer = buildR07Answer([{ region: "Wien", stay_count: 50 }], [
    "Wien",
  ]);
  const resp = buildR07Response(answer);
  assertEquals(resp.request_id, "R07", "request_id");
  assertEquals(resp.decision, R07_DECISION, "decision");
  assertEquals(resp.articles, R07_ARTICLES, "articles");
  assertEquals(resp.reason, R07_REASON, "reason");
  assertEquals(resp.answer, answer, "answer");
});

Deno.test("buildR07Response: articles are 53 and 69", () => {
  const resp = buildR07Response({});
  assert(
    resp.articles.includes("53") && resp.articles.includes("69"),
    "must cite articles 53 and 69",
  );
});
