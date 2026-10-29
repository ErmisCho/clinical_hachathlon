import postgres from "npm:postgres";
import { runPlan } from "../supabase/functions/_shared/engine.ts";
import { validatePlan } from "../supabase/functions/_shared/plan.ts";

if (import.meta.main) {
  try {
    if (Deno.args.length !== 1) {
      throw new Error("Usage: deno run -A scripts/run-plan.ts <plan.json>");
    }
    const result = validatePlan(
      JSON.parse(await Deno.readTextFile(Deno.args[0])),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const url = Deno.env.get("DATABASE_URL");
    if (!url) throw new Error("DATABASE_URL is not set");
    const sql = postgres(url, {
      max: 1,
      connect_timeout: 10,
      idle_timeout: 10,
    });
    try {
      console.log(JSON.stringify(await runPlan(result.plan, sql), null, 2));
    } finally {
      await sql.end();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exitCode = 1;
  }
}
