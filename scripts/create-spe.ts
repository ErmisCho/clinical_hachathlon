import postgres from "npm:postgres";
import { createSpe, type SqlClient } from "../supabase/functions/_shared/spe.ts";
import { validatePlan } from "../supabase/functions/_shared/plan.ts";

/**
 * CLI: deno run -A scripts/create-spe.ts <plan.json> <requestId>
 *
 * Creates (or recreates) the secure processing environment schema for the
 * given request, using the DATABASE_URL environment variable.
 *
 * Prints the SpeResult as JSON on success.
 */
if (import.meta.main) {
  try {
    if (Deno.args.length !== 2) {
      throw new Error(
        "Usage: deno run -A scripts/create-spe.ts <plan.json> <requestId>",
      );
    }
    const [planPath, requestId] = Deno.args;

    const raw = JSON.parse(await Deno.readTextFile(planPath));
    const result = validatePlan(raw);
    if (!result.ok) {
      throw new Error(
        `Invalid plan: ${JSON.stringify(result.errors, null, 2)}`,
      );
    }

    const url = Deno.env.get("DATABASE_URL");
    if (!url) throw new Error("DATABASE_URL is not set");

    const sql = postgres(url, {
      max: 1,
      connect_timeout: 10,
      idle_timeout: 10,
    });

    try {
      // Adapt postgres.js to the SqlClient interface expected by createSpe.
      // postgres.js sql.begin has a slightly different return type wrapper;
      // cast it to satisfy our SqlClient interface.
      function makeClient(rawSql: typeof sql): SqlClient {
        const c: SqlClient = {
          unsafe: (query: string, params?: (string | number | boolean)[]) =>
            rawSql.unsafe(query, params as (string | number)[]),
          // deno-lint-ignore no-explicit-any
          begin: <T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> =>
            rawSql.begin((tx) =>
              fn(makeClient(tx as unknown as typeof sql))
            ) as unknown as Promise<T>,
        };
        return c;
      }
      const client = makeClient(sql);

      const speResult = await createSpe(result.plan, client, requestId);
      console.log(JSON.stringify(speResult, null, 2));
    } finally {
      await sql.end();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exitCode = 1;
  }
}
