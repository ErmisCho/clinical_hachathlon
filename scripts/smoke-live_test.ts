import { smokeLive } from "./smoke-live.ts";
import type { Expected } from "./eval_lib.ts";
import { REQUEST_FIXTURES } from "../supabase/functions/_shared/parser_fixtures.ts";
import { createHandler } from "../supabase/functions/requests/handler.ts";

function assert(value: unknown, message: string) {
  if (!value) throw new Error(message);
}
const expected: Record<string, Expected> = Object.fromEntries(
  REQUEST_FIXTURES.map((
    r,
  ) => [r.id, { decision: "REJECT", articles: ["54"], answer: null }]),
);
function fakeBackend(fault?: "decision" | "id" | "network" | "validation") {
  let active = 0, peak = 0, calls = 0;
  const invalidHandler = createHandler(() => {
    throw new Error("invalid input reached DB");
  });
  const send: typeof fetch = async (input, init) => {
    calls++;
    if (fault === "network") throw new TypeError("backend unreachable");
    const body = String(init?.body);
    let value;
    try {
      value = JSON.parse(body);
    } catch { /* HTTP handler checks malformed JSON */ }
    const original = REQUEST_FIXTURES.find((r) => JSON.stringify(r) === body);
    if (!original) {
      if (fault === "validation") {
        return Response.json({ error: "wrong status" });
      }
      return invalidHandler(new Request(input, init));
    }
    assert(init?.signal instanceof AbortSignal, "request must have a deadline");
    const headers = new Headers(init?.headers);
    assert(headers.get("apikey") === "test-key", "key header missing");
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    return Response.json({
      request_id: fault === "id" ? "wrong" : value.id,
      decision: fault === "decision" ? "APPROVE_SPE" : "REJECT",
      articles: ["54"],
      answer: null,
    });
  };
  return {
    send,
    get peak() {
      return peak;
    },
    get calls() {
      return calls;
    },
  };
}
Deno.test("smoke-live: first call, five parallel, full scoring and bad input checks offline", async () => {
  const fake = fakeBackend();
  const logs: string[] = [];
  const code = await smokeLive(
    "https://example.test/functions/v1/requests",
    REQUEST_FIXTURES,
    expected,
    "test-key",
    fake.send,
    (s) => logs.push(s),
  );
  assert(code === 0, logs.join("\n"));
  assert(fake.peak === 5, "must overlap five different submissions");
  assert(
    logs.some((s) => s.includes("candidate cold start") && s.includes("R05")),
    "cold-call measurement missing",
  );
  assert(
    logs.some((s) => s.includes("10/10") && s.includes("0 leaks")),
    "eval summary missing",
  );
  assert(fake.calls === 24, `unexpected number of HTTP calls: ${fake.calls}`);
});
Deno.test("smoke-live: wrong decisions, mixed IDs, network errors and wrong 4xx fail", async () => {
  for (const fault of ["decision", "id", "network", "validation"] as const) {
    const fake = fakeBackend(fault);
    const code = await smokeLive(
      "https://example.test/functions/v1/requests",
      REQUEST_FIXTURES,
      expected,
      "test-key",
      fake.send,
      () => {},
    );
    assert(code === 1, `must fail on ${fault}`);
  }
});
