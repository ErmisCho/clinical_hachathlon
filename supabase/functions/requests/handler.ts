import {
  readRequestJson,
  RequestInputError,
  validateRequest,
} from "../_shared/request_validation.ts";
import { answerRequest, type SqlClient } from "../_shared/pipeline.ts";
import {
  listRequests,
  loadRequest,
  type RequestLogSql,
  saveRequest,
} from "../_shared/request_log.ts";

export type RequestDatabase = SqlClient & RequestLogSql & {
  end(): Promise<void>;
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

/** Test HTTP routing without starting Deno.serve or importing postgres. */
export function createHandler(connect: () => RequestDatabase) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (req.method !== "GET" && req.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }
    const url = new URL(req.url);
    const path = url.pathname.match(/\/requests(?:\/([^/]+))?\/?$/);
    if (!path) return json({ error: "not found" }, 404);
    if (req.method === "POST" && path[1]) {
      return json({ error: "method not allowed" }, 405);
    }

    let id: string | null = null;
    if (req.method === "GET") {
      try {
        // An explicit query parameter takes precedence over a path id.
        id = url.searchParams.has("id")
          ? url.searchParams.get("id")
          : path[1]
          ? decodeURIComponent(path[1])
          : null;
      } catch {
        return json({ error: "invalid request id" }, 400);
      }
      if (id !== null && !id.trim()) {
        return json({ error: "invalid request id" }, 400);
      }
    }

    let body: Record<string, unknown> | undefined;
    if (req.method === "POST") {
      try {
        const value = await readRequestJson(req);
        const problems = validateRequest(value);
        if (problems.length) {
          return json({ error: "invalid request", problems }, 400);
        }
        body = value as Record<string, unknown>;
      } catch (error) {
        return error instanceof RequestInputError
          ? json({ error: error.message }, error.status)
          : json({ error: "invalid JSON body" }, 400);
      }
    }

    let sql: RequestDatabase | undefined;
    try {
      sql = connect();
      if (body) {
        const response = await answerRequest(body, sql);
        await saveRequest(sql, body, response);
        return json(response);
      }
      if (id !== null) {
        const response = await loadRequest(sql, id);
        return response
          ? json(response)
          : json({ error: "request not found" }, 404);
      }
      const requests = await listRequests(sql);
      const downloads = await sql.unsafe(
        `SELECT request_id, attempted_at FROM public.spe_download_log
         ORDER BY attempted_at DESC, id DESC`,
        [],
      );
      return json({
        requests: requests.map((row) => ({
          request_id: row.request_id,
          submitted_at: row.submitted_at,
          decision: row.decision,
          articles: row.articles,
          needs_review: row.needs_review,
          spe_schema: row.spe_schema ?? null,
        })),
        downloads: downloads.map((row) => ({
          request_id: row.request_id,
          attempted_at: row.attempted_at,
        })),
      });
    } catch {
      return json({ error: "internal server error" }, 500);
    } finally {
      try {
        await sql?.end();
      } catch {
        // Cleanup must not replace the JSON response or leak details.
        console.error("requests: database cleanup failed");
      }
    }
  };
}
