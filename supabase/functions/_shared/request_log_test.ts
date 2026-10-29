import { loadRequest, saveRequest } from "./request_log.ts";
import type { PipelineResponse } from "./pipeline.ts";
import { REQUEST_FIXTURES } from "./parser_fixtures.ts";
import { createHandler, type RequestDatabase } from "../requests/handler.ts";

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

class JsonParameter {
  constructor(readonly value: unknown) {}
}

function fakeSql(results: Record<string, unknown>[][] = []) {
  const calls: { text: string; params: unknown[] }[] = [];
  let closed = 0;
  const actions: Record<string, unknown>[] = [];
  const stored: { request_id: unknown; request: unknown; response: unknown }[] =
    [];
  const sql: RequestDatabase = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) =>
      sql.unsafe(
        strings.join("?"),
        values.map((value) =>
          value instanceof JsonParameter ? value.value : value
        ) as (string | number | boolean)[],
      ),
    {
      json(value: unknown) {
        return new JsonParameter(value);
      },
      unsafe(text: string, params: (string | number | boolean)[] = []) {
        calls.push({ text, params });
        if (text.includes("INSERT INTO public.request_log")) {
          // postgres.js JSONB serialization happens for both objects and strings.
          // JSON.stringify supplied by the caller would persist a JSON string.
          stored.push({
            request_id: params[0],
            request: JSON.parse(JSON.stringify(params[1])),
            response: JSON.parse(JSON.stringify(params[2])),
          });
        }
        if (results.length) return Promise.resolve(results.shift()!);
        if (
          text.includes("SELECT id, request, response FROM public.request_log")
        ) {
          const index = stored.findLastIndex((row) =>
            row.request_id === params[0]
          );
          return Promise.resolve(
            index < 0 ? [] : [{ id: index + 1, ...stored[index] }],
          );
        }
        if (text.includes("UPDATE public.request_log")) {
          stored[Number(params[1]) - 1].response = params[0];
        }
        if (text.includes("INSERT INTO public.staff_action")) {
          actions.push({
            id: actions.length + 1,
            request_id: params[0],
            request_log_id: params[1],
            action: params[2],
            decision: params[3],
            reason: params[4],
            staff_name: params[5],
            created_at: "2026-10-30T12:00:00Z",
          });
        }
        if (text.includes("SELECT response FROM public.request_log")) {
          const row = stored.findLast((row) => row.request_id === params[0]);
          return Promise.resolve(row ? [{ response: row.response }] : []);
        }
        if (text.includes("AS history")) {
          assert(
            text.includes("jsonb_typeof(response) = 'string'"),
            "normalize legacy rows before projection",
          );
          assert(
            text.includes("(response #>> '{}')::jsonb"),
            "decode legacy JSON string",
          );
          return Promise.resolve(
            stored.toReversed().map((row) => {
              const result = typeof row.response === "string"
                ? JSON.parse(row.response)
                : row.response;
              const response = result as Record<string, unknown>;
              return {
                request_id: row.request_id,
                submitted_at: "2026-10-29T12:00:00Z",
                decision: response.decision,
                articles: response.articles,
                needs_review: response.needs_review,
                spe_schema: response.spe_schema ?? null,
                last_staff_action: actions.findLast((action) =>
                  action.request_log_id === stored.indexOf(row) + 1
                ) ?? null,
              };
            }),
          );
        }
        return Promise.resolve([]);
      },
      async begin<T>(fn: (tx: RequestDatabase) => Promise<T>): Promise<T> {
        const snapshot = structuredClone(stored);
        const actionCount = actions.length;
        try {
          return await fn(sql);
        } catch (error) {
          stored.splice(0, stored.length, ...snapshot);
          actions.splice(actionCount);
          throw error;
        }
      },
      end() {
        closed++;
        return Promise.resolve();
      },
    },
  );
  return {
    stored,
    actions,
    sql,
    calls,
    get closed() {
      return closed;
    },
  };
}
const base = "https://example.test/functions/v1/requests";
const statistical = {
  id: "R01",
  requested_as: "health data request",
  purpose: "Public health research",
  question: "How many adults have diabetes?",
  definitions: [
    "Adult = aged 18 or older on 31 December 2025.",
    "Type 2 diabetes = any condition with an ICD-10 code starting with E11.",
    "Report per region: adults with type 2 diabetes.",
  ],
};
function post(body: unknown, url = base): Request {
  return new Request(url, { method: "POST", body: JSON.stringify(body) });
}

