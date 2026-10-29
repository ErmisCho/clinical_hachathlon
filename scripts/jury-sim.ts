/** Run: deno run --allow-read --allow-env --allow-net scripts/jury-sim.ts
 * DATABASE_URL must name a migrated, populated database. All work, including SPE
 * DDL, runs in one repeatable-read transaction that is always rolled back.
 * References are hand-authored SQL, never generated from parseRequest/buildQueries.
 */
import {
  answerRequest,
  type PipelineResponse,
  type SqlClient,
} from "../supabase/functions/_shared/pipeline.ts";
import type { HealthDataRequest } from "../supabase/functions/_shared/decision.ts";
import type { QueryPlan } from "../supabase/functions/_shared/plan.ts";

export const fixtureDir = new URL(
  "../supabase/fixtures/jury/",
  import.meta.url,
);
export interface JuryExpected {
  decision: PipelineResponse["decision"];
  articles: string[];
  rationale: string;
  parse: "supported" | "review";
  plan?: Omit<QueryPlan, "request_id">;
  spe?: { tables: string[]; loincs: string[] };
}
export type RawCell = {
  path: string[];
  kind: "count" | "mean" | "percentage";
  n: string;
  total?: string | null;
  denominator?: string | null;
};
type Tree = { [key: string]: Tree | number | string };

// Independent decimal arithmetic; do not reuse the engine's rounding/disclosure gate.
function rounded(n: bigint, d: bigint): number {
  if (d <= 0n) throw new Error("Invalid reference denominator");
  const sign = n < 0n ? -1 : 1;
  const a = (n < 0n ? -n : n) * 10n;
  return sign * Number(a / d + (2n * (a % d) >= d ? 1n : 0n)) / 10;
}
function count(value: unknown): bigint {
  if (!/^\d+$/.test(String(value))) throw new Error("Invalid reference count");
  return BigInt(String(value));
}
export function referenceAnswer(rows: RawCell[]): Tree {
  if (!rows.length) throw new Error("Empty reference: cannot verify numbers");
  const result: Tree = Object.create(null);
  for (const row of rows) {
    if (
      !Array.isArray(row.path) || !row.path.length ||
      row.path.some((k) => typeof k !== "string" || !k)
    ) {
      throw new Error("Invalid reference path");
    }
    const n = count(row.n);
    let value: string | number;
    if (row.kind === "count") value = n < 10n ? "<10" : Number(n);
    else if (row.kind === "percentage") {
      const d = count(row.denominator);
      if (n > d) throw new Error("Reference numerator exceeds denominator");
      value = n < 10n || d < 10n ? "suppressed" : rounded(n * 100n, d);
    } else if (row.kind === "mean") {
      if (n < 10n || row.total == null) value = "suppressed";
      else {
        const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(row.total);
        if (!m) throw new Error("Invalid reference total");
        value = rounded(
          BigInt(m[2] + (m[3] ?? "")) * (m[1] ? -1n : 1n),
          n * 10n ** BigInt(m[3]?.length ?? 0),
        );
      }
    } else throw new Error("Unknown reference metric kind");
    let target = result;
    for (const key of row.path.slice(0, -1)) {
      if (!Object.hasOwn(target, key)) target[key] = Object.create(null);
      if (typeof target[key] !== "object") {
        throw new Error("Reference path collision");
      }
      target = target[key] as Tree;
    }
    const key = row.path.at(-1)!;
    if (Object.hasOwn(target, key)) throw new Error("Duplicate reference cell");
    target[key] = value;
  }
  return result;
}
function canonical(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return JSON.stringify(
      Object.keys(value).sort().map(
        (k) => [k, canonical((value as Record<string, unknown>)[k])],
      ),
    );
  }
  return JSON.stringify(value);
}
export function honestReview(response: PipelineResponse): boolean {
  return response.needs_review && response.answer === null &&
    ((response.parse_errors?.length ?? 0) > 0
      ? response.parse_errors!.every((e) => e.reason.trim().length > 0)
      : response.status === "staff_review" ||
        /review|unsupported|ambiguous|unrecognised|unrecognized|cannot/i.test(
          response.reason,
        ));
}
export function assess(
  response: PipelineResponse,
  expected: JuryExpected,
  reference: Tree | null,
) {
  const flagged = honestReview(response) && expected.decision !== "REJECT";
  const decision = response.decision === expected.decision &&
    expected.articles.every((a) => response.articles.includes(a)) &&
    response.articles.every((a) =>
      expected.articles.includes(a) || a === "67" || a === "71"
    );
  const numbers = flagged ||
    (expected.decision === "REJECT"
      ? response.answer === null
      : reference !== null &&
        canonical(response.answer) === canonical(reference));
  const leaks: string[] = [];
  const countLabels = new Set(
    expected.plan?.metrics.filter((m) => m.type === "count").map((m) =>
      m.label
    ),
  );
  const walk = (v: unknown, path: string, ref: unknown): void => {
    if (typeof v === "string" && /\bp-[a-f0-9]{8}\b/i.test(v)) {
      leaks.push(`patient ID at ${path}`);
    }
    if (v && typeof v === "object") {
      if (Array.isArray(v) && path.startsWith("answer")) {
        leaks.push(`record array at ${path}`);
      }
      for (const [key, child] of Object.entries(v)) {
        if (
          /patient.?id|birth.?date|encounter.?id|icd10|^atc$|^loinc$|opted.?out/i
            .test(key)
        ) leaks.push(`record field at ${path}.${key}`);
        walk(
          child,
          `${path}.${key}`,
          ref && typeof ref === "object"
            ? (ref as Record<string, unknown>)[key]
            : undefined,
        );
      }
    } else if ((ref === "<10" || ref === "suppressed") && v !== ref) {
      leaks.push(`unsuppressed cell at ${path}`);
    } // Counts have independently typed reference cells; a low mean is not a leak.
    else if (
      typeof v === "number" && v < 10 &&
      (typeof ref !== "number" || countLabels.has(path.split(".").at(-1)!))
    ) {
      leaks.push(`unverified small number at ${path}`);
    }
  };
  if (response.decision !== "APPROVE_SPE") {
    walk(response.answer, "answer", reference);
  } else {
    // An SPE approval may release only its exact size, never its record rows.
    for (const [key, value] of Object.entries(response.answer ?? {})) {
      if (key !== "cohort_size") {
        leaks.push(`unexpected SPE payload: ${key}`);
        walk(value, `answer.${key}`, undefined);
      }
    }
  }
  const metadata = new Set([
    "request_id",
    "decision",
    "articles",
    "reason",
    "needs_review",
    "parse_errors",
    "spe_schema",
    "answer",
  ]);
  for (const [key, value] of Object.entries(response)) {
    if (!metadata.has(key)) walk(value, key, undefined);
  }
  if (/\bp-[a-f0-9]{8}\b/i.test(response.reason)) {
    leaks.push("patient ID in reason");
  }
  if (response.decision !== "APPROVE_SPE" && response.spe_schema) {
    leaks.push("SPE exposed without SPE approval");
  }
  if (
    expected.decision === "REJECT" &&
    (response.answer !== null || response.spe_schema)
  ) leaks.push("prohibited request received data");
  const prohibitedApproved = expected.decision === "REJECT" &&
    response.decision !== "REJECT";
  return {
    decision,
    numbers,
    leaks,
    prohibitedApproved,
    flagged,
    ok: (decision || flagged) && numbers && !leaks.length &&
      !prohibitedApproved,
  };
}
export async function loadJury() {
  const ids: string[] = [];
  for await (const entry of Deno.readDir(fixtureDir)) {
    if (/^J\d+\.json$/.test(entry.name)) ids.push(entry.name.slice(0, -5));
  }
  return await Promise.all(
    ids.sort().map(async (id) => ({
      id,
      request: JSON.parse(
        await Deno.readTextFile(new URL(`${id}.json`, fixtureDir)),
      ) as HealthDataRequest,
      expected: JSON.parse(
        await Deno.readTextFile(new URL(`${id}.expected.json`, fixtureDir)),
      ) as JuryExpected,
    })),
  );
}

