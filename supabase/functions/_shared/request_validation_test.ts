import { createHandler, type RequestDatabase } from "../requests/handler.ts";
import { REQUEST_FIXTURES } from "./parser_fixtures.ts";
import { MAX_BODY_BYTES, validateRequest } from "./request_validation.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
const base = "https://example.test/functions/v1/requests";
const valid = REQUEST_FIXTURES[0];
const handler = createHandler(() => {
  throw new Error("must not connect");
});
function post(body: unknown) {
  return new Request(base, { method: "POST", body: JSON.stringify(body) });
}
Deno.test("validation: all track fixtures pass and all missing fields are listed", async () => {
  for (const request of REQUEST_FIXTURES) equal(validateRequest(request), []);
  const response = await handler(post({}));
  equal(response.status, 400);
  const result = await response.json();
  equal(result.problems.length, 5);
  for (
    const field of ["id", "purpose", "question", "requested_as", "definitions"]
  ) {
    equal(result.problems.some((p: string) => p.startsWith(field)), true);
    const body: Record<string, unknown> = { ...valid };
    delete body[field];
    equal((await handler(post(body))).status, 400);
  }
});
Deno.test("validation: invalid types, IDs, enum, array entries and string limits", async () => {
  const bodies = [
    null,
    [],
    true,
    5,
    "text",
    ...["", " ", "bad-id", "�", "x".repeat(60), 1, null].map((id) => ({
      ...valid,
      id,
    })),
    ...["", " ", 1, null, "x".repeat(8001)].flatMap((text) => [
      { ...valid, purpose: text },
      { ...valid, question: text },
    ]),
    ...["unknown", "HEALTH DATA REQUEST", " health data request", null, {}].map(
      (requested_as) => ({ ...valid, requested_as }),
    ),
    ...[
      null,
      {},
      "text",
      [1],
      [null],
      [" "],
      ["x".repeat(2001)],
      Array(51).fill("x"),
    ].map((definitions) => ({ ...valid, definitions })),
  ];
  for (const body of bodies) {
    const response = await handler(post(body));
    equal(response.status, 400);
    const result = await response.json();
    equal(typeof result.error, "string");
    equal(Array.isArray(result.problems), true);
    equal(result.stack, undefined);
    equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  }
  equal(
    validateRequest({
      ...valid,
      id: "x".repeat(59),
      purpose: "x".repeat(8000),
      question: "x".repeat(8000),
      definitions: Array(50).fill("x".repeat(2000)),
    }),
    [],
  );
  equal(validateRequest({ ...valid, definitions: [] }), []);
});
Deno.test("validation: invalid JSON, UTF-8 and broken streams give sanitized 400", async () => {
  const broken = new ReadableStream({
    start(controller) {
      controller.error(new Error("private stack"));
    },
  });
  for (const body of ["{", "", new Uint8Array([0xff]), broken]) {
    const response = await handler(new Request(base, { method: "POST", body }));
    equal(response.status, 400);
    equal(await response.json(), { error: "invalid JSON body" });
  }
});
Deno.test("validation: body byte cap works without or despite Content-Length", async () => {
  for (
    const headers of [{}, { "Content-Length": "1" }, {
      "Content-Length": String(MAX_BODY_BYTES + 1),
    }]
  ) {
    const response = await handler(
      new Request(base, {
        method: "POST",
        headers: headers as Record<string, string>,
        body: JSON.stringify({
          ...valid,
          question: "�".repeat(MAX_BODY_BYTES / 2),
        }),
      }),
    );
    equal(response.status, 413);
    equal(await response.json(), { error: "body exceeds 64 KB limit" });
  }
  // An exactly-at-limit valid object reaches field validation, not 413.
  equal(
    (await handler(
      new Request(base, {
        method: "POST",
        body: "{}" + " ".repeat(MAX_BODY_BYTES - 2),
      }),
    )).status,
    400,
  );
  let cancelled = false;
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(32768));
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  equal(
    (await handler(new Request(base, { method: "POST", body: stream }))).status,
    413,
  );
  equal(cancelled, true);
  equal(pulls, 3);
});

Deno.test("requests: five parallel track submissions keep decisions and saved results isolated", async () => {
  const saved: unknown[][] = [];
  let connections = 0, closed = 0;
  const parallelHandler = createHandler(() => {
    connections++;
    const sql: RequestDatabase = Object.assign(
      async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        await Promise.resolve();
        saved.push(values);
        return [];
      },
      {
        json(value: unknown) {
          return value;
        },
        async unsafe(query: string) {
          await Promise.resolve();
          return query.includes("SELECT COUNT") ? [{ n: "42" }] : [];
        },
        begin<T>(fn: (tx: RequestDatabase) => Promise<T>) {
          return fn(sql);
        },
        end() {
          closed++;
          return Promise.resolve();
        },
      },
    );
    return sql;
  });
  const requests = REQUEST_FIXTURES.slice(0, 5);
  const decisions = [
    "APPROVE_STATISTICAL",
    "REJECT",
    "APPROVE_STATISTICAL",
    "REJECT",
    "APPROVE_SPE",
  ];
  const responses = await Promise.all(
    requests.map((r) => parallelHandler(post(r))),
  );
  for (let i = 0; i < responses.length; i++) {
    equal(responses[i].status, 200);
    const result = await responses[i].json();
    equal(result.request_id, requests[i].id);
    equal(result.decision, decisions[i]);
    equal(saved.find((row) => row[0] === requests[i].id), [
      requests[i].id,
      requests[i],
      result,
    ]);
    if (i === 4) {
      equal(result.spe_schema, "spe_r05");
      equal(result.answer, { cohort_size: 42 });
    }
  }
  equal(connections, 5);
  equal(closed, 5);
});