const staffReview = {
  action: "approve",
  request_id: "R01",
  reason: "Staff verified the purpose.",
  staff_name: "Reviewer",
};

async function heldRequest(
  fake: ReturnType<typeof fakeSql>,
  definitions = statistical.definitions,
) {
  const response = await createHandler(() => fake.sql)(post({
    ...statistical,
    purpose: "Explore possible uses.",
    definitions,
  }));
  equal(response.status, 200);
  const held = await response.json();
  equal(held.status, "staff_review");
  equal(held.answer, null);
  equal(fake.calls.length, 1);
  return held;
}

function patientResults(fake: ReturnType<typeof fakeSql>) {
  const original = fake.sql.unsafe.bind(fake.sql);
  fake.sql.unsafe = (text, params = []) => {
    if (
      text.includes("public.eligible_patients") ||
      text.includes("FROM spe_r01.patients")
    ) {
      fake.calls.push({ text, params });
      if (text.startsWith("SELECT DISTINCT")) {
        return Promise.resolve([{ value: "Wien" }, { value: "Tirol" }]);
      }
      if (text.includes("AS g0")) {
        return Promise.resolve([{ g0: "Wien", n: "25" }, {
          g0: "Tirol",
          n: "4",
        }]);
      }
      return Promise.resolve([{ n: "42" }]);
    }
    return original(text, params);
  };
}

Deno.test("review: approval executes the same protected engine and updates the staff queue", async () => {
  const fake = fakeSql();
  await heldRequest(fake);
  const handler = createHandler(() => fake.sql);
  const before = await (await handler(new Request(base))).json();
  equal(before.requests[0].status, "staff_review");
  equal(before.requests[0].last_staff_action, null);
  patientResults(fake);
  const response = await handler(post(staffReview, base + "/review"));
  equal(response.status, 200);
  const result = await response.json();
  equal(result.status, "decided");
  equal(result.needs_review, false);
  equal(result.answer, {
    Wien: { adults_with_type2_diabetes: 25 },
    Tirol: { adults_with_type2_diabetes: "<10" },
  });
  equal(fake.stored.length, 1);
  equal(fake.stored[0].response, result);
  equal(await (await handler(new Request(base + "/R01"))).json(), result);
  equal(fake.actions.length, 1);
  equal(fake.actions[0].reason, staffReview.reason);
  assert(
    fake.calls.some((call) => call.text.includes("LIMIT 1 FOR UPDATE")),
    "lock reviewed submission",
  );
  const after = await (await handler(new Request(base))).json();
  equal(after.requests[0].status, "decided");
  equal(after.requests[0].last_staff_action.staff_name, "Reviewer");
  equal((await handler(post(staffReview, base + "/review"))).status, 409);
  equal(fake.actions.length, 1);
  assert(!("answer" in after.requests[0]), "queue omits statistics");
  assert(
    !JSON.stringify(result).includes("opted_out"),
    "no opt-out disclosure",
  );
});

Deno.test("review: REJECT override never reads patient data or creates an SPE", async () => {
  const fake = fakeSql();
  await heldRequest(fake);
  const response = await createHandler(() => fake.sql)(post({
    ...staffReview,
    action: "override",
    decision: "REJECT",
  }, base + "/review"));
  equal(response.status, 200);
  const result = await response.json();
  equal(result.decision, "REJECT");
  equal(result.status, "decided");
  equal(result.answer, null);
  assert(!("population" in result) && !("spe_schema" in result), "no data");
  assert(
    fake.calls.every((call) =>
      !/eligible_patients|CREATE SCHEMA/.test(call.text)
    ),
    "metadata only",
  );
  equal(fake.actions[0].decision, "REJECT");
});

