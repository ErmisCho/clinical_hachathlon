/** Run immediately after deployment to record a candidate cold start.
 * deno run --allow-read --allow-net scripts/smoke-live.ts <base-url> [--key <key>] [--track-dir <track-root>]
 * Base URL may be a Supabase project URL, /functions/v1, or /functions/v1/requests.
 * The script cannot force/confirm a cold isolate; retain its timestamped output.
 */
import { type Expected, type Json, scoreResponse } from "./eval_lib.ts";
import { MAX_BODY_BYTES } from "../supabase/functions/_shared/request_validation.ts";

type RequestBody = Record<string, unknown>;
export async function smokeLive(
  endpoint: string,
  requests: RequestBody[],
  expected: Record<string, Expected>,
  key?: string,
  send: typeof fetch = fetch,
  log: (message: string) => void = console.log,
): Promise<number> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (key) {
    headers.Authorization = `Bearer ${key}`;
    headers.apikey = key;
  }
  let failures = 0;
  let decisions = 0, numbers = 0, leaks = 0;
  async function post(body: string) {
    const started = performance.now();
    const response = await send(endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(60_000),
    });
    const value = await response.json();
    const elapsed = performance.now() - started;
    if (elapsed >= 60_000) throw new Error("exceeded 60 s target");
    return { response, value, elapsed };
  }
  async function check(request: RequestBody, cold = false) {
    const id = String(request.id);
    const started = performance.now();
    try {
      const { response, value, elapsed } = await post(JSON.stringify(request));
      if (cold) {
        log(
          `${
            new Date().toISOString()
          } first call after deploy (candidate cold start): ${id} ${
            elapsed.toFixed(0)
          } ms (target <60000 ms)`,
        );
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (value?.request_id !== id) {
        throw new Error("response request_id mismatch");
      }
      const reference = expected[id];
      if (!reference) throw new Error("missing expected.json reference");
      const score = scoreResponse(value as Json, reference);
      if (!cold) {
        decisions += Number(score.decision && score.articles);
        if (reference.answer !== null) numbers += Number(score.numbers);
        leaks += score.leaks.length;
      }
      if (
        !score.decision || !score.articles || !score.numbers ||
        score.leaks.length
      ) {
        throw new Error(`reference check failed: ${JSON.stringify(score)}`);
      }
      log(
        `PASS ${cold ? "first call" : "submission"} ${id} (${
          elapsed.toFixed(0)
        } ms)`,
      );
    } catch (error) {
      failures++;
      log(
        `FAIL ${id}${
          cold
            ? ` first-call elapsed ${
              (performance.now() - started).toFixed(0)
            } ms`
            : ""
        }: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // R05 exercises the SPE path on the first call, before warming any function.
  const first = requests.find((request) => request.id === "R05");
  if (
    !first || requests.length !== 10 ||
    new Set(requests.map((r) => r.id)).size !== 10
  ) {
    throw new Error("requires ten distinct R01�R10 fixtures including R05");
  }
  await check(first, true);
  log("Submitting R01�R05 in parallel");
  await Promise.all(requests.slice(0, 5).map((request) => check(request)));
  for (const request of requests.slice(5)) await check(request);

  const valid = requests[0];
  const malformed: [string, string, number][] = [
    ["invalid JSON", "{", 400],
    ["non-object JSON", "null", 400],
    ["missing fields", "{}", 400],
    [
      "invalid fields",
      JSON.stringify({
        ...valid,
        id: "bad-id",
        purpose: 42,
        question: null,
        definitions: [42],
      }),
      400,
    ],
    [
      "unknown requested_as",
      JSON.stringify({ ...valid, requested_as: "unknown" }),
      400,
    ],
    [
      "oversized body",
      JSON.stringify({ ...valid, question: "x".repeat(MAX_BODY_BYTES) }),
      413,
    ],
    [
      "too many definitions",
      JSON.stringify({ ...valid, definitions: Array(51).fill("definition") }),
      400,
    ],
    [
      "long string",
      JSON.stringify({ ...valid, question: "x".repeat(8001) }),
      400,
    ],
    ...["id", "purpose", "question", "requested_as", "definitions"].map(
      (field): [string, string, number] => {
        const body = { ...valid };
        delete body[field];
        return [`missing ${field}`, JSON.stringify(body), 400];
      },
    ),
  ];
  for (const [label, body, status] of malformed) {
    try {
      const { response, value } = await post(body);
      if (
        response.status !== status || typeof value?.error !== "string" ||
        !value.error || value.stack !== undefined
      ) {
        throw new Error(
          `expected JSON ${status} error, got HTTP ${response.status}`,
        );
      }
      log(`PASS ${label}: ${status}`);
    } catch (error) {
      failures++;
      log(
        `FAIL ${label}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const expectedNumbers =
    Object.values(expected).filter((e) => e.answer !== null).length;
  log(
    `Eval: ${decisions}/10 decisions+articles, ${numbers}/${expectedNumbers} answers, ${leaks} leaks; ${failures} failures`,
  );
  return failures ? 1 : 0;
}

export async function main(args: string[]): Promise<number> {
  const [base, ...rest] = args;
  if (!base) {
    throw new Error(
      "Usage: smoke-live.ts <base-url> [--key <key>] [--track-dir <track-root>]",
    );
  }
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (
      !["--key", "--track-dir"].includes(rest[i]) || !rest[i + 1] ||
      options[rest[i]]
    ) throw new Error("invalid arguments");
    options[rest[i]] = rest[i + 1];
  }
  const url = new URL(base);
  if (!["https:", "http:"].includes(url.protocol) || url.search || url.hash) {
    throw new Error("invalid base URL");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/requests")
    ? path
    : `${path || "/functions/v1"}/requests`;
  const file = (name: string) =>
    options["--track-dir"]
      ? `${options["--track-dir"].replace(/[\\/]+$/, "")}/requests/${name}`
      : new URL(`../../TRACK-3-ehds/requests/${name}`, import.meta.url);
  const expected = JSON.parse(await Deno.readTextFile(file("expected.json")));
  const requests = await Promise.all(
    Array.from({ length: 10 }, async (_, i) =>
      JSON.parse(
        await Deno.readTextFile(
          file(`R${String(i + 1).padStart(2, "0")}.json`),
        ),
      )),
  );
  return smokeLive(url.href, requests, expected, options["--key"]);
}

if (import.meta.main) {
  try {
    Deno.exitCode = await main(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exitCode = 1;
  }
}
