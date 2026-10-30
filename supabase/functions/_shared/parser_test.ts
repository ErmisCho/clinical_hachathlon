import { parseRequest } from "./parser.ts";
import { REQUEST_FIXTURES } from "./parser_fixtures.ts";
import {
  ALL_EXAMPLES,
  EX_GROUP_DATA_HOLDER,
  EX_INPATIENT_ICD10,
  R01,
  R02,
  R03,
  R04,
  R05,
  R06,
  R07,
  R08,
  R09,
  R10,
} from "./plan_examples.ts";
import { validatePlan } from "./plan.ts";
import type { QueryPlan } from "./plan.ts";
import U01 from "../../fixtures/unseen/U01.json" with { type: "json" };
import U02 from "../../fixtures/unseen/U02.json" with { type: "json" };

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Labels are arbitrary, but percentage references must resolve to the same count.
// AND-filter order and metric order have no meaning; dimension order does.
function equivalentShape(plan: QueryPlan): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map((
          [k, v],
        ) => [k, canonical(v)]),
      );
    }
    return value;
  };
  const filters = (list: unknown[] = []) =>
    list.map((f) => JSON.stringify(canonical(f))).sort();
  const withoutLabel = <T extends { label: string }>(value: T) => {
    const { label: _label, ...fields } = value;
    return fields;
  };
  const counts = new Map(
    plan.metrics.filter((m) => m.type === "count").map((m) => [
      m.label,
      { ...withoutLabel(m), filters: filters(m.filters) },
    ]),
  );
  const metrics = plan.metrics.map((m) => {
    if (m.type === "count") {
      return { ...withoutLabel(m), filters: filters(m.filters) };
    }
    if (m.type === "percentage") {
      const {
        numerator_label,
        numerator_filters,
        denominator_label,
        ...fields
      } = withoutLabel(m);
      assert(
        counts.has(denominator_label),
        "Unresolved percentage denominator",
      );
      if (numerator_label) {
        assert(counts.has(numerator_label), "Unresolved percentage numerator");
      }
      return {
        ...fields,
        denominator: counts.get(denominator_label),
        numerator: numerator_label
          ? counts.get(numerator_label)
          : { type: "count", filters: filters(numerator_filters) },
      };
    }
    return withoutLabel(m);
  }).map((m) => JSON.stringify(canonical(m))).sort();
  return JSON.stringify(canonical({
    // Preserve all fields by default, including fields added to QueryPlan later.
    ...plan,
    cohort_filters: filters(plan.cohort_filters),
    dimensions: plan.dimensions?.map((d) =>
      d.by === "age_band"
        ? {
          ...d,
          bands: d.bands.map(withoutLabel),
        }
        : d
    ),
    metrics,
    spe_record_types: plan.spe_record_types?.slice().sort(),
    spe_observation_loincs: plan.spe_observation_loincs?.slice().sort(),
  }));
}

for (const [index, request] of REQUEST_FIXTURES.entries()) {
  Deno.test(`${request.id}: deterministic validated plan equivalent to example`, () => {
    const result = parseRequest(request);
    assert(result.ok, JSON.stringify(result));
    assert(validatePlan(result.plan).ok, "Generated plan did not validate");
    assert(
      equivalentShape(result.plan) === equivalentShape(ALL_EXAMPLES[index]),
      `Plan differs: ${JSON.stringify(result.plan)}`,
    );
    assert(
      JSON.stringify(result) === JSON.stringify(parseRequest(request)),
      "Parsing was not deterministic",
    );
    const renamed = parseRequest({ ...request, id: "arbitrary-id" });
    assert(renamed.ok, JSON.stringify(renamed));
    assert(
      equivalentShape({ ...renamed.plan, request_id: request.id }) ===
        equivalentShape(result.plan),
      "Parser depends on request ID",
    );
  });
}

for (const group of ["hospital", "data holder", "data_holder"]) {
  Deno.test(`group by ${group}`, () => {
    const result = parseRequest({
      id: EX_GROUP_DATA_HOLDER.request_id,
      definitions: [
        "Adult = aged 18 or older on 31 December 2025.",
        "Type 2 diabetes = any condition with an ICD-10 code starting with E11.",
        `Report per ${group}: adults with type 2 diabetes.`,
      ],
    });
    assert(result.ok, JSON.stringify(result));
    assert(
      equivalentShape(result.plan) === equivalentShape(EX_GROUP_DATA_HOLDER),
      "Incorrect hospital grouping",
    );
  });
}

Deno.test("primary_icd10 filters encounters rather than patient conditions", () => {
  const result = parseRequest({
    id: EX_INPATIENT_ICD10.request_id,
    definitions: [
      "Inpatient stay = encounter with type 'inpatient'.",
      "Main diagnosis (primary_icd10) starting with J44.",
      "Report per region: inpatient stays.",
    ],
  });
  assert(result.ok, JSON.stringify(result));
  assert(
    equivalentShape(result.plan) === equivalentShape(EX_INPATIENT_ICD10),
    "Incorrect primary diagnosis filter",
  );
});

