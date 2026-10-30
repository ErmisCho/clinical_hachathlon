import { HDABS, publicConfig, validateConfig } from "./config.ts";
import { decide, RULES_VERSION } from "../decision.ts";
import { explain, verifyQuotes } from "../explain.ts";
import { REQUESTS } from "../decision_fixtures.ts";
import { REQUEST_FIXTURES } from "../parser_fixtures.ts";
import { answerRequest, type SqlClient } from "../pipeline.ts";
import { createHandler, type RequestDatabase } from "../../requests/handler.ts";

function assert(value: boolean, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
const at = HDABS.find((c) => c.code === "at")!;
const de = HDABS.find((c) => c.code === "de")!;
const request = {
  ...REQUESTS.R01,
  purpose: "Research on genetic discrimination.",
};

Deno.test("AT preserves every baseline fixture field except the version suffix", () => {
  for (const req of [...Object.values(REQUESTS), ...REQUEST_FIXTURES]) {
    const baseline = decide(req);
    const configured = decide(req, at.extra_prohibited, at.code);
    assert(
      JSON.stringify(configured) ===
        JSON.stringify({ ...baseline, rules_version: `${RULES_VERSION}+at` }),
    );
  }
});

for (const config of HDABS) {
  for (const rule of config.extra_prohibited) {
    Deno.test(`${config.code}/${rule.id} examples and counter-examples`, () => {
      for (const purpose of rule.examples) {
        const result = decide(
          { ...request, purpose },
          config.extra_prohibited,
          config.code,
        );
        assert(
          result.decision === "REJECT" && result.rule_id === rule.id,
          purpose,
        );
      }
      for (const purpose of rule.counter_examples) {
        const result = decide(
          { ...request, purpose },
          config.extra_prohibited,
          config.code,
        );
        assert(
          result.rule_id !== rule.id && result.decision !== "REJECT",
          purpose,
        );
      }
    });
  }
}

Deno.test("national rules only add rejections and never query patients", async () => {
  assert(
    decide(request, at.extra_prohibited).decision === "APPROVE_STATISTICAL",
  );
  const sql = {
    unsafe: () => {
      throw new Error("Patient query");
    },
  } as unknown as SqlClient;
  const result = await answerRequest(request, sql, undefined, de);
  assert(
    result.decision === "REJECT" && result.rule_id === "N-DE-01" &&
      result.rules_version === `${RULES_VERSION}+de`,
  );
  assert(result.answer === null && !result.explanation_error);
  const override = await answerRequest(request, sql, {
    decision: "APPROVE_SPE",
    reason: "Override",
  }, de);
  assert(override.decision === "REJECT");
  const mixed = await answerRequest(
    { ...request, purpose: "Genetic discrimination and insurance premiums." },
    sql,
    { decision: "APPROVE_SPE", reason: "Override" },
    de,
  );
  assert(mixed.decision === "REJECT" && mixed.rule_id === "N-DE-01");
  for (const req of Object.values(REQUESTS)) {
    if (decide(req).decision === "REJECT") {
      assert(decide(req, de.extra_prohibited).decision === "REJECT");
    }
  }
});

Deno.test("HTTP submission applies the national rule before any patient query", async () => {
  const queries: string[] = [];
  const sql = Object.assign(
    async (_strings: TemplateStringsArray, ..._values: unknown[]) => [],
    {
      json: (value: unknown) => value,
      end: () => Promise.resolve(),
      unsafe: (query: string) => {
        queries.push(query);
        if (query.includes("SELECT id FROM public.request_log")) {
          return Promise.resolve([{ id: 1 }]);
        }
        if (query.includes("INSERT INTO public.request_event")) {
          return Promise.resolve([{ at: "2026-10-30T12:00:00Z" }]);
        }
        throw new Error("Unexpected patient query");
      },
    },
  ) as unknown as RequestDatabase;
  const handler = createHandler(() => sql);
  const response = await handler(
    new Request("http://local/requests", {
      method: "POST",
      headers: { "x-hdab": "de", "content-type": "application/json" },
      body: JSON.stringify({
        ...REQUEST_FIXTURES[0],
        purpose: request.purpose,
      }),
    }),
  );
  assert(response.status === 200);
  const body = await response.json();
  assert(
    body.decision === "REJECT" && body.rule_id === "N-DE-01" &&
      body.answer === null,
  );
  assert(queries.every((query) => query.includes("public.request_")));
});

Deno.test("strict config validation rejects unknown nested fields and malformed rules", () => {
  const invalid = [
    { ...at, typo: true },
    { ...at, branding: { ...at.branding, typo: true } },
    { ...de, extra_prohibited: [{ ...de.extra_prohibited[0], typo: true }] },
    { ...at, display_language: "fr" },
    { ...at, branding: { ...at.branding, accent: "red; color: white" } },
    {
      ...de,
      extra_prohibited: [{ ...de.extra_prohibited[0], phrases: ["["] }],
    },
  ];
  for (const config of invalid) {
    let threw = false;
    try {
      validateConfig(config);
    } catch {
      threw = true;
    }
    assert(threw);
  }
});

Deno.test("module loads with no filesystem access: HDABS populated without Deno.readDir", () => {
  // config.ts must use a static JSON import, not runtime filesystem discovery.
  // If the module loaded (we are here), it did not crash. Verify the baseline.
  assert(HDABS.length >= 2, "at least at and de must be present");
  assert(HDABS.every((c) => c.code.length === 2), "all codes are two letters");
  assert(HDABS.find((c) => c.code === "at") !== undefined, "AT is present");
  assert(HDABS.find((c) => c.code === "de") !== undefined, "DE is present");
  // HDABS must not expose extra_prohibited (it is present but internal)
  assert(
    !Object.prototype.hasOwnProperty.call(HDABS[0], "readDir"),
    "no Deno.readDir artefact",
  );
});

Deno.test("default HDAB is AT: no x-hdab header yields AT behaviour", async () => {
  const handler = createHandler(() => {
    throw new Error("Unexpected database");
  });
  const response = await handler(
    new Request("http://local/requests/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...REQUESTS.R01, definitions: [] }),
    }),
  );
  assert(response.status === 200);
  const body = await response.json();
  // AT has no extra_prohibited, so AT results match the pure baseline.
  const baseline = decide(REQUESTS.R01);
  assert(body.rules_version === `${RULES_VERSION}+at`);
  assert(body.decision === baseline.decision);
});

