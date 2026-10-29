import {
  applySmallCell,
  buildQueries,
  roundHalfUp,
  runPlan,
  type SqlClient,
} from "./engine.ts";
import type { QueryPlan } from "./plan.ts";
import { R01, R03, R05, R07, R08, R09, R10 } from "./plan_examples.ts";

function assert(ok: boolean, message = "Assertion failed"): asserts ok {
  if (!ok) throw new Error(message);
}
function equal(actual: unknown, expected: unknown): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
  );
}
function mock(responses: Record<string, unknown>[][]): SqlClient {
  return {
    unsafe() {
      const rows = responses.shift();
      assert(rows !== undefined, "Unexpected SQL call");
      return Promise.resolve(rows);
    },
  };
}
const simple: QueryPlan = {
  request_id: "test",
  cohort_filters: [],
  count_unit: "patient",
  metrics: [{ type: "count", label: "patients" }],
};

Deno.test("single output filter handles zero, boundaries, and independent suppression", () => {
  for (const n of [0, 1, 9]) {
    equal(applySmallCell({ type: "count", n }), "<10");
    equal(
      applySmallCell({ type: "percentage", n, denominator: 100 }),
      "suppressed",
    );
    equal(
      applySmallCell({ type: "percentage", n: 10, denominator: n }),
      "suppressed",
    );
    equal(
      applySmallCell({ type: "mean_observation", n, total: "250" }),
      "suppressed",
    );
  }
  equal(applySmallCell({ type: "count", n: 10 }), 10);
  equal(applySmallCell({ type: "percentage", n: 10, denominator: 32 }), 31.3);
  equal(
    applySmallCell({ type: "mean_observation", n: 10, total: "22.5" }),
    2.3,
  );
  equal(
    applySmallCell({ type: "mean_observation", n: 10, total: null }),
    "suppressed",
  );
});

Deno.test("decimal half-up rounding is exact, including decimal strings and exponents", () => {
  for (
    const [input, expected] of [
      [0.05, 0.1],
      [2.25, 2.3],
      [8.34, 8.3],
      [1.005, 1],
      [-2.25, -2.3],
      [5e-2, 0.1],
    ] as const
  ) equal(roundHalfUp(input), expected);
  equal(roundHalfUp("2.249999999999999999999"), 2.2);
  equal(roundHalfUp("2.250000000000000000001"), 2.3);
  equal(
    applySmallCell({
      type: "percentage",
      n: "1000000000000000001",
      denominator: "4000000000000000000",
    }),
    25,
  );
});

Deno.test("empty region/age cross-tabs contain every metric with disclosure applied", async () => {
  const plan: QueryPlan = {
    ...simple,
    dimensions: [{ by: "region" }, {
      by: "age_band",
      bands: [{ label: "young", min_age: 0, max_age: 49 }, {
        label: "old",
        min_age: 50,
      }],
    }],
    metrics: [
      { type: "count", label: "patients" },
      {
        type: "percentage",
        label: "share",
        numerator_filters: [],
        denominator_label: "patients",
      },
      {
        type: "mean_observation",
        label: "mean",
        loinc: "test",
        use_latest: true,
      },
    ],
  };
  const answer = await runPlan(
    plan,
    mock([[{ value: "A" }, { value: "B" }], [{ g0: "A", g1: "old", n: "10" }], [
      { g0: "A", g1: "old", n: "10" },
    ], [{ g0: "A", g1: "old", n: "10", total: "22.5" }]]),
  );
  const empty = { patients: "<10", share: "suppressed", mean: "suppressed" };
  equal(answer, {
    A: { young: empty, old: { patients: 10, share: 100, mean: 2.3 } },
    B: { young: empty, old: empty },
  });
});

Deno.test("age groups survive an entirely empty eligible population", async () => {
  equal(
    await runPlan({
      ...simple,
      dimensions: [{ by: "age_band", bands: [{ label: "all", min_age: 0 }] }],
    }, mock([[]])),
    { all: { patients: "<10" } },
  );
});

Deno.test("SPE cohort and legacy R07 shapes match the published contracts", async () => {
  equal(await runPlan(R05, mock([[{ n: "1152" }]])), { cohort_size: 1152 });
  equal(
    await runPlan(
      R07,
      mock([[{ value: "A" }, { value: "B" }], [{ g0: "A", n: "28" }]]),
    ),
    { A: 28, B: "<10" },
  );
});

Deno.test("label percentages use raw counts regardless of metric order", async () => {
  const plan: QueryPlan = {
    ...simple,
    metrics: [
      {
        type: "percentage",
        label: "pct",
        numerator_label: "subset",
        denominator_label: "base",
      },
      {
        type: "count",
        label: "subset",
        filters: [{ type: "sex", value: "female" }],
      },
      { type: "count", label: "base" },
    ],
  };
  equal(await runPlan(plan, mock([[{ n: "10" }], [{ n: "32" }]])), {
    pct: 31.3,
    subset: 10,
    base: 32,
  });
});