Deno.test("all unreadable definitions are named, including trailing unsupported constraints", () => {
  const unsupported = [
    "Only patients with consent from last week.",
    "Use a neural network to pick the cohort.",
    "COPD = any condition with an ICD-10 code starting with J44 and onset after 2020.",
  ];
  const result = parseRequest({
    ...REQUEST_FIXTURES[0],
    definitions: [...REQUEST_FIXTURES[0].definitions, ...unsupported],
  });
  assert(!result.ok, "Must reject unknown definitions");
  for (const definition of unsupported) {
    assert(
      result.errors.some((e) =>
        e.definition === definition && e.reason.length > 0
      ),
      `Missing error: ${definition}`,
    );
  }
});

Deno.test("invalid input and unsupported report language fail clearly", () => {
  for (
    const request of [null, {}, { id: "test", definitions: [42] }, {
      id: "test",
      definitions: ["Report per region: median weight."],
    }, {
      id: "test",
      definitions: [
        "Age bands on 31 December 2025: 20-10.",
        "Report per band: patients.",
      ],
    }, {
      id: "test",
      definitions: [
        "Drug = ATC code starting with A10BK.",
        "Report per region: patients with an active Drug.",
      ],
    }]
  ) {
    const result = parseRequest(request);
    assert(
      !result.ok && result.errors.length > 0,
      `Expected failure: ${JSON.stringify(request)}`,
    );
  }
});

Deno.test("codes and concept names are derived from definitions", () => {
  const result = parseRequest({
    id: "new",
    definitions: [
      "Example disease = any condition with an ICD-10 code starting with Z99.",
      "Report per region: patients with example disease.",
    ],
  });
  assert(result.ok, JSON.stringify(result));
  assert(
    JSON.stringify(result.plan.cohort_filters) ===
      JSON.stringify([{ type: "has_condition", icd10_prefixes: ["Z99"] }]),
    "Code was not extracted",
  );
});

Deno.test("definitions may be reordered without changing the plan", () => {
  for (const request of REQUEST_FIXTURES) {
    const snapshot = JSON.stringify(request);
    const original = parseRequest(request);
    const reordered = parseRequest({
      ...request,
      definitions: request.definitions.slice().reverse(),
    });
    assert(original.ok && reordered.ok, JSON.stringify(reordered));
    assert(
      equivalentShape(original.plan) === equivalentShape(reordered.plan),
      "Definition order changed meaning",
    );
    assert(JSON.stringify(request) === snapshot, "Parser mutated the request");
  }
});

Deno.test("undefined populations and unsupported measurement constraints are rejected", () => {
  for (
    const definitions of [
      ["Report per region: adults."],
      ["Report per region: women."],
      ["Report per region: inpatient stays."],
      [
        "Use the latest weight (LOINC 29463-7) per patient; patients without a BMI are left out.",
        "Report per region: patients and mean weight, one decimal.",
      ],
      [
        "Adult = aged 18 or older on 31 December 2024.",
        "Report per region: adults.",
      ],
      [
        "Age bands on 31 December 2025: 65-74, 70+.",
        "Report per band: patients.",
      ],
    ]
  ) {
    const result = parseRequest({ id: "unsupported", definitions });
    assert(
      !result.ok,
      `Expected a clear error: ${JSON.stringify(definitions)}`,
    );
  }
});

for (
  const group of [
    "hospital (data_holder)",
    "hospitals",
    "hospitals (data_holder)",
    "data holder (data_holder)",
    "data holders",
    "data_holder (data_holder)",
    "data_holders",
    "Klinikum",
    "Klinikum (data_holder)",
    "Kliniken (data_holder)",
    "Klinika",
  ]
) {
  Deno.test(`jury grouping variant: ${group}`, () => {
    const request = {
      id: EX_GROUP_DATA_HOLDER.request_id,
      definitions: [
        "Adult = aged 18 or older on 31 December 2025.",
        "Type 2 diabetes = any condition with an ICD-10 code starting with E11.",
        `Report per ${group}: adults with type 2 diabetes.`,
      ],
    };
    const result = parseRequest(request);
    assert(result.ok, JSON.stringify(result));
    assert(validatePlan(result.plan).ok, "Variant did not validate");
    assert(
      equivalentShape(result.plan) === equivalentShape(EX_GROUP_DATA_HOLDER),
      "Grouping variant changed plan semantics",
    );
    assert(
      JSON.stringify(result) === JSON.stringify(parseRequest(request)),
      "Variant is not deterministic",
    );
  });
}

