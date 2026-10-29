/**
 * Edge function: POST /requests
 *
 * Thin slice for issue #16 — handles R07 only.
 * Any other request id returns HTTP 501.
 */
import postgres from "npm:postgres";
import { buildR07Answer, buildR07Response } from "../_shared/r07.ts";

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function corsResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

// ---------------------------------------------------------------------------
// Database helper
// ---------------------------------------------------------------------------

function getDb(): ReturnType<typeof postgres> {
  const url = Deno.env.get("SUPABASE_DB_URL");
  if (!url) throw new Error("SUPABASE_DB_URL is not set");
  return postgres(url, { max: 1, idle_timeout: 10, connect_timeout: 10 });
}

// ---------------------------------------------------------------------------
// R07 query
// ---------------------------------------------------------------------------

/**
 * Count inpatient stays that started in 2025 per region,
 * joined via eligible_patients (opted-out patients excluded).
 * Also fetches all distinct regions from eligible_patients so
 * empty ones are included in the response.
 */
async function queryR07(
  db: ReturnType<typeof postgres>,
): Promise<ReturnType<typeof buildR07Response>> {
  // 1. Fetch all regions from eligible_patients.
  const regionRows = await db<{ region: string }[]>`
    SELECT DISTINCT p.region
    FROM public.eligible_patients AS p
    WHERE p.region IS NOT NULL
    ORDER BY p.region
  `;
  const allRegions = regionRows.map((r) => r.region);

  // 2. Count inpatient stays in 2025 per region (parameterised).
  const countRows = await db<{ region: string; stay_count: string }[]>`
    SELECT p.region,
           COUNT(e.encounter_id)::text AS stay_count
    FROM public.eligible_patients AS p
    JOIN public.encounters AS e
      ON e.patient_id = p.patient_id
    WHERE e.type        = ${"inpatient"}
      AND e.start_date >= ${"2025-01-01"}::date
      AND e.start_date <= ${"2025-12-31"}::date
    GROUP BY p.region
  `;

  const rows = countRows.map((r) => ({
    region: r.region,
    stay_count: parseInt(r.stay_count, 10),
  }));

  const answer = buildR07Answer(rows, allRegions);
  return buildR07Response(answer);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return corsResponse({ error: "method not allowed" }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return corsResponse({ error: "invalid JSON body" }, 400);
  }

  const requestId = body["id"];
  if (typeof requestId !== "string" || requestId === "") {
    return corsResponse({ error: 'missing required field "id"' }, 400);
  }

  if (requestId !== "R07") {
    return corsResponse({ error: "not supported yet" }, 501);
  }

  const db = getDb();
  try {
    const result = await queryR07(db);
    return corsResponse(result, 200);
  } catch (err) {
    console.error("R07 query error:", err);
    return corsResponse({ error: "internal server error" }, 500);
  } finally {
    await db.end();
  }
});
