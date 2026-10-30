import { createHandler, organisationType, publicEntries } from "./handler.ts";
import fixture from "../../fixtures/jury/J01.json" with { type: "json" };
import { decide } from "../_shared/decision.ts";
import RULES from "../_shared/rules/decision_rules.json" with { type: "json" };

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function row(id: number, requestId = `private-${id}`, held = false) {
  return {
    id,
    request_id: requestId,
    submitted_at: "2026-10-30T12:34:56.789Z",
    requested_as: fixture.requested_as,
    requested_format: fixture.requested_format,
    purpose: fixture.purpose,
    question: fixture.question,
    definitions: fixture.definitions,
    organisation: fixture.applicant.organisation,
    decision: "APPROVE_STATISTICAL",
    articles: ["53", "69"],
    needs_review: held,
  };
}

Deno.test("register publishes only the safe fields from a saved fixture", () => {
  const entries = publicEntries([row(123)]);
  const entry = entries[0];
  assert(
    JSON.stringify(Object.keys(entry).sort()) === JSON.stringify([
      "articles",
      "date",
      "decision",
      "organisation_type",
      "purpose_category",
      "reference",
    ]),
  );
  assert(entry.reference === "HDAB-2026-000123");
  assert(entry.date === "2026-10-30");
  assert(entry.organisation_type === "Research institution");
  assert(
    entry.purpose_category ===
      RULES.rules.find((r) => r.id === decide(fixture).rule_id)?.label,
  );
  assert(entry.decision === "APPROVE_STATISTICAL");
  assert(JSON.stringify(entry.articles) === '["53","69"]');
  const output = JSON.stringify(entries);
  for (
    const secret of [
      fixture.id,
      fixture.applicant.name,
      fixture.applicant.organisation,
      fixture.purpose,
      fixture.question,
      ...fixture.definitions,
      "private-123",
      "987654321",
      "123456789",
      "private_schema",
      "private_answer",
    ]
  ) assert(!output.includes(secret), `Leaked ${secret}`);
});

Deno.test("register deduplicates latest first, excludes holds before limit, and caps at 100", () => {
  const rows = Array.from({ length: 205 }, (_, i) => row(i + 1));
  rows.push(row(206, "private-205", true));
  rows.push(row(207, "private-204"));
  const entries = publicEntries(rows);
  assert(entries.length === 100);
  assert(entries[0].reference === "HDAB-2026-000207");
  assert(entries[1].reference === "HDAB-2026-000203");
  assert(entries.at(-1)?.reference === "HDAB-2026-000105");
  assert(!entries.some((entry) => /00020[456]$/.test(entry.reference)));
  const later = { ...row(1, "same"), submitted_at: "2026-10-31T00:00:00Z" };
  assert(
    publicEntries([row(9, "same"), later])[0].reference === "HDAB-2026-000001",
  );
});

Deno.test("register preserves saved staff decisions from projected columns", () => {
  const saved = row(1);
  const entries = publicEntries([{
    ...saved,
    decision: "REJECT",
    articles: ["54", fixture.applicant.name],
  }]);
  assert(entries[0].decision === "REJECT");
  assert(JSON.stringify(entries[0].articles) === '["54"]');
  assert(
    publicEntries([{
      ...saved,
      needs_review: true,
    }]).length === 0,
  );
});

Deno.test("organisation map returns categories only, with explicit precedence", () => {
  for (
    const [name, category] of [
      ["Example University", "Research institution"],
      ["Example Clinic", "Healthcare provider"],
      ["Public Health Agency", "Public body"],
      ["Example Insurer", "Insurer"],
      ["Marketing Agency", "Company"],
      ["Example GmbH", "Company"],
      ["Example AG", "Company"],
      ["Unknown Applicant", "Other"],
    ]
  ) assert(organisationType(name) === category);
});

Deno.test("register HTTP routing, bounded query, cleanup and CORS", async () => {
  let connected = 0;
  let closed = 0;
  const handler = createHandler(() => {
    connected++;
    return {
      unsafe(query) {
        assert(query.includes("DISTINCT ON (request_id)"));
        assert(
          query.includes("ORDER BY request_id, submitted_at DESC, id DESC"),
        );
        assert(query.includes("FROM latest"));
        assert(query.includes("IS DISTINCT FROM 'true'::jsonb"));
        assert(query.includes("ORDER BY submitted_at DESC, id DESC LIMIT 100"));
        // SQL normalizes legacy objects and projects individual fields only.
        assert(query.includes("jsonb_typeof(request) = 'string'"));
        assert(query.includes("jsonb_typeof(response) = 'string'"));
        for (
          const field of [
            "requested_as",
            "requested_format",
            "purpose",
            "question",
            "definitions",
            "decision",
            "articles",
            "needs_review",
          ]
        ) {
          assert(query.includes(`AS ${field}`));
        }
        assert(
          query.includes("->'applicant'->>'organisation' AS organisation"),
        );
        const projection = query.slice(
          query.lastIndexOf("SELECT id,"),
          query.lastIndexOf("FROM latest"),
        );
        assert(!/\b(request|response)\b|\*/.test(projection));
        assert(!/\bAS\s+(request|response)\b/.test(query));
        return Promise.resolve([row(1)]);
      },
      end() {
        closed++;
        return Promise.resolve();
      },
    };
  });
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    assert(
      (await handler(new Request("https://example.com/register", { method })))
        .status === 405,
    );
  }
  const options = await handler(
    new Request("https://example.com/register", { method: "OPTIONS" }),
  );
  assert(options.status === 204);
  assert(
    options.headers.get("Access-Control-Allow-Methods") === "GET, OPTIONS",
  );
  assert(
    (await handler(new Request("https://example.com/register/private")))
      .status === 404,
  );
  assert(Number(connected) === 0);
  const response = await handler(new Request("https://example.com/register/"));
  assert(response.status === 200);
  assert(response.headers.get("Access-Control-Allow-Origin") === "*");
  assert((await response.json()).entries.length === 1);
  assert(connected === 1 && closed === 1);
});

Deno.test("register errors report safe code and stage, never messages or saved data", async () => {
  const secret = fixture.applicant.name;
  for (
    const scenario of [
      { stage: "connect", error: new TypeError(secret), code: "TypeError" },
      {
        stage: "list",
        error: Object.assign(new Error(secret), {
          code: "42501",
          data: fixture,
        }),
        code: "42501",
      },
      {
        stage: "list",
        error: Object.assign(new Error(secret), { code: "CONNECTION_CLOSED" }),
        code: "Error",
      },
      { stage: "list", error: null, code: "Error" },
      { stage: "build", error: undefined, code: "Error" },
    ]
  ) {
    let closed = false;
    const handler = createHandler(() => {
      if (scenario.stage === "connect") throw scenario.error;
      return {
        unsafe() {
          if (scenario.stage === "list") throw scenario.error;
          return Promise.resolve([{ ...row(1), decision: secret }]);
        },
        end() {
          closed = true;
          return Promise.resolve();
        },
      };
    });
    const response = await handler(new Request("https://example.com/register"));
    assert(response.status === 500);
    assert(
      await response.text() === JSON.stringify({
        error: "internal server error",
        code: scenario.code,
        stage: scenario.stage,
      }),
    );
    assert(closed === (scenario.stage !== "connect"));
  }
});