const diagnosisVariants = [
  "Count stays (not patients) whose start_date is in 2025 and whose main diagnosis (primary_icd10) starts with J18.",
  "Count stay (not patient) whose start_date is in 2025 and whose main diagnosis beginning with J18.",
  "Count encounters (not patients) whose main diagnoses (primary_icd10) that start with J18 and whose start_date is in 2025.",
  "Count inpatient stays whose start_date is in 2025 and whose primary diagnosis starting with J18.",
  "Count stays whose start_date is in 2025 and whose primary_icd10 starts with J18.",
];
for (const definition of diagnosisVariants) {
  Deno.test(`jury combined diagnosis variant: ${definition}`, () => {
    const request = {
      id: "jury-diagnosis",
      definitions: [
        "Inpatient stays = encounters with type 'inpatient'.",
        definition,
        "Report per hospital (data_holder): inpatient stay.",
      ],
    };
    const expected: QueryPlan = {
      request_id: request.id,
      cohort_filters: [{
        type: "encounter_filter",
        encounter_type: "inpatient",
        start_year: 2025,
        primary_icd10_prefix: "J18",
      }],
      count_unit: "encounter",
      dimensions: [{ by: "data_holder" }],
      metrics: [{ type: "count", label: "stays" }],
    };
    const result = parseRequest(request);
    assert(result.ok, JSON.stringify(result));
    assert(validatePlan(result.plan).ok, "Combined variant did not validate");
    assert(
      equivalentShape(result.plan) === equivalentShape(expected),
      "Combined clauses lost a filter or changed the count unit",
    );
    assert(
      JSON.stringify(result) === JSON.stringify(parseRequest(request)),
      "Combined variant is not deterministic",
    );
    const reversed = parseRequest({
      ...request,
      definitions: request.definitions.slice().reverse(),
    });
    assert(
      reversed.ok &&
        equivalentShape(reversed.plan) === equivalentShape(expected),
      "Combined variant depends on definition order",
    );
  });
}

for (
  const verb of [
    "starting with",
    "starts with",
    "beginning with",
    "that start with",
  ]
) {
  for (const annotation of ["", " (primary_icd10)"]) {
    Deno.test(`standalone diagnosis: ${verb}${annotation}`, () => {
      const request = {
        id: EX_INPATIENT_ICD10.request_id,
        definitions: [
          "Inpatient stay = encounter with type 'inpatient'.",
          `Main diagnoses${annotation} ${verb} J44.`,
          "Report per region: inpatient stays.",
        ],
      };
      const result = parseRequest(request);
      assert(result.ok, JSON.stringify(result));
      assert(
        equivalentShape(result.plan) === equivalentShape(EX_INPATIENT_ICD10),
        "Standalone prefix variant changed semantics",
      );
    });
  }
  Deno.test(`condition and medication prefix predicate: ${verb}`, () => {
    const result = parseRequest({
      id: "prefix-variant",
      definitions: [
        `Example disease = any conditions with ICD-10 codes (icd10) ${verb} Z99.`,
        `Example therapy = ATC codes (atc) ${verb} A10BK or A10BA.`,
        "A medication is active on 31 December 2025 if start_date is on or before that day and end_date is empty or on or after that day.",
        "Report per Klinikum: patient with an active example therapy.",
      ],
    });
    assert(result.ok, JSON.stringify(result));
    assert(
      equivalentShape(result.plan) === equivalentShape({
        request_id: "prefix-variant",
        cohort_filters: [
          { type: "has_condition", icd10_prefixes: ["Z99"] },
          {
            type: "has_medication",
            atc_prefixes: ["A10BK", "A10BA"],
            active_on_ref_date: true,
          },
        ],
        count_unit: "patient",
        dimensions: [{ by: "data_holder" }],
        metrics: [{ type: "count", label: "patients" }],
      }),
      "Prefix variant failed to extract codes",
    );
  });
}

Deno.test("jury rules reject unknown annotations, extra clauses and contradictory constraints", () => {
  const unsupported = [
    "Count stays (not patients) whose start_date is in 2025 and whose main diagnosis starts with J18 and whose duration is over 5 days.",
    "Count stays whose start_date is in 2025 and whose main diagnosis (secondary_icd10) starts with J18.",
    "Count stays whose start_date is in 2025 and whose main diagnosis starts with J18 or J44.",
    "Count stays whose start_date is in 2025 and whose start_date is in 2024.",
    "Main diagnosis (primary_icd10) starts with J18 and only in winter.",
    "Report per hospital (region): patients.",
    "Report per Klinikum (unknown_column): patients.",
  ];
  const result = parseRequest({
    id: "unsupported-jury",
    definitions: [
      "Inpatient stay = encounter with type 'inpatient'.",
      ...unsupported,
      "Report per region: inpatient stays.",
    ],
  });
  assert(!result.ok, "Unsupported restrictions must not be ignored");
  for (const definition of unsupported) {
    assert(
      result.errors.some((e) => e.definition === definition),
      `Missing error for ${definition}`,
    );
  }
  const conflict = "Main diagnosis starts with J44.";
  const conflicting = parseRequest({
    id: "conflicting-jury",
    definitions: [
      "Inpatient stay = encounter with type 'inpatient'.",
      "Main diagnosis starts with J18.",
      conflict,
      "Report per region: inpatient stays.",
    ],
  });
  assert(
    !conflicting.ok &&
      conflicting.errors.some((e) => e.definition === conflict),
    "Conflicting diagnoses must not overwrite one another",
  );
});