Deno.test("review: approving overrides use protected statistics and SPE paths", async () => {
  for (const decision of ["APPROVE_STATISTICAL", "APPROVE_SPE"]) {
    const fake = fakeSql();
    await heldRequest(fake);
    patientResults(fake);
    const response = await createHandler(() => fake.sql)(post({
      ...staffReview,
      action: "override",
      decision,
    }, base + "/review"));
    equal(response.status, 200);
    const result = await response.json();
    equal(result.decision, decision);
    equal(result.status, "decided");
    if (decision === "APPROVE_SPE") {
      equal(result.spe_schema, "spe_r01");
      assert(
        fake.calls.some((call) =>
          call.text.includes("ENABLE ROW LEVEL SECURITY")
        ),
        "SPE retains RLS",
      );
      assert(
        fake.calls.some((call) => call.text.includes("REVOKE ALL")),
        "SPE retains access restrictions",
      );
    } else {
      equal(result.answer.Tirol.adults_with_type2_diabetes, "<10");
    }
    assert(
      fake.calls.some((call) => call.text.includes("public.eligible_patients")),
      "opt-outs excluded by existing view",
    );
  }
});

Deno.test("review: parse failure remains held even after an approval or approving override", async () => {
  for (const action of ["approve", "override"]) {
    const fake = fakeSql();
    await heldRequest(fake, []);
    const response = await createHandler(() => fake.sql)(post({
      ...staffReview,
      action,
      ...(action === "override" ? { decision: "APPROVE_SPE" } : {}),
    }, base + "/review"));
    equal(response.status, 200);
    const result = await response.json();
    equal(result.status, "staff_review");
    equal(result.answer, null);
    assert(result.parse_errors.length > 0, "parse error retained");
    assert(
      fake.calls.every((call) =>
        !/eligible_patients|CREATE SCHEMA/.test(call.text)
      ),
      "no patient queries",
    );
    equal(fake.actions.length, 1);
  }
});

Deno.test("review: invalid fields fail before connection; missing and already decided requests fail safely", async () => {
  const handler = createHandler(() => {
    throw new Error("must not connect");
  });
  for (
    const body of [
      null,
      {},
      { ...staffReview, reason: " " },
      { ...staffReview, staff_name: "" },
      { ...staffReview, action: "delete" },
      { ...staffReview, request_id: "'" },
      { ...staffReview, decision: "REJECT" },
      { ...staffReview, action: "override" },
      { ...staffReview, action: "override", decision: "IGNORE_PRIVACY" },
      { ...staffReview, action: "override", decision: ["REJECT"] },
    ]
  ) {
    equal((await handler(post(body, base + "/review"))).status, 400);
  }
  const fake = fakeSql();
  const connected = createHandler(() => fake.sql);
  equal((await connected(post(staffReview, base + "/review"))).status, 404);
  await connected(post({ ...statistical, purpose: "insurance premiums" }));
  equal((await connected(post(staffReview, base + "/review"))).status, 409);
  equal(fake.actions.length, 0);
});

Deno.test("review: failed audit rolls back the response update", async () => {
  const fake = fakeSql();
  const held = await heldRequest(fake);
  const original = fake.sql.unsafe.bind(fake.sql);
  fake.sql.unsafe = (text, params) => {
    if (text.includes("INSERT INTO public.staff_action")) {
      throw new Error("private DB error");
    }
    return original(text, params);
  };
  const response = await createHandler(() => fake.sql)(post({
    ...staffReview,
    action: "override",
    decision: "REJECT",
  }, base + "/review"));
  equal(response.status, 500);
  equal(await response.json(), { error: "internal server error" });
  equal(fake.stored[0].response, held);
  equal(fake.actions.length, 0);
});

Deno.test("review: duplicate ids review only the latest saved submission", async () => {
  const fake = fakeSql();
  await heldRequest(fake);
  const handler = createHandler(() => fake.sql);
  await handler(post({ ...statistical, purpose: "Explore possible uses." }));
  equal(
    (await handler(
      post(
        { ...staffReview, action: "override", decision: "REJECT" },
        base + "/review",
      ),
    )).status,
    200,
  );
  equal(
    (fake.stored[0].response as Record<string, unknown>).status,
    "staff_review",
  );
  equal((fake.stored[1].response as Record<string, unknown>).status, "decided");
  equal(fake.actions[0].request_log_id, 2);
});

Deno.test("requests: CORS preflight and unsupported methods never connect", async () => {
  const handler = createHandler(() => {
    throw new Error("must not connect");
  });
  for (const method of ["OPTIONS", "PUT", "DELETE", "PATCH"]) {
    const response = await handler(
      new Request(base, {
        method,
        headers: { Origin: "https://health-data-access-compass.lovable.app" },
      }),
    );
    equal(response.status, method === "OPTIONS" ? 204 : 405);
    equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    equal(
      response.headers.get("Access-Control-Allow-Methods"),
      "GET, POST, OPTIONS",
    );
    equal(
      response.headers.get("Access-Control-Allow-Headers"),
      "authorization, x-client-info, apikey, content-type",
    );
    if (method === "OPTIONS") equal(await response.text(), "");
    else equal(await response.json(), { error: "method not allowed" });
  }
});

