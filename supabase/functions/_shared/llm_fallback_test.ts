/**
 * Tests for llm_fallback.ts — Issue #15 (EHDS Track 3)
 *
 * All tests run without real watsonx credentials.  Network calls are replaced
 * by a controlled fake fetch (using Deno stub patterns).
 *
 * Covered:
 *   1.  disabled without env vars — attemptFallback returns null, no fetch call
 *   2.  R01–R10 all parse cleanly — fallback is never triggered
 *   3.  a failing definition gets rewritten and re-parsed into a valid plan
 *   4.  an invalid LLM rewrite (still unparseable) is ignored, null returned
 *   5.  cache hit makes no second fetch call
 *   6.  AI-assisted results are always held (pipeline test)
 *   7.  payload sent to watsonx contains only definitions + question, not patient data
 */

import {
  _resetMemCache,
  attemptFallback,
  isEnabled,
} from "./llm_fallback.ts";
import { parseRequest } from "./parser.ts";
import { REQUEST_FIXTURES } from "./parser_fixtures.ts";

function assert(ok: boolean, message = "Assertion failed"): asserts ok {
  if (!ok) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Helper: stub globalThis.fetch with a controllable function
// ---------------------------------------------------------------------------

type FetchStub = {
  calls: { url: string; body: string }[];
  restore(): void;
};

/** Replace globalThis.fetch for the duration of fn(), then restore. */
async function withFakeFetch<T>(
  responseFn: (url: string, init: RequestInit) => Response,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: { url: string; body: string }[] = [];
  (globalThis as unknown as Record<string, unknown>)["fetch"] = (
    url: string,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return Promise.resolve(responseFn(url, init ?? {}));
  };
  try {
    return await fn();
  } finally {
    (globalThis as unknown as Record<string, unknown>)["fetch"] = original;
  }
}

/** Fake IAM token response. */
function fakeIam(): Response {
  return new Response(
    JSON.stringify({ access_token: "test-token", expires_in: 3600 }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** Fake watsonx text/generation response returning a JSON array of strings. */
function fakeGeneration(rewrites: string[]): Response {
  return new Response(
    JSON.stringify({
      results: [{ generated_text: JSON.stringify(rewrites) }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// 1. disabled without env vars — no fetch call, returns null
// ---------------------------------------------------------------------------

Deno.test("disabled without env vars: isEnabled() is false, attemptFallback returns null without fetch", async () => {
  // Ensure env vars are NOT set (they shouldn't be in CI without credentials).
  const hasKey = !!Deno.env.get("WATSONX_API_KEY");
  const hasProjId = !!Deno.env.get("WATSONX_PROJECT_ID");
  const hasUrl = !!Deno.env.get("WATSONX_URL");

  if (hasKey && hasProjId && hasUrl) {
    // Cannot test disabled path when credentials ARE set; skip.
    console.log("  [skip] watsonx credentials present — disabled test skipped");
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
    const request = {
      id: "T-LLM-1",
      question: "How many patients?",
      definitions: ["Flurb = patients who zorbled in the frobnitz"],
    };
    const errors = [
      {
        definition: "Flurb = patients who zorbled in the frobnitz",
        reason: "Unsupported definition",
      },
    ];
    const result = await attemptFallback(request, errors, undefined);
    assert(result === null, "attemptFallback must return null when disabled");
    assert(!fetchCalled, "fetch must never be called when disabled");
  } finally {
    (globalThis as unknown as Record<string, unknown>)["fetch"] = original;
  }
});

// ---------------------------------------------------------------------------
// 2. R01–R10 parse cleanly without LLM (fallback is never needed)
// ---------------------------------------------------------------------------

Deno.test("R01-R10 never call the LLM: all fixtures parse cleanly", async () => {
  const fetchCalls: string[] = [];
  const original = globalThis.fetch;
  (globalThis as unknown as Record<string, unknown>)["fetch"] = (url: string) => {
    fetchCalls.push(String(url));
    return Promise.resolve(new Response("", { status: 200 }));
  };
  try {
    for (const fixture of REQUEST_FIXTURES) {
      const parsed = parseRequest(fixture);
      assert(
        parsed.ok,
        `R${fixture.id} must parse cleanly without LLM: ${
          parsed.ok ? "" : JSON.stringify((parsed as { errors: unknown[] }).errors)
        }`,
      );
    }
    assert(fetchCalls.length === 0, "fetch must not be called for R01-R10");
  } finally {
    (globalThis as unknown as Record<string, unknown>)["fetch"] = original;
  }
});

// ---------------------------------------------------------------------------
// 3. Failing definition gets rewritten into a valid plan
// ---------------------------------------------------------------------------

Deno.test("failing definition gets rewritten and validated", async () => {
  // Only run this test when credentials are present OR by force-setting env vars.
  // We mock fetch to simulate watsonx, but attemptFallback gates on isEnabled().
  // So we temporarily set env vars for this test.
  const originalKey = Deno.env.get("WATSONX_API_KEY");
  const originalProjId = Deno.env.get("WATSONX_PROJECT_ID");
  const originalUrl = Deno.env.get("WATSONX_URL");

  Deno.env.set("WATSONX_API_KEY", "test-key");
  Deno.env.set("WATSONX_PROJECT_ID", "test-project");
  Deno.env.set("WATSONX_URL", "https://eu-de.ml.cloud.ibm.com");
  _resetMemCache();

  try {
    const failingDef =
      "Seniors = patients who are 65 years old or more as of December 31 2025";
    const rewrittenDef = "Seniors = aged 65 or older on 31 December 2025";

    const request = {
      id: "T-LLM-3",
      question: "How many seniors?",
      definitions: [
        failingDef,
        "Report per region: seniors.",
      ],
    };

    const errors = [{ definition: failingDef, reason: "Unsupported definition" }];

    let fetchCallCount = 0;
    const capturedPayloads: string[] = [];

    const result = await withFakeFetch(
      (url, init) => {
        fetchCallCount++;
        capturedPayloads.push(String(init.body ?? ""));
        if (url.includes("iam.cloud.ibm.com")) return fakeIam();
        // watsonx: rewrite to canonical form
        return fakeGeneration([rewrittenDef]);
      },
      () => attemptFallback(request, errors, undefined),
    );

    assert(result !== null, "attemptFallback must return a result");
    assert(result!.parsed.ok, "Rewritten plan must pass the validator");
    assert(result!.ai_assist.used === true, "ai_assist.used must be true");
    assert(
      typeof result!.ai_assist.model === "string" &&
        result!.ai_assist.model.length > 0,
      "ai_assist.model must be set",
    );
    assert(
      result!.ai_assist.rewritten.length === 1,
      "rewritten must have one item",
    );
    assert(
      result!.ai_assist.rewritten[0].original === failingDef,
      "original must match the failing definition",
    );
    assert(
      result!.ai_assist.rewritten[0].rewritten === rewrittenDef,
      "rewritten must match the LLM output",
    );
    assert(fetchCallCount === 2, "must call IAM + watsonx exactly once each");

    // Verify payload contains only definitions + question, not patient data
    const genPayload = capturedPayloads.find((p) => p.includes("model_id"));
    assert(genPayload !== undefined, "must have a generation payload");
    const genParsed = JSON.parse(genPayload);
    const promptText = typeof genParsed.input === "string" ? genParsed.input : "";
    assert(!promptText.includes("applicant"), "no 'applicant' key in prompt");
    assert(!promptText.includes("patient_id"), "no patient_id in prompt");
    assert(
      promptText.includes(failingDef),
      "payload must contain the failing definition",
    );
    assert(
      promptText.includes(request.question),
      "payload must contain the question",
    );
  } finally {
    // Restore env (set back to original or delete)
    if (originalKey !== undefined) Deno.env.set("WATSONX_API_KEY", originalKey);
    else Deno.env.delete("WATSONX_API_KEY");
    if (originalProjId !== undefined) {
      Deno.env.set("WATSONX_PROJECT_ID", originalProjId);
    } else Deno.env.delete("WATSONX_PROJECT_ID");
    if (originalUrl !== undefined) Deno.env.set("WATSONX_URL", originalUrl);
    else Deno.env.delete("WATSONX_URL");
    _resetMemCache();
  }
});

// ---------------------------------------------------------------------------
// 4. Invalid LLM rewrite (still unparseable) is ignored, null returned
// ---------------------------------------------------------------------------

Deno.test("invalid LLM rewrite (still unparseable) is ignored, null returned", async () => {
  const originalKey = Deno.env.get("WATSONX_API_KEY");
  const originalProjId = Deno.env.get("WATSONX_PROJECT_ID");
  const originalUrl = Deno.env.get("WATSONX_URL");

  Deno.env.set("WATSONX_API_KEY", "test-key");
  Deno.env.set("WATSONX_PROJECT_ID", "test-project");
  Deno.env.set("WATSONX_URL", "https://eu-de.ml.cloud.ibm.com");
  _resetMemCache();

  try {
    const failingDef = "Wobble = still completely wrong after LLM";
    // LLM returns something that is STILL not parseable
    const badRewrite = "Wobble = this is still not supported by the grammar";

    const request = {
      id: "T-LLM-4",
      question: "Count something?",
      definitions: [
        failingDef,
        "Report per region: adults.",
      ],
    };
    const errors = [{ definition: failingDef, reason: "Unsupported definition" }];

    const result = await withFakeFetch(
      (url) => {
        if (url.includes("iam.cloud.ibm.com")) return fakeIam();
        return fakeGeneration([badRewrite]);
      },
      () => attemptFallback(request, errors, undefined),
    );

    assert(
      result === null,
      "must return null when LLM rewrite still fails to parse",
    );
  } finally {
    if (originalKey !== undefined) Deno.env.set("WATSONX_API_KEY", originalKey);
    else Deno.env.delete("WATSONX_API_KEY");
    if (originalProjId !== undefined) {
      Deno.env.set("WATSONX_PROJECT_ID", originalProjId);
    } else Deno.env.delete("WATSONX_PROJECT_ID");
    if (originalUrl !== undefined) Deno.env.set("WATSONX_URL", originalUrl);
    else Deno.env.delete("WATSONX_URL");
    _resetMemCache();
  }
});

// ---------------------------------------------------------------------------
// 5. Cache hit makes no second fetch call
// ---------------------------------------------------------------------------

Deno.test("cache hit makes no second fetch call", async () => {
  const originalKey = Deno.env.get("WATSONX_API_KEY");
  const originalProjId = Deno.env.get("WATSONX_PROJECT_ID");
  const originalUrl = Deno.env.get("WATSONX_URL");

  Deno.env.set("WATSONX_API_KEY", "test-key");
  Deno.env.set("WATSONX_PROJECT_ID", "test-project");
  Deno.env.set("WATSONX_URL", "https://eu-de.ml.cloud.ibm.com");
  _resetMemCache();

  try {
    const failingDef = "Elder = aged 70 years or more on December 31 2025";
    const rewrittenDef = "Elder = aged 70 or older on 31 December 2025";

    const request = {
      id: "T-LLM-5",
      question: "Cache test question",
      definitions: [
        failingDef,
        "Report per region: elder.",
      ],
    };
    const errors = [{ definition: failingDef, reason: "Unsupported" }];

    let fetchCallCount = 0;

    const makeResponse = (url: string) => {
      fetchCallCount++;
      if (url.includes("iam.cloud.ibm.com")) return fakeIam();
      return fakeGeneration([rewrittenDef]);
    };

    // First call — should hit watsonx
    const result1 = await withFakeFetch(makeResponse, () =>
      attemptFallback(request, errors, undefined));
    assert(result1 !== null && result1.parsed.ok, "first call must succeed");
    const firstFetchCount = fetchCallCount;
    assert(firstFetchCount > 0, "first call must use fetch");

    // Second call — should use in-memory cache, no fetch
    const result2 = await withFakeFetch(makeResponse, () =>
      attemptFallback(request, errors, undefined));
    assert(result2 !== null && result2.parsed.ok, "second call must also succeed");
    assert(
      fetchCallCount === firstFetchCount,
      `cache hit must not call fetch again (calls before: ${firstFetchCount}, after: ${fetchCallCount})`,
    );
    assert(
      result2!.ai_assist.used === true,
      "ai_assist.used must still be true on cache hit",
    );
  } finally {
    if (originalKey !== undefined) Deno.env.set("WATSONX_API_KEY", originalKey);
    else Deno.env.delete("WATSONX_API_KEY");
    if (originalProjId !== undefined) {
      Deno.env.set("WATSONX_PROJECT_ID", originalProjId);
    } else Deno.env.delete("WATSONX_PROJECT_ID");
    if (originalUrl !== undefined) Deno.env.set("WATSONX_URL", originalUrl);
    else Deno.env.delete("WATSONX_URL");
    _resetMemCache();
  }
});

// ---------------------------------------------------------------------------
// 6. AI-assisted results are always held for staff review
// ---------------------------------------------------------------------------

Deno.test("AI-assisted results are always held: needs_review true, answer null", async () => {
  // Import pipeline here to keep test self-contained.
  const { answerRequest } = await import("./pipeline.ts");

  const originalKey = Deno.env.get("WATSONX_API_KEY");
  const originalProjId = Deno.env.get("WATSONX_PROJECT_ID");
  const originalUrl = Deno.env.get("WATSONX_URL");

  Deno.env.set("WATSONX_API_KEY", "test-key");
  Deno.env.set("WATSONX_PROJECT_ID", "test-project");
  Deno.env.set("WATSONX_URL", "https://eu-de.ml.cloud.ibm.com");
  _resetMemCache();

  const failingDef = "Senior = patients who are 65 years old or more as of December 31 2025";
  const rewrittenDef = "Senior = aged 65 or older on 31 December 2025";

  const request = {
    id: "T-LLM-6",
    requested_as: "health data request",
    purpose: "Public health research on diabetes prevalence.",
    question: "How many seniors are there per region?",
    definitions: [
      failingDef,
      "Report per region: patients with senior.",
    ],
  };

  // Track SQL queries by text to distinguish cache lookup from patient data queries.
  const patientDataPatterns = [
    "eligible_patients",
    "runPlan",
    "spe_",
    "FROM public.patients",
    "FROM public.conditions",
    "FROM public.medications",
    "FROM public.observations",
    "FROM public.encounters",
  ];
  const patientSqlCalls: string[] = [];
  const fakeSql = {
    unsafe: (text: string, _params: unknown[]) => {
      if (patientDataPatterns.some((p) => text.includes(p))) {
        patientSqlCalls.push(text);
      }
      return Promise.resolve([]);
    },
    begin: <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeSql),
  };

  try {
    const result = await withFakeFetch(
      (url) => {
        if (url.includes("iam.cloud.ibm.com")) return fakeIam();
        return fakeGeneration([rewrittenDef]);
      },
      () =>
        answerRequest(request, fakeSql as Parameters<typeof answerRequest>[1]),
    );

    assert(
      result.needs_review === true,
      "AI-assisted result must always set needs_review=true",
    );
    assert(
      result.status === "staff_review",
      `AI-assisted result must have status=staff_review, got ${result.status}`,
    );
    assert(
      result.answer === null,
      "AI-assisted result must have answer=null (no patient data queried)",
    );
    assert(
      patientSqlCalls.length === 0,
      `no patient-data SQL must run for a held AI-assisted result; got: ${patientSqlCalls.join("; ")}`,
    );
    const r = result as unknown as Record<string, unknown>;
    assert(
      r["ai_assist"] !== undefined,
      "ai_assist must be present in the pipeline response",
    );
    const assist = r["ai_assist"] as Record<string, unknown>;
    assert(assist["used"] === true, "ai_assist.used must be true");
    assert(
      Array.isArray(assist["rewritten"]) &&
        (assist["rewritten"] as unknown[]).length > 0,
      "ai_assist.rewritten must be non-empty",
    );
  } finally {
    if (originalKey !== undefined) Deno.env.set("WATSONX_API_KEY", originalKey);
    else Deno.env.delete("WATSONX_API_KEY");
    if (originalProjId !== undefined) {
      Deno.env.set("WATSONX_PROJECT_ID", originalProjId);
    } else Deno.env.delete("WATSONX_PROJECT_ID");
    if (originalUrl !== undefined) Deno.env.set("WATSONX_URL", originalUrl);
    else Deno.env.delete("WATSONX_URL");
    _resetMemCache();
  }
});

// ---------------------------------------------------------------------------
// 7. Payload contains only definitions + question (no patient data)
// ---------------------------------------------------------------------------

Deno.test("payload contains only definitions + question, no patient data", async () => {
  const originalKey = Deno.env.get("WATSONX_API_KEY");
  const originalProjId = Deno.env.get("WATSONX_PROJECT_ID");
  const originalUrl = Deno.env.get("WATSONX_URL");

  Deno.env.set("WATSONX_API_KEY", "test-key");
  Deno.env.set("WATSONX_PROJECT_ID", "test-project");
  Deno.env.set("WATSONX_URL", "https://eu-de.ml.cloud.ibm.com");
  _resetMemCache();

  try {
    const failingDef = "Senior = patient 65 years old or above at year-end 2025";
    const rewrittenDef = "Senior = aged 65 or older on 31 December 2025";

    const requestWithSensitiveData = {
      id: "T-LLM-7",
      question: "Count seniors?",
      definitions: [failingDef, "Report per region: senior."],
      // Fields that must NEVER reach watsonx
      applicant: {
        name: "Dr. Secret Name",
        organisation: "Sensitive Org",
        country: "AT",
      },
      patient_ids: ["PAT-0001", "PAT-0002"],
      birth_dates: ["1950-01-01"],
    };

    const capturedBodies: string[] = [];
    const errors = [{ definition: failingDef, reason: "Unsupported" }];

    await withFakeFetch(
      (url, init) => {
        if (!url.includes("iam.cloud.ibm.com")) {
          capturedBodies.push(String(init.body ?? ""));
        }
        if (url.includes("iam.cloud.ibm.com")) return fakeIam();
        return fakeGeneration([rewrittenDef]);
      },
      () => attemptFallback(requestWithSensitiveData, errors, undefined),
    );

    assert(capturedBodies.length > 0, "must have at least one generation call");
    for (const body of capturedBodies) {
      const parsed = JSON.parse(body);
      const promptText = typeof parsed.input === "string" ? parsed.input : "";

      // Sensitive fields must not appear in the prompt
      assert(
        !promptText.includes("Dr. Secret Name"),
        "applicant name must not be in payload",
      );
      assert(
        !promptText.includes("Sensitive Org"),
        "applicant organisation must not be in payload",
      );
      assert(
        !promptText.includes("PAT-0001"),
        "patient IDs must not be in payload",
      );
      assert(
        !promptText.includes("1950-01-01"),
        "birth dates must not be in payload",
      );

      // Required fields must be present
      assert(
        promptText.includes(failingDef),
        "failing definition must be in payload",
      );
      assert(
        promptText.includes(requestWithSensitiveData.question),
        "question must be in payload",
      );
    }
  } finally {
    if (originalKey !== undefined) Deno.env.set("WATSONX_API_KEY", originalKey);
    else Deno.env.delete("WATSONX_API_KEY");
    if (originalProjId !== undefined) {
      Deno.env.set("WATSONX_PROJECT_ID", originalProjId);
    } else Deno.env.delete("WATSONX_PROJECT_ID");
    if (originalUrl !== undefined) Deno.env.set("WATSONX_URL", originalUrl);
    else Deno.env.delete("WATSONX_URL");
    _resetMemCache();
  }
});