for (
  const [item, expectedLoincs] of [
    ["HbA1c values", ["4548-4"]],
    ["BMI values", ["39156-5"]],
    ["systolic blood pressure values", ["8480-6"]],
    ["eGFR values", ["62238-1"]],
    ["eGFR (kidney function) values", ["62238-1"]],
    ["LOINC 8480-6", ["8480-6"]],
    ["LOINC code 62238-1 values", ["62238-1"]],
    ["BMI values (LOINC 39156-5)", ["39156-5"]],
    [
      "HbA1c values, BMI values, systolic blood pressure values and eGFR values",
      ["4548-4", "39156-5", "8480-6", "62238-1"],
    ],
    ["HbA1c values and LOINC 4548-4", ["4548-4"]],
  ] as const
) {
  Deno.test(`SPE copies only requested measurements: ${item}`, () => {
    // Keep an HbA1c cohort qualifier even when delivering another measurement:
    // delivery scope must come from the provide-list, not cohort membership.
    const request = {
      ...REQUEST_FIXTURES[4],
      question:
        `Provide pseudonymised conditions, medications and ${item} for adults with type 2 diabetes who have at least one HbA1c value.`,
    };
    const result = parseRequest(request);
    assert(result.ok, JSON.stringify(result));
    assert(validatePlan(result.plan).ok, "Scoped SPE failed validation");
    assert(
      JSON.stringify(result.plan.spe_observation_loincs) ===
        JSON.stringify(expectedLoincs),
      "Wrong observation delivery scope",
    );
    assert(
      JSON.stringify(result.plan.spe_record_types) ===
        JSON.stringify(["conditions", "medications", "observations"]),
      "Record tables must be deduplicated",
    );
    assert(
      JSON.stringify(result) === JSON.stringify(parseRequest(request)),
      "Measurement scoping must be deterministic",
    );
  });
}

Deno.test("SPE general observations stay unrestricted regardless of cohort measurements", () => {
  for (const provided of ["observations", "observations and BMI values"]) {
    const result = parseRequest({
      ...REQUEST_FIXTURES[4],
      question:
        `Provide pseudonymised conditions, medications and ${provided} for adults with type 2 diabetes who have at least one HbA1c value.`,
    });
    assert(result.ok, JSON.stringify(result));
    assert(
      result.plan.spe_record_types?.includes("observations") === true,
      "Observations table missing",
    );
    assert(
      !Object.hasOwn(result.plan, "spe_observation_loincs"),
      "General observations must leave the LOINC restriction absent",
    );
  }
});

Deno.test("SPE unrecognised or contradictory measurement names fail clearly", () => {
  for (const item of ["mystery values", "BMI values (LOINC 4548-4)"]) {
    const question =
      `Provide pseudonymised ${item} for adults with type 2 diabetes.`;
    const result = parseRequest({ ...REQUEST_FIXTURES[4], question });
    assert(
      !result.ok && result.errors.some((e) => e.definition.includes(item)),
      "Do not guess the scope of an unknown or contradictory measurement",
    );
  }
});

Deno.test("plan equivalence preserves SPE scope and future fields", () => {
  const baseline = ALL_EXAMPLES[4];
  const withoutScope = { ...baseline };
  delete withoutScope.spe_observation_loincs;
  for (
    const changed of [
      withoutScope,
      { ...baseline, spe_observation_loincs: ["39156-5"] },
      { ...baseline, spe_record_types: ["conditions"] as const },
      { ...baseline, future_plan_field: "must be compared" },
      {
        ...baseline,
        metrics: baseline.metrics.map((m) => ({
          ...m,
          future_metric_field: true,
        })),
      },
    ]
  ) {
    assert(
      equivalentShape(baseline) !== equivalentShape(changed as QueryPlan),
      "Equivalence ignored a plan field",
    );
  }
  const bandPlan = ALL_EXAMPLES[1];
  const changedBand = {
    ...bandPlan,
    dimensions: bandPlan.dimensions?.map((d) =>
      d.by === "age_band"
        ? {
          ...d,
          bands: d.bands.map((b) => ({ ...b, future_band_field: true })),
        }
        : d
    ),
  };
  assert(
    equivalentShape(bandPlan) !== equivalentShape(changedBand),
    "Equivalence ignored an age-band field",
  );
});

// ---------------------------------------------------------------------------
// Label-exactness tests (issue #32)
// ---------------------------------------------------------------------------

/** The metric labels produced by the parser must equal the plan_examples labels
 *  exactly for R01–R10 — these are the readable labels that applicants and the
 *  jury see in the API answer.
 */
const LABEL_FIXTURES: Array<
  {
    request: (typeof REQUEST_FIXTURES)[number];
    example: { metrics: Array<{ label: string }> };
    id: string;
  }
> = [
  { request: REQUEST_FIXTURES[0], example: R01, id: "R01" },
  { request: REQUEST_FIXTURES[1], example: R02, id: "R02" },
  { request: REQUEST_FIXTURES[2], example: R03, id: "R03" },
  { request: REQUEST_FIXTURES[3], example: R04, id: "R04" },
  { request: REQUEST_FIXTURES[4], example: R05, id: "R05" },
  { request: REQUEST_FIXTURES[5], example: R06, id: "R06" },
  { request: REQUEST_FIXTURES[6], example: R07, id: "R07" },
  { request: REQUEST_FIXTURES[7], example: R08, id: "R08" },
  { request: REQUEST_FIXTURES[8], example: R09, id: "R09" },
  { request: REQUEST_FIXTURES[9], example: R10, id: "R10" },
];

