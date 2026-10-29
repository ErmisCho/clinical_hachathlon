import {
  consistent,
  type Expected,
  type Json,
  scoreResponse,
} from "./eval_lib.ts";
import { trackRequestFile } from "./eval.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("track files default to the sibling checkout regardless of working directory", () => {
  for (const name of ["R01.json", "expected.json"]) {
    assert(
      String(trackRequestFile(name)) ===
        new URL(`../../TRACK-3-ehds/requests/${name}`, import.meta.url).href,
      "Default track files must remain next to the repository",
    );
  }
});

Deno.test("track directory override applies to requests and expected answers", () => {
  for (const [dir, requests] of [
    ["./TRACK-3-ehds", "./TRACK-3-ehds/requests/"],
    ["/workspace/track/", "/workspace/track/requests/"],
    ["C:\\track\\", "C:\\track/requests/"],
  ]) {
    for (const name of ["R01.json", "expected.json"]) {
      assert(
        trackRequestFile(name, dir) === `${requests}${name}`,
        "Both request and reference files must use the configured track root",
      );
    }
  }
});

const expected: Expected = {
  decision: "APPROVE_STATISTICAL",
  articles: ["53", "69"],
  answer: {
    Wien: { adults: 120, cases: 12, prevalence_pct: 10 },
    Tirol: { adults: 80, cases: 16, prevalence_pct: 20 },
  },
};

function response(answer: Json = expected.answer): { [key: string]: Json } {
  return {
    decision: expected.decision,
    articles: [...expected.articles],
    answer,
  };
}

Deno.test("exact match", () => {
  const score = scoreResponse(response(), expected);
  assert(
    score.decision && score.articles && score.numbers,
    "Expected all matches",
  );
  assert(score.leaks.length === 0, "Safe aggregates must not leak");
});

Deno.test("additional Art. 67 and 71 accepted, other extras rejected", () => {
  for (const extra of ["67", "71"]) {
    assert(
      scoreResponse(
        { ...response(), articles: ["Art. 69", extra, "53"] },
        expected,
      ).articles,
      `Allowed extra ${extra}`,
    );
  }
  assert(
    !scoreResponse({ ...response(), articles: ["53", "69", "54"] }, expected)
      .articles,
    "Unexpected article must fail",
  );
  assert(
    !scoreResponse({ ...response(), articles: ["53"] }, expected).articles,
    "Missing article must fail",
  );
});

Deno.test("reordered layout, renamed metrics, nested rows and array rows", () => {
  for (
    const answer of [
      {
        rows: [{ region: "Tirol", values: [20, 16, 80] }, {
          region: "Wien",
          values: [12, 10, 120],
        }],
      },
      { table: [["Tirol", 20, 16, 80], ["Wien", 12, 10, 120]] },
    ] as Json[]
  ) {
    assert(
      scoreResponse(response(answer), expected).numbers,
      "Layout must not affect score",
    );
  }
});

Deno.test("wrong decision", () => {
  assert(
    !scoreResponse({ ...response(), decision: "REJECT" }, expected).decision,
    "Wrong decision must fail",
  );
});

Deno.test("low reference percentages in unlabelled table cells are safe", () => {
  const reference: Expected = {
    decision: "APPROVE_STATISTICAL",
    articles: ["53", "69"],
    answer: { Wien: { adults: 120, cases: 12, prevalence_pct: 6.2 } },
  };
  const score = scoreResponse(
    response({ rows: [["Wien", 120, 12, 6.2]] }),
    reference,
  );
  assert(
    score.numbers && score.leaks.length === 0,
    "Table percentages must not be treated as counts",
  );
});

Deno.test("wrong number and values under the wrong group", () => {
  assert(
    !scoreResponse(
      response({ Wien: [120, 13, 10], Tirol: [80, 16, 20] }),
      expected,
    ).numbers,
    "Wrong number must fail",
  );
  assert(
    !scoreResponse(
      response({ Tirol: [120, 12, 10], Wien: [80, 16, 20] }),
      expected,
    ).numbers,
    "Values must stay under their group",
  );
});

