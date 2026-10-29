// deno run -A scripts/check-unseen.ts (requires DATABASE_URL)
import postgres from "npm:postgres";
import { runPlan } from "../supabase/functions/_shared/engine.ts";
import type {
  Answer,
  SqlClient,
} from "../supabase/functions/_shared/engine.ts";
import { parseRequest } from "../supabase/functions/_shared/parser.ts";

async function check(id: string, sql: SqlClient): Promise<boolean> {
  const fixture = new URL(
    `../supabase/fixtures/unseen/${id}.json`,
    import.meta.url,
  );
  const parsed = parseRequest(JSON.parse(await Deno.readTextFile(fixture)));
  if (!parsed.ok) {
    throw new Error(`Parse failure: ${JSON.stringify(parsed.errors)}`);
  }
  const plan = parsed.plan;
  if (
    plan.dimensions?.length !== 1 || plan.metrics.length !== 1 ||
    plan.metrics[0].type !== "count"
  ) throw new Error("Expected one grouping dimension and one count metric");

  const answer = await runPlan(plan, sql);
  const reference = await sql.unsafe(
    await Deno.readTextFile(new URL(`${id}.sql`, fixture)),
    [],
  );
  const hand = new Map<string, bigint>();
  for (const row of reference) {
    if (typeof row.group_key !== "string" || !/^\d+$/.test(String(row.n))) {
      throw new Error(`Invalid reference row: ${JSON.stringify(row)}`);
    }
    if (hand.has(row.group_key)) throw new Error("Duplicate reference group");
    hand.set(row.group_key, BigInt(String(row.n)));
  }
  const groups = [...new Set([...hand.keys(), ...Object.keys(answer)])].sort();
  if (!groups.length) {
    throw new Error("No groups found; cannot verify an empty dataset");
  }
  let matched = true;
  const label = plan.metrics[0].label;
  for (const group of groups) {
    const raw = hand.get(group);
    // Deliberately independent of the engine's disclosure implementation.
    const expected = raw === undefined
      ? undefined
      : raw < 10n
      ? "<10"
      : Number(raw);
    const cell = answer[group];
    const actual = typeof cell === "object"
      ? (cell as Answer)[label]
      : undefined;
    const ok = hand.has(group) && Object.hasOwn(answer, group) &&
      typeof cell === "object" && Object.keys(cell).length === 1 &&
      actual === expected;
    matched = matched && ok;
    console.log(
      `${id} ${JSON.stringify(group)}: ${ok ? "MATCH" : "MISMATCH"}` +
        ` hand_raw=${raw ?? "missing"} hand_released=${expected ?? "missing"}` +
        ` engine=${actual ?? "missing"}`,
    );
  }
  return matched;
}

if (import.meta.main) {
  try {
    const url = Deno.env.get("DATABASE_URL");
    if (!url) throw new Error("DATABASE_URL is not set");
    const sql = postgres(url, {
      max: 1,
      connect_timeout: 10,
      idle_timeout: 10,
    });
    try {
      // Compare both implementations against the same database snapshot.
      await sql.begin(
        "isolation level repeatable read read only",
        async (tx) => {
          for (const id of ["U01", "U02"]) {
            try {
              if (!await check(id, tx)) Deno.exitCode = 1;
            } catch (error) {
              console.error(
                `${id}: ERROR ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
              Deno.exitCode = 1;
            }
          }
        },
      );
    } finally {
      await sql.end();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exitCode = 1;
  }
}
