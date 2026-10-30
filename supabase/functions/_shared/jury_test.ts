import { decide } from "./decision.ts";
import { parseRequest } from "./parser.ts";
import {
  answerRequest,
  type PipelineResponse,
  type SqlClient,
} from "./pipeline.ts";
import {
  assess,
  type JuryExpected,
  type RawCell,
  referenceAnswer,
} from "../../../scripts/jury-sim.ts";

import { JURY_FIXTURES as jury } from "./jury_fixtures.ts";

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
const noDatabase: SqlClient = {
  unsafe: () => {
    throw new Error("Rejected/review requests must not touch patient data");
  },
  begin: () => {
    throw new Error("Rejected/review requests must not create an SPE");
  },
};
Deno.test("jury corpus: at least 30 independently annotated requests, 8 prohibited, every statistics request has reference SQL", () => {
  assert(jury.length >= 30, "Too few unseen requests");
  assert(
    jury.filter((f) => f.expected.decision === "REJECT").length >= 8,
    "Too few prohibited requests",
  );
  assert(new Set(jury.map((f) => f.id)).size === jury.length, "Duplicate IDs");
  for (const { id, request, expected, sql } of jury) {
    assert(request.id === id, "ID does not match filename");
    assert(
      expected.rationale.length > 30,
      `${id}: missing independent decision rationale`,
    );
    if (expected.decision !== "REJECT") {
      assert(typeof sql === "string", `${id}: missing reference SQL`);
      assert(
        sql.includes("public.eligible_patients"),
        `${id}: reference must exclude opt-outs`,
      );
      assert(
        !sql.includes("buildQueries"),
        `${id}: reference must be hand SQL`,
      );
    }
  }
});
for (const { id, request, expected } of jury) {
  Deno.test(`${id}: offline decision/articles and parse-or-honest-review`, async () => {
    const decision = decide(request);
    assert(
      decision.decision === expected.decision,
      `${id}: expected ${expected.decision}, got ${decision.decision}`,
    );
    assert(
      expected.articles.every((a) => decision.articles.includes(a)),
      `${id}: wrong articles`,
    );
    const parsed = parseRequest(request);
    if (expected.decision === "REJECT" || decision.needs_review || !parsed.ok) {
      const result = await answerRequest(request, noDatabase);
      const score = assess(result, expected, null);
      assert(
        score.ok,
        `${id}: reject/review contract failed: ${JSON.stringify(score)}`,
      );
      if (expected.decision !== "REJECT") {
        assert(
          expected.parse === (parsed.ok ? "supported" : "review"),
          `${id}: unexpected parser regression: ${JSON.stringify(parsed)}`,
        );
      }
    } else {
      assert(
        expected.parse === "supported",
        `${id}: unsafe phrasing silently accepted`,
      );
      assert(!decision.needs_review, `${id}: unexpectedly ambiguous purpose`);
      const { request_id: _id, ...plan } = parsed.plan;
      const stable = (v: unknown): unknown =>
        Array.isArray(v)
          ? v.map(stable)
          : v && typeof v === "object"
          ? Object.fromEntries(
            Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map((
              [k, v],
            ) => [k, stable(v)]),
          )
          : v;
      assert(
        JSON.stringify(stable(plan)) === JSON.stringify(stable(expected.plan)),
        `${id}: plan differs from independently written contract: ${
          JSON.stringify(plan)
        }`,
      );
    }
  });
}