for (const { request, example, id } of LABEL_FIXTURES) {
  Deno.test(`${id}: metric labels match plan_examples exactly`, () => {
    const result = parseRequest(request);
    assert(result.ok, `Parse failed: ${JSON.stringify(result)}`);
    const parsedLabels = result.plan.metrics.map((m) => m.label);
    const expectedLabels = example.metrics.map((m) => m.label);
    assert(
      JSON.stringify(parsedLabels) === JSON.stringify(expectedLabels),
      `Label mismatch for ${id}: got ${JSON.stringify(parsedLabels)}, want ${
        JSON.stringify(expectedLabels)
      }`,
    );
  });
}

/** Labels for unseen requests must be readable snake_case identifiers, not the
 *  generic fallback words that the old parser produced.
 */
const GENERIC_LABELS = new Set([
  "cohort",
  "subset",
  "percentage",
  "mean",
  "without_medication",
  "medication_0",
  "medication_1",
  "medication_2",
]);

for (
  const { request, id } of [{ request: U01, id: "U01" }, {
    request: U02,
    id: "U02",
  }]
) {
  Deno.test(`${id}: metric labels are readable, not generic`, () => {
    const result = parseRequest(request);
    assert(result.ok, `Parse failed: ${JSON.stringify(result)}`);
    for (const metric of result.plan.metrics) {
      assert(
        !GENERIC_LABELS.has(metric.label),
        `Generic label "${metric.label}" in ${id} — must be a readable identifier`,
      );
      assert(
        /^[a-z][a-z0-9_]*$/.test(metric.label),
        `Label "${metric.label}" in ${id} is not valid snake_case`,
      );
    }
  });
}

Deno.test("encounter predicates cannot silently turn distinct patients into stay counts", () => {
  const result = parseRequest({
    id: "patient-visit-count",
    question: "Count distinct patients by hospital",
    definitions: [
      "Inpatient stay = encounter with type 'inpatient'.",
      "Count stays whose start_date is in 2025 and whose main diagnosis begins with S72.",
      "Report per hospital: patients.",
    ],
  });
  assert(
    !result.ok && result.errors.some((e) => e.reason.length > 0),
    "Ambiguous patient/stay counting must be flagged",
  );
});

Deno.test("prefix synonyms preserve code and full-clause consumption", () => {
  for (
    const verb of [
      "begins with",
      "begin with",
      "beginning with",
      "that starts with",
    ]
  ) {
    const request = {
      id: "prefix-synonym",
      question: "Count asthma by region",
      definitions: [
        `Asthma = any condition with an ICD-10 code ${verb} J45.`,
        "Report per region: patients with asthma.",
      ],
    };
    const result = parseRequest(request);
    assert(result.ok, JSON.stringify(result));
    assert(
      JSON.stringify(result.plan.cohort_filters) ===
        JSON.stringify([{ type: "has_condition", icd10_prefixes: ["J45"] }]),
      "Code prefix lost",
    );
    const modified = {
      ...request,
      definitions: [
        request.definitions[0].replace("J45.", "J45 and onset_date in 2025."),
        request.definitions[1],
      ],
    };
    assert(
      !parseRequest(modified).ok,
      "Unsupported suffix must never be silently ignored",
    );
  }
});

// ---------------------------------------------------------------------------
// New-wording variant tests (issue #84)
// ---------------------------------------------------------------------------

// --- No-op definitions ---
Deno.test("no-op: opt-out exclusion and reference-date restatements are silently accepted", () => {
  const result = parseRequest({
    id: "noop-test",
    definitions: [
      "Exclude patients who opted out of reuse.",
      "Use 31 December 2025 as the reference date; age is 2025 minus birth year.",
      "Asthma = any condition with an ICD-10 code starting with J45.",
      "Report per region: patients with asthma.",
    ],
  });
  assert(result.ok, JSON.stringify(result));
  assert(
    result.plan.cohort_filters.some((f) =>
      f.type === "has_condition" &&
      (f as { icd10_prefixes: string[] }).icd10_prefixes.includes("J45")
    ),
    "Condition filter must still be present after no-ops",
  );
});

// --- "X means a conditions.icd10 code beginning Y" ---
for (
  const [variant, code, conceptName] of [
    ["Hypertension means a conditions.icd10 code beginning I10.", "I10", "hypertension"],
    ["Type 2 diabetes means a condition code beginning E11.", "E11", "type 2 diabetes"],
    ["COPD means a condition ICD-10 code beginning J44.", "J44", "copd"],
    ["Stroke means conditions.icd10 beginning I63.", "I63", "stroke"],
    ["Breast cancer means conditions.icd10 beginning C50.", "C50", "breast cancer"],
  ] as const
) {
  Deno.test(`condition "means" variant: ${variant}`, () => {
    const result = parseRequest({
      id: "means-cond-test",
      definitions: [
        variant,
        `Report per region: patients with ${conceptName}.`,
      ],
    });
    assert(result.ok, JSON.stringify(result));
    assert(
      result.plan.cohort_filters.some((f) =>
        f.type === "has_condition" &&
        (f as { icd10_prefixes: string[] }).icd10_prefixes.includes(code)
      ),
      `Code ${code} missing from cohort_filters`,
    );
  });
}

