/**
 * Edge function: GET|POST /spe-download
 *
 * Downloads from a Secure Processing Environment are ALWAYS blocked.
 * EHDS Art. 73 — data in an SPE cannot be exported or downloaded.
 *
 * Every attempt is logged to public.spe_download_log for auditing.
 * The function always returns HTTP 403 regardless of authentication.
 */
import postgres from "npm:postgres";

// ---------------------------------------------------------------------------
// CORS helpers (mirrors requests/index.ts)
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
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Only GET and POST are supported.
  if (req.method !== "GET" && req.method !== "POST") {
    return corsResponse({ error: "method not allowed" }, 405);
  }

  // Extract request id from query param or JSON body.
  let requestId: string | null = null;
  const url = new URL(req.url);
  const queryParam = url.searchParams.get("id");
  if (queryParam) {
    requestId = queryParam;
  } else if (req.method === "POST") {
    try {
      const body = await req.json();
      if (typeof body?.id === "string") requestId = body.id;
    } catch {
      // Ignore JSON parse errors — request_id stays null, we still return 403.
    }
  }

  const userAgent = req.headers.get("user-agent") ?? null;
  const schemaValue = requestId
    ? `spe_${requestId.toLowerCase()}`
    : "(unknown)";

  // Log the attempt (best-effort: never let a log failure change the 403).
  const db = getDb();
  try {
    await db`
      INSERT INTO public.spe_download_log (request_id, schema, user_agent)
      VALUES (${requestId ?? "(unknown)"}, ${schemaValue}, ${userAgent})
    `;
  } catch (err) {
    console.error("spe-download: failed to log attempt:", err);
  } finally {
    await db.end();
  }

  console.warn(
    `spe-download: blocked download attempt for request_id=${requestId} schema=${schemaValue} user_agent=${userAgent}`,
  );

  // Always return 403 — downloads are unconditionally blocked.
  return corsResponse(
    {
      error:
        "Download blocked: data in a secure processing environment cannot be downloaded (EHDS Art. 73).",
      request_id: requestId,
    },
    403,
  );
});