Deno.test("requests: malformed bodies return JSON 400 before connecting", async () => {
  const handler = createHandler(() => {
    throw new Error("must not connect");
  });
  const bodies = [
    null,
    [],
    "text",
    {},
    { ...statistical, id: " " },
    { ...statistical, requested_as: 1 },
    { ...statistical, purpose: null },
    { ...statistical, question: {} },
    { ...statistical, definitions: [1] },
  ];
  for (const body of bodies) {
    const response = await handler(post(body));
    equal(response.status, 400);
    assert(
      typeof (await response.json()).error === "string",
      "JSON error required",
    );
    equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  }
  equal(
    (await handler(new Request(base, { method: "POST", body: "{" }))).status,
    400,
  );
});

Deno.test("requests: POST runs real statistical pipeline, saves full JSON, only returns aggregates", async () => {
  // Extra patient fields in a DB row must never be passed through by the engine.
  const fake = fakeSql([
    [{ value: "Wien" }, { value: "Tirol" }],
    [{ g0: "Wien", n: "25", patient_id: "secret", birth_date: "secret" }],
  ]);
  const response = await createHandler(() => fake.sql)(post(statistical));
  equal(response.status, 200);
  const result = await response.json();
  equal(result.decision, "APPROVE_STATISTICAL");
  equal(result.request_id, "R01");
  equal(result.answer, {
    Wien: { adults_with_type2_diabetes: 25 },
    Tirol: { adults_with_type2_diabetes: "<10" },
  });
  assert(
    Array.isArray(result.articles) && typeof result.reason === "string",
    "decision envelope required",
  );
  equal(result.needs_review, false);
  const insert = fake.calls.at(-1)!;
  assert(
    insert.text.includes("INSERT INTO public.request_log"),
    "must save result",
  );
  equal(insert.params, [
    "R01",
    statistical,
    result,
  ]);
  assert(
    !JSON.stringify(result).includes("secret"),
    "no patient fields in response",
  );
  equal(fake.closed, 1);
});

Deno.test("requests: rejected requests are saved without querying patient data", async () => {
  const fake = fakeSql();
  const response = await createHandler(() => fake.sql)(post({
    ...statistical,
    id: "R02",
    purpose: "Set insurance premiums",
  }));
  equal(response.status, 200);
  const result = await response.json();
  equal(result.decision, "REJECT");
  equal(result.answer, null);
  equal(fake.calls.length, 1);
  assert(
    fake.calls[0].text.includes("INSERT INTO public.request_log"),
    "only history insert allowed",
  );
});

Deno.test("requests: parse failures are saved as review results", async () => {
  const fake = fakeSql();
  const response = await createHandler(() => fake.sql)(
    post({ ...statistical, definitions: [] }),
  );
  equal(response.status, 200);
  const result = await response.json();
  equal(result.needs_review, true);
  equal(result.answer, null);
  assert(result.parse_errors.length > 0, "parse errors returned");
  equal(fake.calls.length, 1);
  equal(fake.calls[0].params[2], result);
});

Deno.test("requests: lookup supports query and decoded path ids with deterministic latest ordering", async () => {
  const saved = {
    request_id: "R01",
    decision: "REJECT",
    articles: ["54"],
    reason: "prohibited",
    needs_review: false,
    answer: null,
  };
  for (
    const url of [
      base + "?id=R01",
      base + "/R01",
      base + "/R%30%31/",
      base + "/R02?id=R01",
    ]
  ) {
    const fake = fakeSql([[{ response: saved }]]);
    const response = await createHandler(() => fake.sql)(new Request(url));
    equal(response.status, 200);
    equal(await response.json(), saved);
    equal(fake.calls[0].params, ["R01"]);
    assert(
      fake.calls[0].text.includes(
        "ORDER BY submitted_at DESC, id DESC LIMIT 1",
      ),
      "latest duplicate id must win",
    );
    equal(fake.closed, 1);
  }
});