Deno.test("unknown x-hdab code returns 400, not 500", async () => {
  const handler = createHandler(() => {
    throw new Error("Unexpected database");
  });
  for (
    const req of [
      new Request("http://local/requests?hdab=xx"),
      new Request("http://local/requests", {
        method: "POST",
        headers: { "x-hdab": "xx", "content-type": "application/json" },
        body: "{}",
      }),
      new Request("http://local/requests/preview?hdab=zz"),
    ]
  ) {
    const r = await handler(req);
    assert(r.status === 400, `expected 400 for ${req.url}, got ${r.status}`);
    const body = await r.json();
    assert(
      typeof body.error === "string" && body.error.includes("unknown"),
      `expected unknown-HDAB error, got: ${JSON.stringify(body)}`,
    );
  }
});

Deno.test("HDAB discovery, precedence, unknown codes and preview need no database", async () => {
  const handler = createHandler(() => {
    throw new Error("Unexpected database");
  });
  const discovery = await handler(new Request("http://local/requests/hdab"));
  const data = await discovery.json();
  assert(
    JSON.stringify(data.configs) === JSON.stringify(HDABS.map(publicConfig)),
  );
  assert(!JSON.stringify(data).includes("extra_prohibited"));
  for (const route of ["", "/preview", "/review", "/hdab"]) {
    assert(
      (await handler(new Request(`http://local/requests${route}?hdab=unknown`)))
        .status === 400,
    );
  }
  for (
    const [query, header, expected] of [
      ["de", undefined, "REJECT"],
      ["de", "at", "APPROVE_STATISTICAL"],
      ["at", "de", "REJECT"],
      ["", undefined, "APPROVE_STATISTICAL"],
    ]
  ) {
    const response = await handler(
      new Request(
        `http://local/requests/preview?${query ? `hdab=${query}` : ""}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(header ? { "x-hdab": header } : {}),
          },
          body: JSON.stringify({ ...request, definitions: [] }),
        },
      ),
    );
    assert(response.status === 200);
    assert((await response.json()).decision === expected);
  }
  const cors = await handler(
    new Request("http://local/requests", { method: "OPTIONS" }),
  );
  assert(cors.headers.get("Access-Control-Allow-Headers")!.includes("x-hdab"));
});

Deno.test("N-DE-01 rejection cites Art. 54(1)(e) and applies is verbatim substring of quote", () => {
  const de = HDABS.find((c) => c.code === "de")!;
  const req = {
    ...REQUESTS.R01,
    purpose: "We propose genetic discrimination.",
  };
  const dr = decide(req, de.extra_prohibited, de.code);
  assert(dr.decision === "REJECT" && dr.rule_id === "N-DE-01");

  const exp = explain(req, dr);
  const art54 = exp.articles.find((a) => a.number === "54");
  assert(art54 !== undefined, "explanation must include Art. 54");
  assert(
    art54.ref === "Art. 54(1)(e)",
    `expected ref "Art. 54(1)(e)", got "${art54.ref}"`,
  );
  assert(
    art54.point === "(e)",
    `expected point "(e)", got "${art54.point}"`,
  );
  assert(
    art54.applies.includes("national law"),
    `applies must mention national law, got: "${art54.applies}"`,
  );
  // applies must be a verbatim substring of the regulation quote
  assert(
    verifyQuotes(exp, req),
    `verifyQuotes failed: applies "${art54.applies}" is not a substring of the quote`,
  );
});