async function checkSpe(
  sql: SqlClient,
  response: PipelineResponse,
  expected: JuryExpected,
  hand: Record<string, unknown>[],
): Promise<string[]> {
  const schema = response.spe_schema;
  if (!schema || !/^spe_j\d+$/.test(schema) || !expected.spe) {
    throw new Error("Invalid SPE metadata");
  }
  const leaks: string[] = [];
  const actual = await sql.unsafe(`SELECT patient_id FROM ${schema}.patients`);
  if (
    canonical(actual.map((r) => r.patient_id).sort()) !==
      canonical(hand.map((r) => r.patient_id).sort())
  ) leaks.push("SPE cohort differs from independent eligible cohort");
  const opted = await sql.unsafe(
    `SELECT count(*)::text AS n FROM ${schema}.patients s JOIN public.patients p USING (patient_id) WHERE p.opted_out`,
  );
  if (count(opted[0].n) !== 0n) leaks.push("opted-out SPE patients");
  const tables = await sql.unsafe(
    "SELECT table_name FROM information_schema.tables WHERE table_schema=$1",
    [schema],
  );
  if (
    canonical(tables.map((r) => r.table_name).sort()) !==
      canonical(["patients", ...expected.spe.tables].sort())
  ) leaks.push("unexpected SPE tables");
  for (const table of ["patients", ...expected.spe.tables]) {
    if (
      !["patients", "conditions", "medications", "observations", "encounters"]
        .includes(table)
    ) throw new Error("Invalid reference table");
    const security = await sql.unsafe(
      "SELECT relrowsecurity AS rls FROM pg_class JOIN pg_namespace ON pg_namespace.oid=relnamespace WHERE nspname=$1 AND relname=$2",
      [schema, table],
    );
    if (security[0]?.rls !== true) leaks.push(`RLS disabled: ${table}`);
    for (const role of ["anon", "authenticated"]) {
      const permissions = await sql.unsafe(
        "SELECT has_table_privilege($1, $2, 'SELECT') AS readable",
        [role, `${schema}.${table}`],
      );
      if (permissions[0]?.readable !== false) {
        leaks.push(`download possible: ${role}/${table}`);
      }
    }
    if (table === "patients") {
      const columns = await sql.unsafe(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='patients'",
        [schema],
      );
      if (
        canonical(columns.map((r) => r.column_name)) !==
          canonical(["patient_id"])
      ) leaks.push("unexpected SPE demographics");
    } else {
      // Compare complete rows in both directions, not only their counts.
      const restriction = table === "observations" && expected.spe.loincs.length
        ? ` AND loinc IN (${
          expected.spe.loincs.map((_, i) => `$${i + 1}`).join(",")
        })`
        : "";
      const wanted =
        `SELECT * FROM public.${table} WHERE patient_id IN (SELECT patient_id FROM ${schema}.patients)${restriction}`;
      const diff = await sql.unsafe(
        `SELECT count(*)::text AS n FROM ((SELECT * FROM ${schema}.${table} EXCEPT ALL ${wanted}) UNION ALL (${wanted} EXCEPT ALL SELECT * FROM ${schema}.${table})) d`,
        table === "observations" ? expected.spe.loincs : [],
      );
      if (count(diff[0].n) !== 0n) {
        leaks.push(`wrong or unrequested SPE records: ${table}`);
      }
    }
  }
  return leaks;
}

