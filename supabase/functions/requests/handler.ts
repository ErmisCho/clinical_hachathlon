import {
  readRequestJson,
  RequestInputError,
  validateRequest,
} from "../_shared/request_validation.ts";
import { answerRequest, type SqlClient } from "../_shared/pipeline.ts";
import {
  listRequests,
  listStaffActions,
  loadRequest,
  type RequestLogSql,
  saveRequest,
} from "../_shared/request_log.ts";
import { ReviewError, reviewRequest, validReview } from "./review.ts";
import { decide } from "../_shared/decision.ts";
import { parseRequest } from "../_shared/parser.ts";
import { explain } from "../_shared/explain.ts";

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
    const isPreview = req.method === "POST" && path[1] === "preview";
    const isReview = req.method === "POST" && path[1] === "review";
    if (req.method === "POST" && path[1] && !isReview && !isPreview) {
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
          : isPreview
          ? validatePreview(value)
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

    // Preview: pure computation, no SQL ever.
    if (isPreview && body) {
      return handlePreview(body);
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
      stage = "list_staff_actions";
      const staffActions = await listStaffActions(sql);
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
        staff_actions: staffActions.map((row) => ({
          request_id: row.request_id,
          action: row.action,
          decision: row.decision,
          reason: row.reason,
          staff_name: row.staff_name,
          created_at: row.created_at,
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

// ---------------------------------------------------------------------------
// Preview endpoint helpers (no SQL, no side effects)
// ---------------------------------------------------------------------------

/**
 * Validate a preview body: same rules as a full submission but id and submitted
 * are optional (we fill placeholders so parseRequest doesn't fail on them).
 */
function validatePreview(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["body must be a JSON object"];
  }
  const body = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const field of ["purpose", "question"]) {
    const text = body[field];
    if (typeof text !== "string" || !text.trim() || text.length > 8000) {
      problems.push(
        `${field} must be a non-empty string of at most 8000 characters`,
      );
    }
  }
  if (
    body.requested_as !== "health data request" &&
    body.requested_as !== "health data access application"
  ) {
    problems.push(
      `requested_as must be one of: health data request, health data access application`,
    );
  }
  if (!Array.isArray(body.definitions)) {
    problems.push("definitions must be an array of strings");
  } else {
    if (body.definitions.length > 50) {
      problems.push("definitions must contain at most 50 entries");
    }
    body.definitions.slice(0, 50).forEach((definition, index) => {
      if (
        typeof definition !== "string" || !definition.trim() ||
        definition.length > 2000
      ) {
        problems.push(
          `definitions[${index}] must be a non-empty string of at most 2000 characters`,
        );
      }
    });
  }
  return problems;
}

export interface PreviewResponse {
  decision: "REJECT" | "APPROVE_STATISTICAL" | "APPROVE_SPE";
  articles: string[];
  reason: string;
  needs_review: boolean;
  status: "staff_review" | "decided";
  rule: string;
  trigger_phrases: string[];
  plan_summary?: string;
  /** definitions that could not be parsed: [{index, definition, reason}] */
  unreadable: { index: number; definition: string; reason: string }[];
}

function handlePreview(body: Record<string, unknown>): Response {
  // Fill placeholders so parseRequest's id check passes.
  const req: Record<string, unknown> = {
    ...body,
    id: typeof body.id === "string" && body.id.trim() ? body.id : "preview",
    submitted: typeof body.submitted === "string"
      ? body.submitted
      : new Date().toISOString(),
  };

  const decisionResult = decide(req as unknown as Parameters<typeof decide>[0]);
  const { decision, articles, reason, needs_review } = decisionResult;

  // Parse to find unreadable definitions (always run, even for REJECT).
  const parsed = parseRequest(req);
  const unreadable: { index: number; definition: string; reason: string }[] =
    [];
  if (!parsed.ok) {
    const definitions = Array.isArray(body.definitions)
      ? (body.definitions as string[])
      : [];
    for (const err of parsed.errors) {
      const index = definitions.findIndex(
        (d) => typeof d === "string" && d === err.definition,
      );
      unreadable.push({
        index: index === -1 ? -1 : index,
        definition: err.definition,
        reason: err.reason,
      });
    }
  }

  // Explain (best-effort, do not fail the preview if it throws).
  let rule = "";
  let trigger_phrases: string[] = [];
  let plan_summary: string | undefined;
  try {
    const exp = explain(
      req as unknown as Parameters<typeof explain>[0],
      decisionResult,
      parsed.ok ? parsed.plan : undefined,
    );
    rule = exp.rule;
    trigger_phrases = exp.trigger_phrases;
    plan_summary = exp.plan_summary;
  } catch {
    // ignore — rule stays empty
  }

  // A preview predicts what a real submission would do: unreadable definitions
  // cause a staff-review hold just like a real parse failure does.
  const effectiveNeedsReview = needs_review || unreadable.length > 0;
  const status: "staff_review" | "decided" = effectiveNeedsReview
    ? "staff_review"
    : "decided";

  const response: PreviewResponse = {
    decision,
    articles,
    reason,
    needs_review: effectiveNeedsReview,
    status,
    rule,
    trigger_phrases,
    unreadable,
  };
  if (plan_summary !== undefined) response.plan_summary = plan_summary;
  return json(response);
}