Deno.test("SQL binds codes, ages, dates, regions, sex, labels and hostile values", () => {
  const attack = "x'); DROP TABLE patients; --_%";
  const plan: QueryPlan = {
    ...simple,
    request_id: attack,
    cohort_filters: [
      { type: "age", min_age: 37, max_age: 93 },
      { type: "sex", value: "female" },
      { type: "region", value: attack },
      { type: "has_condition", icd10_prefixes: ["E11", "I10"] },
      {
        type: "has_medication",
        atc_prefixes: ["B01AA", "B01AF"],
        active_on_ref_date: true,
        negate: true,
      },
      { type: "has_observation", loinc: "4548-4" },
      {
        type: "encounter_filter",
        encounter_type: "inpatient",
        start_year: 2024,
        primary_icd10_prefix: "J44",
      },
    ],
    dimensions: [{
      by: "age_band",
      bands: [{ label: attack, min_age: 37, max_age: 93 }],
    }],
    metrics: [{
      type: "mean_observation",
      label: attack,
      loinc: "39156-5",
      use_latest: true,
    }],
  };
  const q = buildQueries(plan).metrics[0]!;
  for (
    const value of [
      attack,
      "female",
      "E11",
      "I10",
      "B01AA",
      "B01AF",
      "4548-4",
      "inpatient",
      "J44",
      "39156-5",
      "2025-12-31",
    ]
  ) {
    assert(q.params.includes(value), `Missing bound value: ${value}`);
    assert(!q.text.includes(value), `Literal value in SQL: ${value}`);
  }
  for (const n of [37, 93, 2024, 2025]) assert(q.params.includes(n));
  const placeholders = [...q.text.matchAll(/\$(\d+)/g)].map((m) =>
    Number(m[1])
  );
  equal(
    [...new Set(placeholders)].sort((a, b) => a - b),
    q.params.map((_, i) => i + 1),
  );
  assert(q.text.includes("NOT EXISTS"));
  assert(
    q.text.includes("m.start_date <=") && q.text.includes("m.end_date >="),
  );
  assert(q.text.includes("ORDER BY o.date DESC NULLS LAST LIMIT 1"));
  assert(!q.text.includes("LIKE"));
});

Deno.test("inline percentage numerator includes denominator metric filters", () => {
  const plan: QueryPlan = {
    ...simple,
    metrics: [
      {
        type: "count",
        label: "base",
        filters: [{ type: "region", value: "denominator-region" }],
      },
      {
        type: "percentage",
        label: "pct",
        denominator_label: "base",
        numerator_filters: [{ type: "has_condition", icd10_prefixes: ["E11"] }],
      },
    ],
  };
  const q = buildQueries(plan).metrics[1]!;
  assert(q.params.includes("denominator-region") && q.params.includes("E11"));
});

Deno.test("every fixture compiles from eligible patients; encounters use their own holder and primary diagnosis", () => {
  for (const plan of [R01, R03, R05, R07, R08, R09, R10]) {
    const built = buildQueries(plan);
    for (const q of [...built.groups, ...built.metrics]) {
      if (q) {
        assert(q.text.includes("FROM public.eligible_patients AS p"));
        assert(!q.text.includes("FROM public.patients"));
      }
    }
  }
  const plan: QueryPlan = {
    ...simple,
    count_unit: "encounter",
    dimensions: [{ by: "data_holder" }],
    cohort_filters: [{
      type: "encounter_filter",
      primary_icd10_prefix: "J44",
      start_year: 2025,
    }],
  };
  const built = buildQueries(plan);
  assert(built.groups[0]!.text.includes("p.data_holder"));
  assert(!built.groups[0]!.text.includes("JOIN public.encounters"));
  assert(built.metrics[0]!.text.includes("e.data_holder AS g0"));
  const regions = buildQueries({ ...plan, dimensions: [{ by: "region" }] });
  assert(!regions.groups[0]!.text.includes("JOIN public.encounters"));
  assert(built.metrics[0]!.text.includes("e.primary_icd10"));
  assert(built.metrics[0]!.text.includes("count(DISTINCT e.encounter_id)"));
  assert(!built.metrics[0]!.text.includes("public.conditions"));
  assert(
    buildQueries({ ...plan, count_unit: "patient" }).groups[0]!.text.includes(
      "p.data_holder",
    ),
  );
});

Deno.test("invalid identifiers and unresolved count references are rejected before execution", () => {
  for (
    const plan of [
      { ...simple, dimensions: [{ by: "region; DROP TABLE patients" }] },
      {
        ...simple,
        metrics: [{
          type: "percentage",
          label: "bad",
          denominator_label: "missing",
          numerator_filters: [],
        }],
      },
      { ...simple, metrics: [simple.metrics[0], simple.metrics[0]] },
    ]
  ) {
    let threw = false;
    try {
      buildQueries(plan as QueryPlan);
    } catch {
      threw = true;
    }
    assert(threw);
  }
});
