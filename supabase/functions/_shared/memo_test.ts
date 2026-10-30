/**
 * Tests for memo.ts — Issue #35 (EHDS Track 3)
 *
 * No real LLM key required.  Network calls are replaced by a
 * controlled fake fetch.
 *
 * Covered:
 *   1. disabled without env vars: no fetch call, returns null
 *   2. fabricated quote → memo dropped, memo_status "rejected_unverified_quote"
 *   3. verified memo returned: memo_status "ok", quotes annotated
 *   4. decision and articles unchanged in pipeline response
 *   5. payload sent to the LLM contains no answer/patient data
 *   6. cache: second call for same key makes no additional fetch call
 */

import {
  _resetMemoCache,
  draftMemo,
} from "./memo.ts";
import { isEnabled } from "./llm_fallback.ts";

function assert(ok: boolean, message = "Assertion failed"): asserts ok {
  if (!ok) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Fake fetch helpers (same pattern as llm_fallback_test.ts)
// ---------------------------------------------------------------------------

async function withFakeFetch<T>(
  responseFn: (url: string, init: RequestInit) => Response,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  (globalThis as unknown as Record<string, unknown>)["fetch"] = (
    url: string,
    init?: RequestInit,
  ) => {
    return Promise.resolve(responseFn(url, init ?? {}));
  };
  try {
    return await fn();
  } finally {
    (globalThis as unknown as Record<string, unknown>)["fetch"] = original;
  }
}


function fakeGeneration(text: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: text } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// A real verbatim substring of Art. 53(1) from reg_2025_327.json
const REAL_QUOTE_53 =
  "scientific research related to health or care sectors that contributes to public health or health technology assessments";

// A real verbatim substring of Art. 54(1) from reg_2025_327.json
const REAL_QUOTE_54 = "carrying out advertising or marketing activities";

// ---------------------------------------------------------------------------
// 1. disabled without env vars: no fetch call, returns null
// ---------------------------------------------------------------------------

Deno.test("memo: disabled without env vars — returns null, no fetch", async () => {
  const hasKey = !!Deno.env.get("OPENROUTER_API_KEY");

  if (hasKey) {
    console.log("  [skip] LLM key present — disabled test skipped");
    return;
  }

  assert(!isEnabled(), "isEnabled() must be false without credentials");

  let fetchCalled = false;
  const original = globalThis.fetch;
  (globalThis as unknown as Record<string, unknown>)["fetch"] = () => {
    fetchCalled = true;
    return Promise.resolve(new Response("", { status: 200 }));
  };
  try {
    const result = await draftMemo(
      "Research on diabetes prevalence",
      "How many adults have type 2 diabetes?",
      "APPROVE_STATISTICAL",
      ["53", "69"],
    );
    assert(result === null, "draftMemo must return null when disabled");
    assert(!fetchCalled, "fetch must never be called when disabled");
  } finally {
    (globalThis as unknown as Record<string, unknown>)["fetch"] = original;
  }
});

// ---------------------------------------------------------------------------
// 2. fabricated quote → memo dropped, memo_status "rejected_unverified_quote"
// ---------------------------------------------------------------------------

Deno.test("memo: fabricated quote drops the memo", async () => {
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");

  Deno.env.set("OPENROUTER_API_KEY", "test-key");
  _resetMemoCache();

  try {
    // The LLM invents a quote not in the regulation
    const fabricatedMemo =
      'This request is approved under "Article 53 permits all scientific research" and "data shall be freely shared with any applicant who requests it".';

    const result = await withFakeFetch(
      (url) => {
        return fakeGeneration(fabricatedMemo);
      },
      () =>
        draftMemo(
          "Research on diabetes prevalence",
          "How many adults have type 2 diabetes?",
          "APPROVE_STATISTICAL",
          ["53", "69"],
        ),
    );

    assert(result !== null, "result must not be null (feature is enabled)");
    assert(
      result!.memo_status === "rejected_unverified_quote",
      `memo_status must be "rejected_unverified_quote", got "${result!.memo_status}"`,
    );
    assert(result!.memo === undefined, "memo field must be absent when rejected");
  } finally {
    if (originalKey !== undefined) Deno.env.set("OPENROUTER_API_KEY", originalKey);
    else Deno.env.delete("OPENROUTER_API_KEY");
    _resetMemoCache();
  }
});

// ---------------------------------------------------------------------------
// 3. verified memo returned: memo_status "ok", quotes annotated with refs
// ---------------------------------------------------------------------------

Deno.test("memo: verified memo is returned with annotated quotes", async () => {
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");

  Deno.env.set("OPENROUTER_API_KEY", "test-key");
  _resetMemoCache();

  try {
    // Use a real verbatim substring from Art. 53
    const verifiedMemo =
      `This request is approved for statistical access. Article 53 permits processing for "${REAL_QUOTE_53}". The applicant's purpose aligns with this provision.`;

    const result = await withFakeFetch(
      (url) => {
        return fakeGeneration(verifiedMemo);
      },
      () =>
        draftMemo(
          "Scientific research on cancer outcomes",
          "What is the 5-year survival rate for breast cancer by region?",
          "APPROVE_STATISTICAL",
          ["53", "69"],
          { "53": "Art. 53(1)", "69": "Art. 69(1)" },
        ),
    );

    assert(result !== null, "result must not be null");
    assert(result!.memo_status === "ok", `memo_status must be "ok", got "${result!.memo_status}"`);
    assert(result!.memo !== undefined, "memo field must be present");
    assert(result!.memo!.text.length > 0, "memo text must be non-empty");
    assert(result!.memo!.quotes.length > 0, "quotes must be non-empty");
    assert(
      typeof result!.memo!.model === "string" && result!.memo!.model.length > 0,
      "model must be set",
    );

    // The quote must be annotated with an Art. 53 ref
    const q = result!.memo!.quotes[0];
    assert(q.text === REAL_QUOTE_53, `quote text mismatch: "${q.text}"`);
    assert(q.ref === "Art. 53(1)", `quote ref must be "Art. 53(1)", got "${q.ref}"`);
  } finally {
    if (originalKey !== undefined) Deno.env.set("OPENROUTER_API_KEY", originalKey);
    else Deno.env.delete("OPENROUTER_API_KEY");
    _resetMemoCache();
  }
});

// ---------------------------------------------------------------------------
// 4. decision and articles are unchanged in the pipeline response
// ---------------------------------------------------------------------------

Deno.test("memo: decision and articles unchanged in pipeline response", async () => {
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");

  Deno.env.set("OPENROUTER_API_KEY", "test-key");
  _resetMemoCache();

  try {
    const { answerRequest } = await import("./pipeline.ts");
    const { _resetMemCache } = await import("./llm_fallback.ts");
    _resetMemCache();

    // R01 from decision_fixtures: APPROVE_STATISTICAL, articles [53, 69]
    const { REQUESTS } = await import("./decision_fixtures.ts");
    const req = REQUESTS["R01"];

    const verifiedMemo =
      `The request is approved because it falls within "${REAL_QUOTE_53}".`;

    const fakeSql = {
      unsafe: (text: string, _params: unknown[]) => {
        // Return minimal results to satisfy the engine without real data
        if (text.includes("eligible_patients")) {
          return Promise.resolve([{ n: 100 }]);
        }
        // For any plan query: return empty rows
        return Promise.resolve([]);
      },
      begin: <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeSql),
    };

    const result = await withFakeFetch(
      (url) => {
        return fakeGeneration(verifiedMemo);
      },
      () => answerRequest(req, fakeSql as Parameters<typeof answerRequest>[1]),
    );

    // Decision and articles must be unchanged regardless of memo
    assert(result.decision === "APPROVE_STATISTICAL", `decision must be APPROVE_STATISTICAL, got ${result.decision}`);
    assert(result.articles.includes("53"), "articles must include 53");
    assert(result.articles.includes("69"), "articles must include 69");

    // The memo must be present and verified (or absent because memo is drafted post-execution)
    // The pipeline adds memo after execution — it must not alter decision/articles
    const r = result as unknown as Record<string, unknown>;
    if (r["memo"] !== undefined) {
      const memo = r["memo"] as Record<string, unknown>;
      assert(memo["memo_status"] !== "rejected_unverified_quote" || memo["text"] === undefined,
        "a rejected memo must not have text");
    }
  } finally {
    if (originalKey !== undefined) Deno.env.set("OPENROUTER_API_KEY", originalKey);
    else Deno.env.delete("OPENROUTER_API_KEY");
    _resetMemoCache();
  }
});