Deno.test("requests: lookup binds ids as values", async () => {
  const fake = fakeSql();
  const id = "R01' OR 1=1 --";
  const response = await createHandler(() => fake.sql)(
    new Request(base + "?id=" + encodeURIComponent(id)),
  );
  equal(response.status, 404);
  equal(await response.json(), { error: "request not found" });
  equal(fake.calls[0].params, [id]);
  assert(!fake.calls[0].text.includes(id), "id must not be interpolated");
});

Deno.test("requests: overview selects and projects only safe fields for every history row", async () => {
  const common = {
    request_id: "R01",
    submitted_at: "2026-10-29T12:00:00Z",
    decision: "APPROVE_STATISTICAL",
    articles: ["53", "69"],
    needs_review: false,
  };
  const fake = fakeSql([
    [{ ...common, answer: { patient_id: "secret" }, request: statistical }, {
      ...common,
      spe_schema: "spe_r01",
    }],
    [{
      request_id: "R05",
      attempted_at: "2026-10-29T13:00:00Z",
      user_agent: "secret",
      schema: "secret",
    }],
  ]);
  const response = await createHandler(() => fake.sql)(new Request(base));
  equal(response.status, 200);
  equal(await response.json(), {
    requests: [{
      ...common,
      status: "decided",
      last_staff_action: null,
      spe_schema: null,
    }, {
      ...common,
      status: "decided",
      last_staff_action: null,
      spe_schema: "spe_r01",
    }],
    downloads: [{ request_id: "R05", attempted_at: "2026-10-29T13:00:00Z" }],
  });
  assert(
    !fake.calls[0].text.includes("SELECT *"),
    "explicit projection required",
  );
  assert(
    fake.calls[0].text.includes("ORDER BY submitted_at DESC, id DESC"),
    "newest requests first",
  );
  assert(
    fake.calls[1].text.includes("ORDER BY attempted_at DESC, id DESC"),
    "newest downloads first",
  );
  equal(fake.closed, 1);
});

Deno.test("requests: empty overview includes both lists", async () => {
  const fake = fakeSql();
  equal(
    await (await createHandler(() => fake.sql)(new Request(base + "/"))).json(),
    { requests: [], downloads: [] },
  );
});

Deno.test("requests: empty and malformed ids, unknown paths, POST result paths", async () => {
  const handler = createHandler(() => {
    throw new Error("must not connect");
  });
  for (const url of [base + "?id=", base + "?id=%20", base + "/%ZZ"]) {
    equal((await handler(new Request(url))).status, 400);
  }
  equal((await handler(new Request(base + "/R01/extra"))).status, 404);
  equal((await handler(post(statistical, base + "/R01"))).status, 405);
});

Deno.test("requests: connection and query failures are sanitized JSON 500s", async () => {
  const secret = "password and stack trace";
  const fake = fakeSql();
  fake.sql.unsafe = () => {
    throw new Error(secret);
  };
  const factories = [() => {
    throw new Error(secret);
  }, () => fake.sql];
  for (const connect of factories) {
    for (
      const request of [
        new Request(base),
        new Request(base + "?id=R01"),
        post(statistical),
      ]
    ) {
      const response = await createHandler(connect)(request);
      equal(response.status, 500);
      equal(await response.json(), { error: "internal server error" });
      equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    }
  }
  equal(fake.closed, 3);
});

Deno.test("requests: failed history insertion never reports successful submission", async () => {
  const fake = fakeSql();
  fake.sql.unsafe = () => {
    throw new Error("insert failed");
  };
  const response = await createHandler(() => fake.sql)(
    post({ ...statistical, purpose: "insurance premiums" }),
  );
  equal(response.status, 500);
  equal(fake.closed, 1);
});

Deno.test("requests: cleanup failure preserves saved response", async () => {
  const fake = fakeSql();
  fake.sql.end = () => Promise.reject(new Error("private connection details"));
  const response = await createHandler(() => fake.sql)(new Request(base));
  equal(response.status, 200);
  equal(await response.json(), { requests: [], downloads: [] });
});