// --- "X means conditions.icd10 beginning Y; adults are 18 or older" ---
for (
  const trailing of [
    "adults are 18 or older",
    "adults are 18",
    "adult means at least 18 years",
    "adults are 18 or older",
  ]
) {
  Deno.test(`combined condition+age trailing clause: ${trailing}`, () => {
    const result = parseRequest({
      id: "combined-cond-age",
      definitions: [
        `Hypertension means conditions.icd10 beginning I10; ${trailing}.`,
        "Metric: hypertension_adults.",
      ],
    });
    assert(result.ok, `${trailing}: ${JSON.stringify(result)}`);
    assert(
      result.plan.cohort_filters.some((f) => f.type === "age"),
      "Age filter must be derived from trailing clause",
    );
  });
}

// --- "X are prescriptions with ATC beginning Y" and "X means ATC beginning Y" ---
for (
  const [variant, code] of [
    ["ACE inhibitors are prescriptions with ATC beginning C09AA.", "C09AA"],
    ["SGLT2 inhibitor means ATC beginning A10BK.", "A10BK"],
  ] as const
) {
  Deno.test(`medication "means/are" variant: ${variant}`, () => {
    const result = parseRequest({
      id: "means-med-test",
      definitions: [
        variant,
        "A prescription is current if it started on or before 31 December 2025 and its end date is blank or on or after that date.",
        "Count distinct people of any age; metric: users.",
      ],
    });
    assert(result.ok, JSON.stringify(result));
    assert(
      result.plan.cohort_filters.some((f) =>
        f.type === "has_medication" &&
        (f as { atc_prefixes: string[] }).atc_prefixes.includes(code)
      ),
      `ATC code ${code} missing`,
    );
  });
}

// --- Alternate active-medication phrasing ---
Deno.test("alternate active-medication phrasing: A prescription is current if...", () => {
  const result = parseRequest({
    id: "alt-active-med",
    definitions: [
      "Statin = ATC code starting with C10AA.",
      "A prescription is current if it started on or before 31 December 2025 and its end date is blank or on or after that date.",
      "Report per region: patients with an active statin.",
    ],
  });
  assert(result.ok, JSON.stringify(result));
});

// --- Inline sex + age definition ---
Deno.test("inline 'Female sex; age N to M inclusive' definition", () => {
  const result = parseRequest({
    id: "sex-age-inline",
    definitions: [
      "Female sex; age 50 to 69 inclusive at the reference date.",
      "Breast cancer = any condition with an ICD-10 code starting with C50.",
      "Report per hospitals: patients with breast cancer.",
    ],
  });
  assert(result.ok, JSON.stringify(result));
  const filters = result.plan.cohort_filters;
  assert(
    filters.some((f) => f.type === "sex" && (f as { value: string }).value === "female"),
    "Sex filter missing",
  );
  assert(
    filters.some((f) =>
      f.type === "age" &&
      (f as { min_age: number }).min_age === 50 &&
      (f as { max_age?: number }).max_age === 69
    ),
    "Age filter 50-69 missing",
  );
});

// --- "Count each adult (N years or older) once; metric: label" ---
Deno.test("count each adult once; explicit metric label", () => {
  const result = parseRequest({
    id: "count-adult-once",
    definitions: [
      "Hypertension = any condition with an ICD-10 code starting with I10.",
      "Count each adult (18 years or older) once; metric: hypertension_adults.",
    ],
  });
  assert(result.ok, JSON.stringify(result));
  assert(
    result.plan.cohort_filters.some((f) => f.type === "age"),
    "Age filter must be added",
  );
  assert(result.plan.metrics[0].label === "hypertension_adults", "Wrong metric label");
  assert(!result.plan.dimensions, "Should be no dimensions");
});

// --- "Count distinct people of any age; metric: label" ---
Deno.test("count distinct people of any age; explicit metric", () => {
  const result = parseRequest({
    id: "count-people",
    definitions: [
      "ACE inhibitors = ATC code starting with C09AA.",
      "A medication is active on 31 December 2025 if start_date is on or before that day and end_date is empty or on or after that day.",
      "Count distinct people of any age; metric: current_ace_users.",
    ],
  });
  assert(result.ok, JSON.stringify(result));
  assert(result.plan.metrics[0].label === "current_ace_users", "Wrong metric label");
});

// --- "Group by patients.data_holder, ...; metric: label" ---
Deno.test("group by patients.data_holder with explicit metric", () => {
  const result = parseRequest({
    id: "group-holder",
    definitions: [
      "COPD = any condition with an ICD-10 code starting with J44.",
      "Adult = aged 18 or older on 31 December 2025.",
      "Group by patients.data_holder, include all hospitals, and count each adult once; metric: copd_adults.",
    ],
  });
  assert(result.ok, JSON.stringify(result));
  assert(result.plan.dimensions?.[0].by === "data_holder", "Wrong grouping");
  assert(result.plan.metrics[0].label === "copd_adults", "Wrong metric");
});

// --- "All ages, grouped by patients.data_holder; metric: label" ---
Deno.test("All ages, grouped by patients.data_holder; metric", () => {
  const result = parseRequest({
    id: "all-ages-grouped",
    definitions: [
      "Drug = ATC code starting with A10BK.",
      "A medication is active on 31 December 2025 if start_date is on or before that day and end_date is empty or on or after that day.",
      "All ages, grouped by patients.data_holder; metric: sglt2_users.",
    ],
  });
  assert(result.ok, JSON.stringify(result));
  assert(result.plan.dimensions?.[0].by === "data_holder", "Wrong grouping");
});

