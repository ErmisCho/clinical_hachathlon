import postgres from "npm:postgres";
import { createHandler, type RegisterDatabase } from "./handler.ts";

Deno.serve(createHandler(() => {
  const url = Deno.env.get("SUPABASE_DB_URL");
  if (!url) throw new Error("SUPABASE_DB_URL is not set");
  return postgres(url, {
    max: 1,
    idle_timeout: 10,
    connect_timeout: 10,
  }) as unknown as RegisterDatabase;
}));
