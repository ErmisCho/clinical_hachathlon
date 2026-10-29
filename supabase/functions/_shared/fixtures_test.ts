/**
 * Fixture tests: every supabase/fixtures/plans/R0N.json file must
 *   1. validate with validatePlan(), and
 *   2. deep-equal the matching plan exported from plan_examples.ts.
 *
 * Uses static JSON imports (no --allow-read needed, no network required).
 * Same local-assert style as patients_test.ts.
 */
import { validatePlan } from "./plan.ts";
import { R01, R02, R03, R04, R05, R06, R07, R08, R09, R10 } from "./plan_examples.ts";
import type { QueryPlan } from "./plan.ts";

import fixtureR01 from "../../fixtures/plans/R01.json" with { type: "json" };
import fixtureR02 from "../../fixtures/plans/R02.json" with { type: "json" };
import fixtureR03 from "../../fixtures/plans/R03.json" with { type: "json" };
import fixtureR04 from "../../fixtures/plans/R04.json" with { type: "json" };
import fixtureR05 from "../../fixtures/plans/R05.json" with { type: "json" };
import fixtureR06 from "../../fixtures/plans/R06.json" with { type: "json" };
import fixtureR07 from "../../fixtures/plans/R07.json" with { type: "json" };
import fixtureR08 from "../../fixtures/plans/R08.json" with { type: "json" };
import fixtureR09 from "../../fixtures/plans/R09.json" with { type: "json" };
import fixtureR10 from "../../fixtures/plans/R10.json" with { type: "json" };

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Deep-equality check (JSON round-trip safe). */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const FIXTURE_CASES: Array<{ fixture: unknown; expected: QueryPlan }> = [
  { fixture: fixtureR01, expected: R01 },
  { fixture: fixtureR02, expected: R02 },
  { fixture: fixtureR03, expected: R03 },
  { fixture: fixtureR04, expected: R04 },
  { fixture: fixtureR05, expected: R05 },
  { fixture: fixtureR06, expected: R06 },
  { fixture: fixtureR07, expected: R07 },
  { fixture: fixtureR08, expected: R08 },
  { fixture: fixtureR09, expected: R09 },
  { fixture: fixtureR10, expected: R10 },
];

for (const { fixture, expected } of FIXTURE_CASES) {
  const id = expected.request_id;

  Deno.test(`fixture ${id}.json validates with validatePlan`, () => {
    const result = validatePlan(fixture);
    if (!result.ok) {
      const msgs = result.errors.map((e) => `${e.path}: ${e.message}`).join("\n");
      throw new Error(`${id}.json failed validation:\n${msgs}`);
    }
  });

  Deno.test(`fixture ${id}.json equals plan_examples.ts ${id}`, () => {
    assert(
      deepEqual(fixture, expected),
      `${id}.json does not match ${id} in plan_examples.ts.\n` +
        `  fixture:  ${JSON.stringify(fixture)}\n` +
        `  expected: ${JSON.stringify(expected)}`,
    );
  });
}
