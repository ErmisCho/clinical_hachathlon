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
import { ReviewError, reviewRequest, validReview } from "./review.ts";

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
    const isReview = req.method === "POST" && path[1] === "review";
    if (req.method === "POST" && path[1] && !isReview) {
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
        const problems = isReview
          ? validReview(value) ? [] : ["invalid staff review fields"]
          : validateRequest(value);
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
    let stage = "connect";
    try {
      sql = connect();
      if (isReview && validReview(body)) {
        stage = "review_request";
        const response = await sql.begin((tx) =>
          reviewRequest(tx as RequestDatabase, body)
        );
        stage = "serialize";
        return json(response);
      }
      if (body) {
        stage = "answer_request";
        const response = await answerRequest(body, sql);
        stage = "save_request";
        await saveRequest(sql, body, response);
        stage = "serialize";
        return json(response);
      }
      if (id !== null) {
        stage = "load_request";
        const response = await loadRequest(sql, id);
        stage = "serialize";
        return response
          ? json(response)
          : json({ error: "request not found" }, 404);
      }
      stage = "list_requests";
      const requests = await listRequests(sql);
      stage = "list_downloads";
      const downloads = await sql.unsafe(
        `SELECT request_id, attempted_at FROM public.spe_download_log
         ORDER BY attempted_at DESC, id DESC LIMIT 100`,
        [],
      );
      stage = "serialize";
      return json({
        requests: requests.map((row) => ({
          request_id: row.request_id,
          submitted_at: row.submitted_at,
          decision: row.decision,
          articles: row.articles,
          needs_review: row.needs_review,
          status: row.needs_review ? "staff_review" : "decided",
          last_staff_action: row.last_staff_action ?? null,
          spe_schema: row.spe_schema ?? null,
        })),
        downloads: downloads.map((row) => ({
          request_id: row.request_id,
          attempted_at: row.attempted_at,
        })),
      });
    } catch (error) {
      if (error instanceof ReviewError) {
        return json({ error: error.message }, error.status);
      }
      const diagnostic = error as {
        code?: unknown;
        name?: unknown;
      } | null;
      const code = typeof diagnostic?.code === "string" &&
          /^[0-9A-Z]{5}$/.test(diagnostic.code)
        ? diagnostic.code
        : typeof diagnostic?.name === "string"
        ? diagnostic.name
        : "Error";
      console.error("requests: internal server error", { code, stage });
      return json({ error: "internal server error", code, stage }, 500);
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