// ---------------------------------------------------------------------------
// 5. payload sent to the LLM contains no answer/patient data
// ---------------------------------------------------------------------------

Deno.test("memo: payload to the LLM contains no answer/patient data", async () => {
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");

  Deno.env.set("OPENROUTER_API_KEY", "test-key");
  _resetMemoCache();

  const capturedBodies: string[] = [];

  try {
    const verifiedMemo =
      `Rejected because "${REAL_QUOTE_54}".`;

    await withFakeFetch(
      (url, init) => {
        {
          capturedBodies.push(String(init.body ?? ""));
        }
        return fakeGeneration(verifiedMemo);
      },
      () =>
        draftMemo(
          "Marketing campaign targeting patients with chronic conditions",
          "Which patients can we target with our new drug advertisement?",
          "REJECT",
          ["54"],
          { "54": "Art. 54(1)(c)" },
        ),
    );

    assert(capturedBodies.length > 0, "must have at least one generation call");
    for (const body of capturedBodies) {
      const parsed = JSON.parse(body);
      const promptText = typeof parsed.messages?.[0]?.content === "string" ? parsed.messages[0].content : "";

      // Must NOT contain patient data, answers, or applicant names
      assert(!promptText.includes("patient_id"), "patient_id must not appear in prompt");
      assert(!promptText.includes("birth_date"), "birth_date must not appear in prompt");
      assert(!promptText.includes("PAT-"), "patient identifiers must not appear in prompt");
      assert(!promptText.includes("answer"), "answer field must not appear in prompt as key");

      // Must contain purpose and decision (safe to send)
      assert(
        promptText.includes("Marketing campaign"),
        "purpose must be in prompt",
      );
      assert(
        promptText.includes("REJECT"),
        "decision must be in prompt",
      );
      // Must contain regulation text (from stored JSON only)
      assert(
        promptText.includes("advertising or marketing"),
        "regulation text must be in prompt",
      );
    }
  } finally {
    if (originalKey !== undefined) Deno.env.set("OPENROUTER_API_KEY", originalKey);
    else Deno.env.delete("OPENROUTER_API_KEY");
    _resetMemoCache();
  }
});