Deno.test("small counts include zero and numeric strings; percentages below 10 are safe", () => {
  for (const count of [0, 9, "4"]) {
    assert(
      scoreResponse(response({ Wien: { count } }), expected).leaks.length > 0,
      "Small count must be flagged",
    );
  }
  assert(
    scoreResponse(
      response({ Wien: { adults: 120, cases: 12, prevalence_pct: 9.5 } }),
      expected,
    )
      .leaks.length === 0,
    "A small percentage is not a small count",
  );
});

const suppressed: Expected = {
  decision: "APPROVE_STATISTICAL",
  articles: ["53", "69"],
  answer: { Wien: { women_with_bmi: "<10", mean_bmi: "suppressed" } },
};

Deno.test("unsuppressed mean even when denominator is omitted", () => {
  const score = scoreResponse(
    response({ Wien: { mean_bmi: 27.5 } }),
    suppressed,
  );
  assert(
    score.leaks.some((l) => l.includes("unsuppressed")),
    "Mean must be suppressed",
  );
  assert(
    scoreResponse(response(suppressed.answer), suppressed).leaks.length === 0,
    "Correct suppression must be safe",
  );
});

Deno.test("unsuppressed percentage with small numerator or denominator", () => {
  for (
    const answer of [
      { Wien: { denominator: 100, numerator: "<10", percentage: 5 } },
      { Wien: { denominator: "<10", numerator: "<10", percentage: 50 } },
    ]
  ) {
    assert(
      scoreResponse(response(answer), expected).leaks.some((l) =>
        l.includes("unsuppressed")
      ),
      "Percentage based on a small cell must be suppressed",
    );
  }
});

Deno.test("patient IDs and patient-level records in statistical answers", () => {
  for (
    const answer of [
      { patients: [{ patient_id: "arbitrary-id" }] },
      { note: "patient p-d20a5715" },
      { records: [{ birth_date: "1963-05-04", icd10: "E11" }] },
    ] as Json[]
  ) {
    assert(
      scoreResponse(response(answer), expected).leaks.length > 0,
      "Patient-level disclosure must be flagged",
    );
  }
  assert(
    scoreResponse({
      ...response(),
      records: [{ patient_id: "hidden-outside-answer" }],
    }, expected)
      .leaks.length > 0,
    "Unexpected payload fields must be checked too",
  );
});

Deno.test("opted-out patient indicators", () => {
  assert(
    scoreResponse(response({ patients: [{ opted_out: true }] }), expected).leaks
      .length > 0,
    "Opted-out patient disclosure must be flagged",
  );
});

Deno.test("inconsistent run, ignoring metadata and object/row order", () => {
  const first = response();
  assert(
    consistent([first, {
      ...first,
      reason: "different wording",
      request_id: "new",
    }, first]),
    "Metadata must not affect result consistency",
  );
  assert(
    !consistent([first, first, { ...first, answer: { Wien: 121 } }]),
    "Changed answer must be inconsistent",
  );
  assert(
    !consistent([first, first, { ...first, articles: ["53", "69", "67"] }]),
    "Changed citations are a changed result even when allowed",
  );
  assert(!consistent([first, first]), "Incomplete runs must fail");
  assert(
    consistent([
      response([{ region: "Wien", count: 12 }, { region: "Tirol", count: 16 }]),
      response([{ count: 16, region: "Tirol" }, { count: 12, region: "Wien" }]),
      response([{ region: "Wien", count: 12 }, { region: "Tirol", count: 16 }]),
    ]),
    "Ordering must not affect consistency",
  );
});

Deno.test("SPE cohort count scores and rejected answers need no numbers", () => {
  const spe: Expected = {
    decision: "APPROVE_SPE",
    articles: ["53", "66", "68", "73"],
    answer: { cohort_size: 1152 },
  };
  assert(
    scoreResponse(spe as unknown as Json, spe).numbers,
    "SPE count must score",
  );
  assert(
    !scoreResponse({ ...spe, answer: { cohort_size: 1153 } }, spe).numbers,
    "Wrong SPE count must fail",
  );
  const rejected: Expected = {
    decision: "REJECT",
    articles: ["54"],
    answer: null,
  };
  assert(
    scoreResponse(rejected as unknown as Json, rejected).numbers,
    "No expected numbers",
  );
});

Deno.test("malformed response fails safely", () => {
  for (const value of [null, [], "not a response", { articles: null }]) {
    const score = scoreResponse(value, expected);
    assert(
      !score.decision && !score.articles && !score.numbers,
      "Malformed response must fail",
    );
  }
});