const stats: JuryExpected = {
  decision: "APPROVE_STATISTICAL",
  articles: ["53", "69"],
  rationale: "Independently specified aggregate reference.",
  parse: "supported",
};
const response = (answer: unknown): PipelineResponse => ({
  request_id: "test",
  rule_id: "A01",
  rules_version: "1.0.0",
  decision: "APPROVE_STATISTICAL",
  articles: ["53", "69"],
  reason: "Allowed research",
  needs_review: false,
  answer: answer as PipelineResponse["answer"],
});
Deno.test("jury oracle: small counts, percentages, decimal means and half-up rounding are independently released", () => {
  const rows: RawCell[] = [
    { path: ["A", "count"], kind: "count", n: "0" },
    { path: ["B", "count"], kind: "count", n: "9" },
    { path: ["C", "count"], kind: "count", n: "10" },
    { path: ["A", "pct"], kind: "percentage", n: "9", denominator: "100" },
    { path: ["C", "pct"], kind: "percentage", n: "13", denominator: "80" },
    { path: ["B", "mean"], kind: "mean", n: "9", total: "900" },
    { path: ["C", "mean"], kind: "mean", n: "10", total: "12.5" },
  ];
  const ref = referenceAnswer(rows);
  assert(
    JSON.stringify(ref) ===
      JSON.stringify({
        A: { count: "<10", pct: "suppressed" },
        B: { count: "<10", mean: "suppressed" },
        C: { count: 10, pct: 16.3, mean: 1.3 },
      }),
    "Wrong independent disclosure arithmetic",
  );
  assert(assess(response(ref), stats, ref).ok, "Correct nested answer failed");
});
Deno.test("jury scorer: wrong values, omitted groups, extra records and suppressed cells cannot pass", () => {
  const ref = referenceAnswer([{ path: ["A", "n"], kind: "count", n: "12" }, {
    path: ["B", "n"],
    kind: "count",
    n: "3",
  }]);
  for (
    const answer of [{ A: { n: 13 }, B: { n: "<10" } }, { A: { n: 12 } }, {
      A: { n: 12 },
      B: { n: 3 },
    }, { ...ref, patient_id: "p-abcdef12" }]
  ) {
    assert(!assess(response(answer), stats, ref).ok, "Wrong answer passed");
  }
  assert(
    assess(response({ A: { n: 12 }, B: { n: 3 } }), stats, ref).leaks.length >
      0,
    "Small cell leak undetected",
  );
  const flagged = {
    ...response({ A: { n: 999 } }),
    needs_review: true,
    reason: "Needs review",
  };
  assert(
    !assess(flagged, stats, ref).ok,
    "Review cannot excuse released wrong numbers",
  );
});
Deno.test("jury scorer: prohibited approvals cannot hide behind needs_review; honest review must explain", () => {
  const prohibited: JuryExpected = {
    ...stats,
    decision: "REJECT",
    articles: ["54"],
  };
  const flagged = {
    ...response(null),
    needs_review: true,
    reason: "Needs review: unsupported definition",
  };
  assert(assess(flagged, stats, null).ok, "Honest review rejected");
  assert(
    !assess({ ...flagged, reason: "Approved" }, stats, null).ok,
    "Unexplained review accepted",
  );
  assert(
    !assess(flagged, prohibited, null).ok,
    "Prohibited approval accepted as review",
  );
  assert(
    !assess(
      { ...response(null), decision: "REJECT", articles: [] },
      prohibited,
      null,
    ).ok,
    "Missing Art. 54 accepted",
  );
});

Deno.test("jury scorer: a wrong small count is a leak even when the correct count is large", () => {
  const expected: JuryExpected = {
    ...stats,
    plan: {
      cohort_filters: [],
      count_unit: "patient",
      metrics: [{ type: "count", label: "n" }],
    },
  };
  const score = assess(response({ n: 3 }), expected, { n: 120 });
  assert(
    !score.ok && score.leaks.length > 0,
    "Unexpected small counts must be identified as leaks",
  );
  assert(
    !assess(
      { ...response({ n: 120 }), articles: ["53", "69", "54"] },
      expected,
      { n: 120 },
    ).ok,
    "Unexpected legal articles must fail",
  );
});

Deno.test("jury scorer: staff-review holds are flagged without parse errors or review wording", () => {
  const held: PipelineResponse = {
    ...response(null),
    needs_review: true,
    status: "staff_review",
  };
  const score = assess(held, stats, null);
  assert(
    score.flagged && score.ok,
    "Held response must count as honest review",
  );
  for (
    const invalid of [
      { ...held, needs_review: false },
      { ...held, status: "decided" as const },
      { ...held, answer: { n: 999 } },
      { ...held, parse_errors: [{ definition: "unknown", reason: " " }] },
    ]
  ) {
    const score = assess(invalid, stats, null);
    assert(
      !score.flagged && !score.ok,
      "Invalid hold must not excuse an answer",
    );
  }
  assert(
    !assess(held, { ...stats, decision: "REJECT", articles: ["54"] }, null).ok,
    "A hold cannot excuse a prohibited approval",
  );
  const leaked = assess(
    { ...held, population: { eligible_patients: 3 } },
    stats,
    null,
  );
  assert(
    !leaked.ok && leaked.leaks.length > 0,
    "Holds must retain leak checks",
  );
});