// ---------------------------------------------------------------------------
// 6. cache: second call for same key makes no additional fetch call
// ---------------------------------------------------------------------------

Deno.test("memo: cache hit makes no additional fetch call", async () => {
  const originalKey = Deno.env.get("OPENROUTER_API_KEY");

  Deno.env.set("OPENROUTER_API_KEY", "test-key");
  _resetMemoCache();

  try {
    const verifiedMemo =
      `Approved because "${REAL_QUOTE_53}".`;

    let fetchCallCount = 0;
    const makeFakeResponse = (url: string) => {
      fetchCallCount++;
      return fakeGeneration(verifiedMemo);
    };

    const args = [
      "Research on epidemiology",
      "What is the prevalence of hypertension?",
      "APPROVE_STATISTICAL",
      ["53"],
      { "53": "Art. 53(1)" },
    ] as Parameters<typeof draftMemo>;

    const result1 = await withFakeFetch(makeFakeResponse, () => draftMemo(...args));
    assert(result1?.memo_status === "ok", "first call must succeed");
    const callsAfterFirst = fetchCallCount;
    assert(callsAfterFirst > 0, "first call must use fetch");

    // Second call with identical arguments — must hit cache
    const result2 = await withFakeFetch(makeFakeResponse, () => draftMemo(...args));
    assert(result2?.memo_status === "ok", "second call must also succeed");
    assert(
      fetchCallCount === callsAfterFirst,
      `cache hit must not call fetch (before: ${callsAfterFirst}, after: ${fetchCallCount})`,
    );
  } finally {
    if (originalKey !== undefined) Deno.env.set("OPENROUTER_API_KEY", originalKey);
    else Deno.env.delete("OPENROUTER_API_KEY");
    _resetMemoCache();
  }
});