Deno.test("requests: SPE result saves only cohort size and schema, never record rows", async () => {
  const fake = fakeSql();
  fake.sql.unsafe = (text, params = []) => {
    fake.calls.push({ text, params });
    return Promise.resolve(
      text.includes("SELECT COUNT(*)::text AS n")
        ? [{ n: "42", patient_id: "secret" }]
        : [],
    );
  };
  const response = await createHandler(() => fake.sql)(
    post(REQUEST_FIXTURES.find((request) => request.id === "R05")),
  );
  equal(response.status, 200);
  const result = await response.json();
  equal(result.decision, "APPROVE_SPE");
  equal(result.answer, { cohort_size: 42 });
  equal(result.spe_schema, "spe_r05");
  equal(fake.calls.at(-1)!.params[2], result);
  assert(
    !JSON.stringify(result).includes("secret"),
    "no patient records returned",
  );
  equal(fake.closed, 1);
});

Deno.test("requests: resubmissions append history instead of updating or upserting", async () => {
  const fake = fakeSql();
  const handler = createHandler(() => fake.sql);
  for (const purpose of ["insurance premiums", "advertising"]) {
    equal((await handler(post({ ...statistical, purpose }))).status, 200);
  }
  equal(fake.calls.length, 2);
  for (const call of fake.calls) {
    assert(
      call.text.includes("INSERT INTO public.request_log"),
      "append submission",
    );
    assert(!call.text.includes("ON CONFLICT"), "preserve repeated ids");
    equal(call.params[0], "R01");
  }
});

Deno.test("request log: postgres.js JSONB save/load round trip stores objects", async () => {
  const fake = fakeSql();
  const request = {
    ...statistical,
    applicant: { name: 'Dr. "Example"', country: "AT" },
  };
  const response: PipelineResponse = {
    request_id: "R01",
    decision: "APPROVE_STATISTICAL",
    articles: ["53", "69"],
    reason: "Research",
    needs_review: false,
    answer: { Wien: { cohort: 25 }, Tirol: { cohort: "<10" } },
  };
  await saveRequest(fake.sql, request, response);
  equal(fake.stored.length, 1);
  equal(typeof fake.stored[0].request, "object");
  equal(typeof fake.stored[0].response, "object");
  equal(fake.stored[0].request, request);
  equal(fake.stored[0].response, response);
  equal(await loadRequest(fake.sql, "R01"), response);
  const result = await createHandler(() => fake.sql)(
    new Request(base + "?id=R01"),
  );
  equal(result.status, 200);
  equal(await result.json(), response);
  const overview =
    await (await createHandler(() => fake.sql)(new Request(base))).json();
  equal(overview.requests[0].decision, response.decision);
  equal(overview.requests[0].articles, response.articles);
  equal(overview.requests[0].needs_review, false);
  assert(!("answer" in overview.requests[0]), "overview must omit answers");
});

Deno.test("request log: existing JSON string rows load as objects and populate overview", async () => {
  const response = {
    request_id: "R05",
    decision: "APPROVE_SPE",
    articles: ["53", "66", "68", "73"],
    reason: "Research",
    needs_review: false,
    spe_schema: "spe_r05",
    answer: { cohort_size: 42 },
  };
  const fake = fakeSql();
  fake.stored.push({
    request_id: "R05",
    request: JSON.stringify(statistical),
    response: JSON.stringify(response),
  });
  equal(await loadRequest(fake.sql, "R05"), response);
  const handler = createHandler(() => fake.sql);
  for (const url of [base + "?id=R05", base + "/R05"]) {
    const result = await handler(new Request(url));
    equal(result.status, 200);
    equal(await result.json(), response);
  }
  const overview = await (await handler(new Request(base))).json();
  equal(overview.requests, [{
    request_id: "R05",
    submitted_at: "2026-10-29T12:00:00Z",
    decision: "APPROVE_SPE",
    articles: response.articles,
    needs_review: false,
    status: "decided",
    last_staff_action: null,
    spe_schema: "spe_r05",
  }]);
  assert(
    !JSON.stringify(overview).includes("cohort_size"),
    "overview must omit answers",
  );
});

Deno.test("request log: JSONB fake distinguishes an encoded string from an object", async () => {
  const fake = fakeSql();
  const value = { request_id: "R01", decision: "REJECT" };
  // Reproduce the old bug: a serialized string passed to a JSONB parameter.
  await fake.sql.unsafe(
    "INSERT INTO public.request_log VALUES ($1, $2::jsonb, $3::jsonb)",
    ["R01", JSON.stringify(statistical), JSON.stringify(value)],
  );
  equal(typeof fake.stored[0].request, "string");
  equal(typeof fake.stored[0].response, "string");
  equal(await loadRequest(fake.sql, "R01"), value);
});