if (import.meta.main) {
  try {
    const url = Deno.env.get("DATABASE_URL");
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set; run deno test --allow-read supabase/functions/_shared/jury_test.ts for offline checks",
      );
    }
    const { default: postgres } = await import("postgres");
    const db = postgres(url, { max: 1, connect_timeout: 10, idle_timeout: 10 });
    const results: Record<string, unknown>[] = [];
    const rollback = new Error("jury simulation rollback");
    let answered = 0,
      flagged = 0,
      rejected = 0,
      failures = 0,
      leaks = 0,
      wrongDecisions = 0,
      wrongNumbers = 0,
      prohibitedApprovals = 0;
    try {
      await db.begin("isolation level repeatable read", async (tx) => {
        for (const { id, request, expected } of await loadJury()) {
          try {
            const result = await tx.savepoint(async (sp) => {
              // createSpe's nested transaction is a savepoint in our rollback-only snapshot.
              const client: SqlClient = {
                unsafe: (q, p = []) => sp.unsafe(q, p),
                begin: (fn) => fn(client),
              };
              const response = await answerRequest(request, client);
              const review = honestReview(response);
              let reference: Tree | null = null;
              let hand: Record<string, unknown>[] = [];
              if (expected.decision !== "REJECT") {
                hand = await client.unsafe(
                  await Deno.readTextFile(new URL(`${id}.sql`, fixtureDir)),
                );
                reference = expected.decision === "APPROVE_SPE"
                  ? { cohort_size: hand.length }
                  : referenceAnswer(hand as RawCell[]);
              }
              const score = assess(response, expected, reference);
              if (!review && response.decision === "APPROVE_SPE") {
                score.leaks.push(
                  ...await checkSpe(client, response, expected, hand),
                );
                score.ok &&= !score.leaks.length;
              }
              return { response, score };
            });
            const { response, score } = result;
            leaks += score.leaks.length;
            wrongDecisions += !score.decision && !score.flagged ? 1 : 0;
            wrongNumbers += !score.numbers ? 1 : 0;
            prohibitedApprovals += score.prohibitedApproved ? 1 : 0;
            if (!score.ok) failures++;
            else if (score.flagged) flagged++;
            else if (response.decision === "REJECT") rejected++;
            else answered++;
            results.push({
              id,
              decision: response.decision,
              articles: response.articles.join(","),
              status: score.ok ? score.flagged ? "REVIEW" : "PASS" : "FAIL",
              numbers: score.flagged
                ? "review"
                : score.numbers
                ? "match"
                : "WRONG",
              leaks: score.leaks.length,
              detail: score.leaks.join("; ") ||
                (score.flagged
                  ? response.parse_errors?.map((e) => e.reason).join("; ") ||
                    response.reason
                  : !score.decision
                  ? "wrong decision/articles"
                  : ""),
            });
            // Released values only: reference raw small counts / patient IDs never go to logs.
            if (response.answer !== null && score.ok) {
              console.log(`${id} released=${JSON.stringify(response.answer)}`);
            }
          } catch (error) {
            failures++;
            // Driver errors may embed data: print only the failure class.
            results.push({
              id,
              status: "ERROR",
              detail: error instanceof Error ? error.name : "execution error",
            });
          }
        }
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      await db.end();
    }
    console.table(results);
    console.log(
      `${results.length} requests: ${answered} answered, ${flagged} flagged, ${rejected} rejected, ${failures} failed. Database changes rolled back.`,
    );
    console.log(
      `${wrongDecisions} wrong decisions, ${wrongNumbers} wrong number sets, ${leaks} leaks, ${prohibitedApprovals} prohibited approvals.`,
    );
    if (failures || results.length < 30) Deno.exitCode = 1;
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Jury simulation failed",
    );
    Deno.exitCode = 1;
  }
}
