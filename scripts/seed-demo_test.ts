import {
  buildDemo,
  CLEAN_SCHEMA_PATTERN,
  CURATED_IDS,
  isDemoId,
  quoteIdentifier,
} from "./seed-demo.ts";
import { organisationType } from "../supabase/functions/register/handler.ts";
import { decide } from "../supabase/functions/_shared/decision.ts";
import { parseRequest } from "../supabase/functions/_shared/parser.ts";
import { validateRequest } from "../supabase/functions/_shared/request_validation.ts";
import type { HealthDataRequest } from "../supabase/functions/_shared/decision.ts";

function assert(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("cleanup targets only the reserved prefix and exact grading prefixes", () => {
  for (
    const id of [
      "Q34_x",
      "Q34abc9_x",
      "T49_x",
      "P43_x",
      "H47_x",
      "UI47_x",
      "L45_x",
      "M45_x",
      "N45_x",
      "D_J21",
      "D_WAIT1",
      ...CURATED_IDS,
    ]
  ) {
    assert(isDemoId(id), `Missed test id ${id}`);
  }
  for (
    const id of [
      "R01",
      "R10",
      "J21",
      "Q34",
      "Q34-no_x",
      "XQ34_x",
      "q34_x",
      "Dolphin",
      "D-other",
      "REAL_1",
      "AT20260411",
      "AT20260425",
      "AT202604120",
      "XAT20260412",
      "",
    ]
  ) {
    assert(!isDemoId(id), `Would remove protected id ${id}`);
  }
  assert(
    quoteIdentifier('spe_q34_a"b') === '"spe_q34_a""b"',
    "DDL identifiers must be escaped",
  );
  for (const id of CURATED_IDS) {
    assert(
      new RegExp(CLEAN_SCHEMA_PATTERN).test(`spe_${id.toLowerCase()}`),
      `Missed SPE for ${id}`,
    );
  }
  for (
    const name of ["spe_r01", "spe_at20260411", "spe_at202604120", "spe_real_1"]
  ) {
    assert(
      !new RegExp(CLEAN_SCHEMA_PATTERN).test(name),
      `Would drop protected SPE ${name}`,
    );
  }
});

Deno.test("curated portfolio has eight decisions, three persistent holds and two resolvable holds", async () => {
  const load = async (id: string): Promise<HealthDataRequest> =>
    JSON.parse(
      await Deno.readTextFile(
        new URL(`../supabase/fixtures/jury/${id}.json`, import.meta.url),
      ),
    );
  const source = await load("J37");
  const before = JSON.stringify(source);
  const now = new Date("2026-10-30T12:00:00Z");
  // A shared input also verifies that buildDemo never mutates reference fixtures.
  const entries = await buildDemo(async () => source, load, now);
  assert(
    entries.length === 23,
    "Expected 10 reference + 8 decided + 3 held + 2 reviewed",
  );
  assert(
    new Set(entries.map((e) => e.request.id)).size === 23,
    "IDs must be unique",
  );
  assert(JSON.stringify(source) === before, "Reference fixture was mutated");
  assert(
    entries.slice(10).every((e, i) => e.request.id === CURATED_IDS[i]),
    "Use the fixed reference list",
  );
  const expectedTypes = [
    "Public body",
    "Insurer",
    "Research institution",
    "Company",
    "Company",
    "Company",
    "Public body",
    "Research institution",
    "Research institution",
    "Company",
    "Healthcare provider",
    "Public body",
    "Insurer",
    "Public body",
    "Company",
    "Research institution",
    "Healthcare provider",
    "Research institution",
    "Public body",
    "Research institution",
    "Company",
    "Public body",
    "Company",
  ];
  entries.forEach((e, i) => {
    const applicant = e.request.applicant as { organisation: string };
    assert(
      organisationType(applicant.organisation) === expectedTypes[i],
      `Wrong organisation category for ${e.request.id}`,
    );
    assert(
      !/demo|jury|test/i.test(applicant.organisation),
      "Applicants must not carry sample labels",
    );
    if (e.review) {
      assert(
        !/demo|jury|test/i.test(e.review.staff_name),
        "Staff names must not carry sample labels",
      );
    }
  });
  const dates = entries.map((e) => Date.parse(e.request.submitted));
  assert(
    Math.max(...dates) <= now.getTime() &&
      Math.min(...dates) >= now.getTime() - 21 * 86400000,
    "Dates must stay within the past three weeks",
  );
  assert(
    new Set(dates.map((t) => new Date(t).toISOString().slice(0, 10))).size >=
      20,
    "Dates should span the period",
  );
  for (const entry of entries) {
    assert(
      validateRequest(entry.request).length === 0,
      `Invalid API body: ${entry.request.id}`,
    );
    assert(
      JSON.stringify(entry.request.applicant) !==
        JSON.stringify(source.applicant),
      "Fixture identity survived",
    );
    if (entry.expected) {
      const decision = decide(entry.request);
      assert(
        decision.decision === entry.expected && !decision.needs_review,
        `Wrong decision for ${entry.request.id}`,
      );
      if (entry.expected !== "REJECT") {
        assert(
          parseRequest(entry.request).ok,
          `Unsupported curated definition: ${entry.request.id}`,
        );
      }
    }
    if (entry.held) {
      const decision = decide(entry.request);
      assert(
        decision.needs_review && decision.decision !== "REJECT",
        `Purpose must be held: ${entry.request.id}`,
      );
      assert(
        parseRequest(entry.request).ok,
        "Staff must be able to resolve purpose without parse errors",
      );
    }
  }
  assert(
    entries.filter((e) => e.held && !e.review).length === 3,
    "Must keep three queue items",
  );
  assert(
    entries.filter((e) => e.review?.reason.trim()).length === 2,
    "Must have two written staff reasons",
  );
  assert(
    entries.slice(0, 10).every((e, i) =>
      e.request.id === `R${String(i + 1).padStart(2, "0")}` &&
      e.request.purpose === source.purpose
    ),
    "Reference semantics/IDs must survive",
  );
});