// --- "Inpatient encounters only, start date in calendar year YYYY" ---
Deno.test("Inpatient encounters only with calendar year", () => {
  const result = parseRequest({
    id: "inpatient-year",
    definitions: [
      "Inpatient encounters only, start date in calendar year 2023.",
      "Main diagnosis (primary_icd10) starting with J18.",
      "Count distinct encounter_id, not patients; no grouping. Metric: pneumonia_stays_2023.",
    ],
  });
  assert(result.ok, JSON.stringify(result));
  assert(result.plan.count_unit === "encounter", "Must count encounters");
  const ef = result.plan.cohort_filters.find((f) => f.type === "encounter_filter") as
    | { encounter_type: string; start_year: number; primary_icd10_prefix: string }
    | undefined;
  assert(ef?.encounter_type === "inpatient" && ef?.start_year === 2023, "Wrong encounter filter");
  assert(ef?.primary_icd10_prefix === "J18", "Wrong primary icd10 prefix");
});

// --- "Only inpatient stays starting in YYYY; encounters.primary_icd10 begins CODE" ---
Deno.test("Only inpatient stays starting in YYYY; encounters.primary_icd10 begins CODE", () => {
  for (
    const def of [
      "Only inpatient stays starting in 2024; encounters.primary_icd10 begins J44.",
      "Only inpatient encounters beginning in 2025; primary_icd10 begins I63.",
    ]
  ) {
    const result = parseRequest({
      id: "inpatient-inline",
      definitions: [
        def,
        "Metric: test_stays.",
      ],
    });
    assert(result.ok, `${def}: ${JSON.stringify(result)}`);
    assert(result.plan.count_unit === "encounter", "Must count encounters");
  }
});

// --- "X means encounters.primary_icd10 beginning CODE" ---
Deno.test("encounters.primary_icd10 beginning CODE", () => {
  const result = parseRequest({
    id: "enc-icd10",
    definitions: [
      "Inpatient stay = encounter with type 'inpatient'.",
      "Pneumonia means encounters.primary_icd10 beginning J18, regardless of conditions.csv.",
      "Count distinct encounter_id, not patients; no grouping. Metric: pneumonia_stays.",
    ],
  });
  assert(result.ok, JSON.stringify(result));
  const ef = result.plan.cohort_filters.find((f) => f.type === "encounter_filter") as
    | { primary_icd10_prefix: string }
    | undefined;
  assert(ef?.primary_icd10_prefix === "J18", "Wrong prefix");
});

// --- Grouped encounter count with separate "Count distinct encounters" and "Group by" ---
Deno.test("separate group-by and count-distinct-encounters definitions combine correctly", () => {
  const result = parseRequest({
    id: "group-enc",
    definitions: [
      "Only inpatient stays starting in 2024; encounters.primary_icd10 begins J44.",
      "Group by encounters.data_holder, not the patient's home region or record holder; include all three hospitals.",
      "Count distinct encounters; metric: copd_stays_2024.",
    ],
  });
  assert(result.ok, JSON.stringify(result));
  assert(result.plan.count_unit === "encounter", "Must count encounters");
  assert(result.plan.dimensions?.[0].by === "data_holder", "Wrong grouping");
  assert(result.plan.metrics[0].label === "copd_stays_2024", "Wrong metric");
});

// --- "Group by patients.region, ...; count encounters rather than distinct people" ---
Deno.test("group by region with encounter counting", () => {
  const result = parseRequest({
    id: "region-enc",
    definitions: [
      "Only inpatient encounters beginning in 2025; primary_icd10 begins I63.",
      "Group by patients.region, including every region; count encounters rather than distinct people.",
      "Metric: stroke_stays_2025.",
    ],
  });
  assert(result.ok, JSON.stringify(result));
  assert(result.plan.count_unit === "encounter", "Must count encounters");
  assert(result.plan.dimensions?.[0].by === "region", "Wrong grouping");
  assert(result.plan.metrics[0].label === "stroke_stays_2025", "Wrong metric");
});

// --- Standalone "Metric: label" with encounter filter ---
Deno.test("standalone Metric: with encounter filter", () => {
  const result = parseRequest({
    id: "metric-only",
    definitions: [
      "Only inpatient encounters beginning in 2025; primary_icd10 begins I63.",
      "Group by patients.region, including every region; count encounters rather than distinct people.",
      "Metric: stroke_stays_2025.",
    ],
  });
  assert(result.ok, JSON.stringify(result));
  assert(result.plan.metrics[0].label === "stroke_stays_2025", "Wrong metric");
});

