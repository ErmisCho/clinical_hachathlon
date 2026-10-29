import { parseRequest } from "./parser.ts";
import { validatePlan } from "./plan.ts";
import U01 from "../../fixtures/unseen/U01.json" with { type: "json" };
import U02 from "../../fixtures/unseen/U02.json" with { type: "json" };

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

for (
  const { request, unit, dimension, filters } of [
    {
      request: U01,
      unit: "encounter",
      dimension: "region",
      filters: [{
        type: "encounter_filter",
        encounter_type: "inpatient",
        start_year: 2025,
        primary_icd10_prefix: "J18",
      }],
    },
    {
      request: U02,
      unit: "patient",
      dimension: "data_holder",
      filters: [
        { type: "age", min_age: 18 },
        { type: "has_condition", icd10_prefixes: ["E11"] },
      ],
    },
  ]
) {
  Deno.test(`${request.id}: unseen request has the expected validated plan`, () => {
    const result = parseRequest(request);
    assert(result.ok, JSON.stringify(result));
    const plan = result.plan;
    assert(validatePlan(plan).ok, "Plan is invalid");
    assert(plan.request_id === request.id, "Wrong request ID");
    assert(plan.count_unit === unit, "Wrong counting unit");
    assert(
      JSON.stringify(plan.dimensions) === JSON.stringify([{ by: dimension }]),
      "Wrong grouping dimension",
    );
    // Compare object fields independently of parser insertion order.
    assert(plan.cohort_filters.length === filters.length, "Wrong filter count");
    for (const expected of filters) {
      const actual = plan.cohort_filters.find((f) => f.type === expected.type);
      assert(actual !== undefined, `Missing ${expected.type} filter`);
      assert(
        Object.keys(actual).length === Object.keys(expected).length &&
          Object.entries(expected).every(([key, value]) =>
            JSON.stringify(
              (actual as unknown as Record<string, unknown>)[key],
            ) ===
              JSON.stringify(value)
          ),
        `Wrong filter: ${JSON.stringify(actual)}`,
      );
    }
    assert(
      plan.metrics.length === 1 && plan.metrics[0].type === "count" &&
        !plan.metrics[0].filters?.length,
      "Expected a single unfiltered count metric",
    );
    assert(!plan.spe_record_types, "Statistics must not deliver records");
  });
}
