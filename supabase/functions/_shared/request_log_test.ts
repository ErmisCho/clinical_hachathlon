import { loadRequest, saveRequest } from "./request_log.ts";
import type { PipelineResponse } from "./pipeline.ts";
import { decide } from "./decision.ts";
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
  const events: { request_log_id: unknown; request_id: unknown; status: string; at: string }[] = [];
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
        if (text.includes("INSERT INTO public.request_event")) {
          const at = "2026-10-30T12:00:00.000Z";
          events.push({
            request_log_id: params[0],
            request_id: params[1],
            status: String(params[2]),
            at,
          });
          // Return the RETURNING at value so recordEvents/recordReviewEvents get real timestamps.
          return Promise.resolve([{ at }]);
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
        // saveRequest: retrieve the id of the just-inserted row.
        if (
          text.includes("SELECT id FROM public.request_log") &&
          text.includes("ORDER BY submitted_at DESC, id DESC LIMIT 1")
        ) {
          const index = stored.findLastIndex((row) =>
            row.request_id === params[0]
          );
          return Promise.resolve(index < 0 ? [] : [{ id: index + 1 }]);
        }
        // loadRequest: retrieve id + response for a specific request_id.
        if (
          text.includes("SELECT id, response FROM public.request_log") &&
          text.includes("ORDER BY submitted_at DESC, id DESC LIMIT 1")
        ) {
          const index = stored.findLastIndex((row) =>
            row.request_id === params[0]
          );
          return Promise.resolve(
            index < 0
              ? []
              : [{ id: index + 1, response: stored[index].response }],
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
        // Timeline events for loadRequest.
        if (text.includes("FROM public.request_event") && text.includes("WHERE request_log_id")) {
          const logId = String(params[0]);
          return Promise.resolve(
            events
              .filter((e) => String(e.request_log_id) === logId)
              .map((e) => ({ status: e.status, at: e.at })),
          );
        }
        if (
          text.includes("FROM public.staff_action") &&
          text.includes("LIMIT 100")
        ) {
          return Promise.resolve(
            actions.map((a) => ({
              request_id: a.request_id,
              action: a.action,
              decision: a.decision,
              reason: a.reason,
              staff_name: a.staff_name,
              created_at: a.created_at,
            })),
          );
        }
        if (text.includes("AS history")) {
          assert(
            text.includes("WITH held AS MATERIALIZED") &&
              text.includes("END = 'true'::jsonb") &&
              text.includes("WHERE id NOT IN (SELECT id FROM held)") &&
              text.includes(
                "ORDER BY submitted_at DESC, id DESC\n       LIMIT",
              ) &&
              text.includes("100 - (SELECT COUNT(*) FROM held)") &&
              text.includes("UNION ALL") && text.includes("FROM selected"),
            "select held rows and bounded recent decisions before projection",
          );
          assert(
            text.includes("jsonb_typeof(response) = 'string'"),
            "normalize legacy rows before projection",
          );
          assert(
            text.includes("(response #>> '{}')::jsonb"),
            "decode legacy JSON string",
          );
          const newest = stored.toReversed();
          const isHeld = (row: typeof stored[number]) =>
            (typeof row.response === "string"
              ? JSON.parse(row.response)
              : row.response).needs_review === true;
          const held = newest.filter(isHeld);
          const recent = newest.filter((row) => !isHeld(row)).slice(
            0,
            Math.max(0, 100 - held.length),
          );
          return Promise.resolve(
            newest.filter((row) => held.includes(row) || recent.includes(row))
              .map((row) => {
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
        const eventCount = events.length;
        try {
          return await fn(sql);
        } catch (error) {
          stored.splice(0, stored.length, ...snapshot);
          actions.splice(actionCount);
          events.splice(eventCount);
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
    events,
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
  // At least the INSERT must have been called.
  assert(
    fake.calls.some((c) => c.text.includes("INSERT INTO public.request_log")),
    "must save held request",
  );
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
  // stored response has no timeline (saved before timeline is added); compare core fields.
  const stored = fake.stored[0].response as Record<string, unknown>;
  equal(stored.status, result.status);
  equal(stored.decision, result.decision);
  equal(stored.answer, result.answer);
  // GET ?id returns result with timeline from DB.
  const got = await (await handler(new Request(base + "/R01"))).json();
  equal(got.status, "decided");
  assert(Array.isArray(got.timeline) && got.timeline.length > 0, "GET ?id has timeline");
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
  const held = await heldRequest(fake);
  const response = await createHandler(() => fake.sql)(post({
    ...staffReview,
    action: "override",
    decision: "REJECT",
  }, base + "/review"));
  equal(response.status, 200);
  const result = await response.json();
  equal(result.decision, "REJECT");
  equal(result.rule_id, held.rule_id);
  equal(result.rules_version, held.rules_version);
  const saved = await (await createHandler(() => fake.sql)(
    new Request(base + "?id=R01"),
  )).json();
  equal(saved.rule_id, held.rule_id);
  equal(saved.rules_version, held.rules_version);
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
    const held = await heldRequest(fake);
    patientResults(fake);
    const response = await createHandler(() => fake.sql)(post({
      ...staffReview,
      action: "override",
      decision,
    }, base + "/review"));
    equal(response.status, 200);
    const result = await response.json();
    equal(result.decision, decision);
    equal(result.rule_id, held.rule_id);
    equal(result.rules_version, held.rules_version);
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
  equal(await response.json(), {
    error: "internal server error",
    code: "Error",
    stage: "review_request",
  });
  // stored response should be unchanged (without timeline since we compare core fields).
  const storedResp = fake.stored[0].response as Record<string, unknown>;
  equal(storedResp.status, held.status);
  equal(storedResp.decision, held.decision);
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
      "authorization, x-client-info, apikey, content-type, x-hdab",
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
  // Find the request_log INSERT (not necessarily the last call anymore).
  const insert = fake.calls.find((c) => c.text.includes("INSERT INTO public.request_log"))!;
  assert(insert !== undefined, "must save result");
  // The saved params are the original response (before timeline is appended).
  equal(insert.params[0], "R01");
  equal(insert.params[1], statistical);
  // result.timeline is added after save; compare core fields only.
  const savedResp = insert.params[2] as Record<string, unknown>;
  equal(savedResp.decision, result.decision);
  equal(savedResp.answer, result.answer);
  assert(
    !JSON.stringify(result).includes("secret"),
    "no patient fields in response",
  );
  // Timeline is present in POST response.
  assert(
    Array.isArray(result.timeline) && result.timeline.length > 0,
    "POST response includes timeline",
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
  // At least the INSERT must be present; no patient data queries.
  assert(
    fake.calls.some((c) => c.text.includes("INSERT INTO public.request_log")),
    "only history insert allowed",
  );
  assert(
    fake.calls.every((call) =>
      !/eligible_patients|CREATE SCHEMA/.test(call.text)
    ),
    "no patient data queries",
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
  const insert = fake.calls.find((c) => c.text.includes("INSERT INTO public.request_log"))!;
  assert(insert !== undefined, "must save result");
  // The saved params[2] is the response without timeline.
  const savedResp = insert.params[2] as Record<string, unknown>;
  equal(savedResp.decision, result.decision);
  equal(savedResp.needs_review, result.needs_review);
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
    const fake = fakeSql([[{ id: 1, response: saved }]]);
    const response = await createHandler(() => fake.sql)(new Request(url));
    equal(response.status, 200);
    const got = await response.json();
    equal(got.decision, saved.decision);
    equal(got.request_id, saved.request_id);
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
    staff_actions: [],
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
    fake.calls[1].text.includes(
      "ORDER BY attempted_at DESC, id DESC LIMIT 100",
    ),
    "newest 100 downloads first",
  );
  equal(fake.closed, 1);
});

Deno.test("requests: overview limits decided history to the newest 100 rows", async () => {
  const fake = fakeSql();
  for (let index = 0; index < 130; index++) {
    fake.stored.push({
      request_id: `R${index}`,
      request: {},
      response: { decision: "REJECT", needs_review: false },
    });
  }
  const response = await createHandler(() => fake.sql)(new Request(base));
  equal(response.status, 200);
  const result = await response.json();
  equal(
    result.requests.map((row: { request_id: string }) => row.request_id),
    Array.from({ length: 100 }, (_, index) => `R${129 - index}`),
  );
});

Deno.test("requests: overview retains old held rows, including legacy JSON strings", async () => {
  const fake = fakeSql();
  for (let index = 0; index < 130; index++) {
    const response = { decision: "REJECT", needs_review: index < 2 };
    fake.stored.push({
      request_id: `R${index}`,
      request: {},
      response: index === 0 ? JSON.stringify(response) : response,
    });
  }
  const response = await createHandler(() => fake.sql)(new Request(base));
  equal(response.status, 200);
  const result = await response.json();
  equal(result.requests.map((row: { request_id: string }) => row.request_id), [
    ...Array.from({ length: 98 }, (_, index) => `R${129 - index}`),
    "R1",
    "R0",
  ]);
  equal(
    result.requests.filter((row: { needs_review: boolean }) => row.needs_review)
      .map((row: { request_id: string }) => row.request_id),
    ["R1", "R0"],
  );
});

Deno.test("requests: overview never drops held rows when the queue exceeds 100", async () => {
  const fake = fakeSql();
  for (let index = 0; index < 111; index++) {
    fake.stored.push({
      request_id: `R${index}`,
      request: {},
      response: { needs_review: index < 110 },
    });
  }
  const response = await createHandler(() => fake.sql)(new Request(base));
  equal(response.status, 200);
  const result = await response.json();
  equal(
    result.requests.map((row: { request_id: string }) => row.request_id),
    Array.from({ length: 110 }, (_, index) => `R${109 - index}`),
  );
});

Deno.test("requests: empty overview includes both lists", async () => {
  const fake = fakeSql();
  equal(
    await (await createHandler(() => fake.sql)(new Request(base + "/"))).json(),
    { requests: [], downloads: [], staff_actions: [] },
  );
});

Deno.test("requests: overview includes staff_actions newest first, limit 200, no private fields", async () => {
  const fake = fakeSql();
  await heldRequest(fake);
  const handler = createHandler(() => fake.sql);
  patientResults(fake);
  await handler(post(staffReview, base + "/review"));
  const overview = await (await handler(new Request(base))).json();
  equal(overview.staff_actions.length, 1);
  const sa = overview.staff_actions[0];
  equal(sa.request_id, "R01");
  equal(sa.action, "approve");
  equal(sa.staff_name, "Reviewer");
  equal(sa.reason, staffReview.reason);
  assert(typeof sa.created_at === "string", "created_at must be present");
  assert(!("id" in sa), "staff_action id must not leak");
  assert(!("request_log_id" in sa), "request_log_id must not leak");
  assert(
    fake.calls.some(
      (call) =>
        call.text.includes("FROM public.staff_action") &&
        call.text.includes("ORDER BY created_at DESC, id DESC") &&
        call.text.includes("LIMIT 100"),
    ),
    "must query staff_action with ordering and limit",
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
      equal(await response.json(), {
        error: "internal server error",
        code: "Error",
        stage: connect === factories[0]
          ? "connect"
          : request.method === "POST"
          ? "answer_request"
          : new URL(request.url).searchParams.has("id")
          ? "load_request"
          : "list_requests",
      });
      equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    }
  }
  equal(fake.closed, 3);
});

Deno.test("requests: overview query failure returns only SQLSTATE and stage", async () => {
  const fake = fakeSql();
  fake.sql.unsafe = () => {
    throw Object.assign(new Error("private SQL and row data"), {
      code: "42501",
    });
  };
  const response = await createHandler(() => fake.sql)(new Request(base));
  equal(response.status, 500);
  equal(await response.json(), {
    error: "internal server error",
    code: "42501",
    stage: "list_requests",
  });
  equal(fake.closed, 1);
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
  equal(await response.json(), { requests: [], downloads: [], staff_actions: [] });
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
  const insert = fake.calls.find((c) => c.text.includes("INSERT INTO public.request_log"))!;
  assert(insert !== undefined, "must save result");
  // The saved params[2] excludes timeline (added after save).
  const savedResp = insert.params[2] as Record<string, unknown>;
  equal(savedResp.decision, result.decision);
  equal(savedResp.answer, result.answer);
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
  const inserts = fake.calls.filter((c) =>
    c.text.includes("INSERT INTO public.request_log")
  );
  equal(inserts.length, 2);
  for (const call of inserts) {
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
    rule_id: decide(statistical).rule_id,
    rules_version: decide(statistical).rules_version,
    decision: "APPROVE_STATISTICAL",
    articles: ["53", "69"],
    reason: "Research",
    needs_review: false,
    answer: { Wien: { cohort: 25 }, Tirol: { cohort: "<10" } },
  };
  const { logId } = await saveRequest(fake.sql, request, response);
  assert(logId !== undefined, "saveRequest returns logId");
  equal(fake.stored.length, 1);
  equal(typeof fake.stored[0].request, "object");
  equal(typeof fake.stored[0].response, "object");
  equal(fake.stored[0].request, request);
  equal(fake.stored[0].response, response);
  const loaded = await loadRequest(fake.sql, "R01");
  assert(loaded !== null, "must load response");
  equal(loaded.decision, response.decision);
  equal(loaded.answer, response.answer);
  const result = await createHandler(() => fake.sql)(
    new Request(base + "?id=R01"),
  );
  equal(result.status, 200);
  const got = await result.json();
  equal(got.decision, response.decision);
  equal(got.answer, response.answer);
  equal(got.rule_id, response.rule_id);
  equal(got.rules_version, response.rules_version);
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
  const loaded = await loadRequest(fake.sql, "R05");
  assert(loaded !== null, "must load response");
  equal(loaded.decision, response.decision);
  equal(loaded.answer, response.answer);
  const handler = createHandler(() => fake.sql);
  for (const url of [base + "?id=R05", base + "/R05"]) {
    const result = await handler(new Request(url));
    equal(result.status, 200);
    const got = await result.json();
    equal(got.decision, response.decision);
    equal(got.answer, response.answer);
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
  const loaded = await loadRequest(fake.sql, "R01");
  assert(loaded !== null, "must load response");
  equal(loaded.decision, value.decision);
});

// ---------------------------------------------------------------------------
// Lifecycle timeline tests
// ---------------------------------------------------------------------------

Deno.test("lifecycle: statistical submission records submitted+assessed+decided+fulfilled", async () => {
  const fake = fakeSql([
    [{ value: "Wien" }, { value: "Tirol" }],
    [{ g0: "Wien", n: "25" }, { g0: "Tirol", n: "4" }],
  ]);
  const response = await createHandler(() => fake.sql)(post(statistical));
  equal(response.status, 200);
  const result = await response.json();
  equal(result.decision, "APPROVE_STATISTICAL");
  assert(Array.isArray(result.timeline), "timeline present in POST response");
  const statuses = result.timeline.map((e: { status: string }) => e.status);
  equal(statuses, ["submitted", "assessed", "decided", "fulfilled"]);
  // Real timestamps (non-empty ISO 8601) from RETURNING at.
  assert(
    result.timeline.every((e: { at: string }) => e.at.length > 0),
    "POST timeline has real timestamps",
  );
  equal(result.lifecycle_status, "fulfilled");
  // Events stored in DB.
  equal(
    fake.events.filter((e) => e.request_id === "R01").map((e) => e.status),
    ["submitted", "assessed", "decided", "fulfilled"],
  );
  // GET ?id returns timeline with DB timestamps and lifecycle_status.
  const got = await (await createHandler(() => fake.sql)(new Request(base + "?id=R01"))).json();
  assert(Array.isArray(got.timeline) && got.timeline.length === 4, "GET has 4 timeline events");
  equal(got.timeline[0].status, "submitted");
  equal(got.timeline[3].status, "fulfilled");
  assert(got.timeline[0].at.length > 0, "GET timeline events have ISO 8601 timestamps");
  equal(got.lifecycle_status, "fulfilled");
});

Deno.test("lifecycle: SPE submission records submitted+assessed+decided+fulfilled", async () => {
  const fake = fakeSql();
  fake.sql.unsafe = (text, params = []) => {
    fake.calls.push({ text, params });
    if (text.includes("INSERT INTO public.request_event")) {
      const at = "2026-10-30T12:00:00.000Z";
      fake.events.push({
        request_log_id: params[0] as unknown,
        request_id: params[1] as unknown as string,
        status: String(params[2]),
        at,
      });
      return Promise.resolve([{ at }]);
    }
    if (text.includes("SELECT COUNT(*)::text AS n")) {
      return Promise.resolve([{ n: "42" }]);
    }
    if (text.includes("SELECT id FROM public.request_log")) {
      const index = fake.stored.findLastIndex((row) => row.request_id === params[0]);
      return Promise.resolve(index < 0 ? [] : [{ id: index + 1 }]);
    }
    if (text.includes("SELECT id, response FROM public.request_log")) {
      const index = fake.stored.findLastIndex((row) => row.request_id === params[0]);
      return Promise.resolve(
        index < 0 ? [] : [{ id: index + 1, response: fake.stored[index].response }],
      );
    }
    if (text.includes("FROM public.request_event")) {
      const logId = String(params[0]);
      return Promise.resolve(
        fake.events.filter((e) => String(e.request_log_id) === logId).map((e) => ({
          status: e.status,
          at: e.at,
        })),
      );
    }
    if (text.includes("INSERT INTO public.request_log")) {
      fake.stored.push({
        request_id: params[0] as string,
        request: JSON.parse(JSON.stringify(params[1])),
        response: JSON.parse(JSON.stringify(params[2])),
      });
    }
    return Promise.resolve([]);
  };
  const speRequest = REQUEST_FIXTURES.find((r) => r.id === "R05")!;
  const response = await createHandler(() => fake.sql)(post(speRequest));
  equal(response.status, 200);
  const result = await response.json();
  equal(result.decision, "APPROVE_SPE");
  const statuses = result.timeline.map((e: { status: string }) => e.status);
  equal(statuses, ["submitted", "assessed", "decided", "fulfilled"]);
  equal(
    fake.events.map((e) => e.status),
    ["submitted", "assessed", "decided", "fulfilled"],
  );
});

Deno.test("lifecycle: rejected submission records submitted+assessed+decided (no fulfilled)", async () => {
  const fake = fakeSql();
  const response = await createHandler(() => fake.sql)(post({
    ...statistical,
    id: "R02",
    purpose: "Set insurance premiums",
  }));
  equal(response.status, 200);
  const result = await response.json();
  equal(result.decision, "REJECT");
  const statuses = result.timeline.map((e: { status: string }) => e.status);
  equal(statuses, ["submitted", "assessed", "decided"]);
  equal(result.lifecycle_status, "decided");
  equal(
    fake.events.filter((e) => e.request_id === "R02").map((e) => e.status),
    ["submitted", "assessed", "decided"],
  );
});

Deno.test("lifecycle: held submission records submitted+assessed+staff_review (no decided/fulfilled)", async () => {
  const fake = fakeSql();
  const held = await heldRequest(fake);
  const statuses = held.timeline.map((e: { status: string }) => e.status);
  equal(statuses, ["submitted", "assessed", "staff_review"]);
  equal(held.lifecycle_status, "staff_review");
  equal(
    fake.events.filter((e) => e.request_id === "R01").map((e) => e.status),
    ["submitted", "assessed", "staff_review"],
  );
});

Deno.test("lifecycle: held→approved returns full timeline and lifecycle_status=fulfilled", async () => {
  const fake = fakeSql();
  await heldRequest(fake);
  patientResults(fake);
  const handler = createHandler(() => fake.sql);
  const response = await handler(post(staffReview, base + "/review"));
  equal(response.status, 200);
  const result = await response.json();
  equal(result.status, "decided");
  // Review response includes the FULL timeline (prior events + new events).
  const statuses = result.timeline.map((e: { status: string }) => e.status);
  equal(statuses, ["submitted", "assessed", "staff_review", "decided", "fulfilled"]);
  equal(result.lifecycle_status, "fulfilled");
  // Events accumulated: submitted+assessed+staff_review from initial hold +
  // decided+fulfilled from review.
  const allStatuses = fake.events
    .filter((e) => e.request_id === "R01")
    .map((e) => e.status);
  equal(allStatuses, ["submitted", "assessed", "staff_review", "decided", "fulfilled"]);
  // GET ?id shows full timeline with lifecycle_status.
  const got = await (await handler(new Request(base + "/R01"))).json();
  assert(Array.isArray(got.timeline) && got.timeline.length === 5, "GET has 5 timeline events");
  equal(got.timeline.map((e: { status: string }) => e.status), [
    "submitted", "assessed", "staff_review", "decided", "fulfilled",
  ]);
  equal(got.lifecycle_status, "fulfilled");
});