// --- "No grouping; mean to one decimal. Metrics: A and B" ---
Deno.test("No grouping mean report with explicit metric pair labels", () => {
  const result = parseRequest({
    id: "no-group-mean",
    definitions: [
      "Stroke = any condition with an ICD-10 code starting with I63.",
      "Adult = aged 18 or older on 31 December 2025.",
      "Use the latest systolic blood pressure (LOINC 8480-6) per patient.",
      "No grouping; mean to one decimal. Metrics: systolic_measured and systolic_mean.",
    ],
  });
  assert(result.ok, JSON.stringify(result));
  assert(!result.plan.dimensions, "No dimensions expected");
  assert(result.plan.metrics[0].label === "systolic_measured", "Count label");
  assert(result.plan.metrics[1].label === "systolic_mean", "Mean label");
  assert(result.plan.metrics[1].type === "mean_observation", "Must be mean metric");
});

// --- "Overall results only, one decimal for the mean; metrics: A and B" ---
Deno.test("Overall results only mean report", () => {
  const result = parseRequest({
    id: "overall-mean",
    definitions: [
      "Type 2 diabetes = any condition with an ICD-10 code starting with E11.",
      "Adult = aged 18 or older on 31 December 2025.",
      "Use the latest HbA1c (LOINC 4548-4) per patient.",
      "Overall results only, one decimal for the mean; metrics: hba1c_measured and hba1c_mean.",
    ],
  });
  assert(result.ok, JSON.stringify(result));
  assert(result.plan.metrics[0].label === "hba1c_measured", "Count label");
  assert(result.plan.metrics[1].label === "hba1c_mean", "Mean label");
});

// --- New observation variants ---
Deno.test("Use the last observation on or before the reference date with LOINC Y", () => {
  const result = parseRequest({
    id: "last-obs",
    definitions: [
      "Type 2 diabetes = any condition with an ICD-10 code starting with E11.",
      "Adult = aged 18 or older on 31 December 2025.",
      "Use the last observation on or before the reference date with LOINC 4548-4; do not average all visits.",
      "Overall results only, one decimal for the mean; metrics: hba1c_measured and hba1c_mean.",
    ],
  });
  assert(result.ok, JSON.stringify(result));
  assert(result.plan.metrics.some((m) => m.type === "mean_observation"), "Mean observation must be present");
});

// --- SPE: "Cohort: adults aged at least N with conditions.icd10 beginning C and LOINC Y" ---
Deno.test("SPE cohort definition with conditions.icd10 and observation", () => {
  const result = parseRequest({
    id: "spe-cohort",
    definitions: [
      "Cohort: adults aged at least 18 with a conditions.icd10 code beginning I10 and at least one systolic blood pressure observation (LOINC 8480-6).",
      "Requested tables: conditions and observations, restricting observations to LOINC 8480-6; retain pseudonymous patient linkage only.",
    ],
    question: "We request linked diagnosis histories and repeated systolic blood pressure readings for the adult hypertension cohort.",
    requested_as: "health data access application",
    requested_format: "pseudonymised records",
    purpose: "Clinical research on within-person blood pressure trajectories.",
  });
  assert(result.ok, JSON.stringify(result));
  assert(result.plan.spe_record_types?.includes("conditions") === true, "conditions missing");
  assert(result.plan.spe_record_types?.includes("observations") === true, "observations missing");
  assert(
    result.plan.spe_observation_loincs?.includes("8480-6") === true,
    "LOINC restriction missing",
  );
  assert(
    result.plan.cohort_filters.some((f) => f.type === "age"),
    "Age filter missing",
  );
  assert(
    result.plan.cohort_filters.some((f) => f.type === "has_condition"),
    "Condition filter missing",
  );
});

// --- "If aggregate access suffices, report the single metric cohort_size" ---
Deno.test("aggregate downgrade: if aggregate access suffices report cohort_size", () => {
  const result = parseRequest({
    id: "downgrade",
    definitions: [
      "Cohort: adults aged at least 18 with a conditions.icd10 code beginning I10 and at least one systolic blood pressure observation (LOINC 8480-6).",
      "Requested tables: conditions and observations, restricting observations to LOINC 8480-6; retain pseudonymous patient linkage only.",
      "If aggregate access suffices, report the single metric cohort_size.",
    ],
    question: "Could we get individual diagnosis histories for the hypertension cohort?",
    requested_as: "health data access application",
    requested_format: "pseudonymised records",
    purpose: "Clinical research.",
  });
  assert(result.ok, JSON.stringify(result));
  assert(!result.plan.spe_record_types, "Should NOT be SPE when downgraded");
  assert(result.plan.metrics[0].label === "cohort_size", "Metric must be cohort_size");
});

// --- Verify new variants don't change existing supported phrasing ---
Deno.test("new variants do not alter existing standard phrasing plans", () => {
  // These fixtures must still parse identically after the grammar extension.
  const r1 = parseRequest({
    id: "old-style-condition",
    definitions: [
      "Asthma = any condition with an ICD-10 code starting with J45.",
      "Report per region: patients with asthma.",
    ],
  });
  assert(r1.ok, JSON.stringify(r1));
  const r2 = parseRequest({
    id: "new-style-condition",
    definitions: [
      "Asthma means a conditions.icd10 code beginning J45.",
      "Report per region: patients with asthma.",
    ],
  });
  assert(r2.ok, JSON.stringify(r2));
  assert(
    JSON.stringify(r1.plan.cohort_filters) === JSON.stringify(r2.plan.cohort_filters),
    "Old and new condition styles must produce identical cohort filters",
  );
});
