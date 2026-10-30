import type { PipelineResponse } from "./pipeline.ts";

export interface RequestLogSql {
  (strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<unknown>;
  json(value: unknown): unknown;
  unsafe(
    query: string,
    params?: (string | number | boolean)[],
  ): PromiseLike<Record<string, unknown>[]>;
}

/** A single lifecycle status change with an ISO 8601 server timestamp. */
export interface TimelineEvent {
  status: "submitted" | "assessed" | "staff_review" | "decided" | "fulfilled";
  at: string;
}

/**
 * Compute the ordered list of lifecycle statuses for a freshly computed response.
 * Mirrors the logic in recordEvents.
 */
export function submissionStatuses(
  response: Pick<PipelineResponse, "needs_review" | "decision">,
): TimelineEvent["status"][] {
  const statuses: TimelineEvent["status"][] = ["submitted", "assessed"];
  if (response.needs_review && response.decision !== "REJECT") {
    statuses.push("staff_review");
  } else if (response.decision !== "REJECT") {
    statuses.push("decided", "fulfilled");
  } else {
    statuses.push("decided");
  }
  return statuses;
}

/**
 * Compute the ordered list of lifecycle statuses after a staff review.
 * Mirrors the logic in recordReviewEvents.
 */
export function reviewStatuses(
  response: Pick<PipelineResponse, "needs_review" | "decision">,
): TimelineEvent["status"][] {
  if (!response.needs_review) {
    return response.decision !== "REJECT"
      ? ["decided", "fulfilled"]
      : ["decided"];
  }
  return ["staff_review"];
}

/**
 * Insert lifecycle events for a new submission and return them with real DB timestamps.
 *
 * Always: submitted + assessed.
 * Then:
 *   - held (needs_review true, decision != REJECT): staff_review
 *   - not held + decision != REJECT: decided + fulfilled
 *   - not held + decision == REJECT: decided (no fulfilled)
 */
export async function recordEvents(
  sql: RequestLogSql,
  logId: unknown,
  requestId: string,
  response: PipelineResponse,
): Promise<TimelineEvent[]> {
  const timeline: TimelineEvent[] = [];
  for (const status of submissionStatuses(response)) {
    const rows = await sql.unsafe(
      `INSERT INTO public.request_event (request_log_id, request_id, status)
       VALUES ($1, $2, $3)
       RETURNING to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`,
      [String(logId), requestId, status],
    );
    timeline.push({
      status,
      at: String((rows[0] as Record<string, unknown>)?.at ?? ""),
    });
  }
  return timeline;
}

/**
 * Insert lifecycle events after a staff review and return them with real DB timestamps.
 *
 * - Still held (parse failure survived review): staff_review
 * - Decided + not REJECT: decided + fulfilled
 * - Decided + REJECT: decided only
 */
export async function recordReviewEvents(
  sql: RequestLogSql,
  logId: unknown,
  requestId: string,
  response: PipelineResponse,
): Promise<TimelineEvent[]> {
  const newEvents: TimelineEvent[] = [];
  for (const status of reviewStatuses(response)) {
    const rows = await sql.unsafe(
      `INSERT INTO public.request_event (request_log_id, request_id, status)
       VALUES ($1, $2, $3)
       RETURNING to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`,
      [String(logId), requestId, status],
    );
    newEvents.push({
      status,
      at: String((rows[0] as Record<string, unknown>)?.at ?? ""),
    });
  }
  return newEvents;
}

/**
 * Load all existing events for a given log row, ordered chronologically.
 */
export async function loadEventsForLog(
  sql: RequestLogSql,
  logId: unknown,
): Promise<TimelineEvent[]> {
  const events = await sql.unsafe(
    `SELECT status,
            to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
     FROM public.request_event
     WHERE request_log_id = $1
     ORDER BY at ASC, id ASC`,
    [String(logId)],
  );
  return events.map((row) => ({
    status: row.status as TimelineEvent["status"],
    at: String(row.at ?? ""),
  }));
}

export async function saveRequest(
  sql: RequestLogSql,
  request: Record<string, unknown>,
  response: PipelineResponse,
): Promise<{ logId: unknown }> {
  // postgres.js serializes sql.json values itself; never stringify them first.
  await sql`INSERT INTO public.request_log (request_id, request, response)
    VALUES (${response.request_id}, ${sql.json(request)}, ${sql.json(response)})`;
  // Retrieve the id of the row just inserted (latest for this request_id).
  const idRows = await sql.unsafe(
    `SELECT id FROM public.request_log WHERE request_id = $1
     ORDER BY submitted_at DESC, id DESC LIMIT 1`,
    [response.request_id],
  );
  const logId = (idRows[0] as Record<string, unknown> | undefined)?.id ?? 0;
  return { logId };
}

function responseObject(value: unknown): Record<string, unknown> {
  // Support submissions written before the JSONB serialization fix.
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid saved response");
  }
  return parsed as Record<string, unknown>;
}

export async function loadRequest(
  sql: RequestLogSql,
  id: string,
): Promise<Record<string, unknown> | null> {
  const rows = await sql.unsafe(
    `SELECT id, response FROM public.request_log WHERE request_id = $1
     ORDER BY submitted_at DESC, id DESC LIMIT 1`,
    [id],
  );
  if (!rows.length) return null;
  const logId = (rows[0] as Record<string, unknown>).id;
  const response = responseObject(rows[0].response);
  const timeline = await loadEventsForLog(sql, logId);
  if (timeline.length > 0) {
    response.timeline = timeline;
    response.lifecycle_status = timeline[timeline.length - 1].status;
  }
  return response;
}

export function listStaffActions(sql: RequestLogSql) {
  return sql.unsafe(
    `SELECT request_id, action, decision, reason, staff_name, created_at
     FROM public.staff_action
     ORDER BY created_at DESC, id DESC
     LIMIT 100`,
    [],
  );
}

export function listRequests(sql: RequestLogSql) {
  // Reserve space for held submissions before filling with recent decisions.
  // Only legacy strings need decoding to inspect needs_review; normalize and
  // project the full overview fields after selecting the history window.
  return sql.unsafe(
    `WITH held AS MATERIALIZED (
       SELECT id, request_id, submitted_at, response
       FROM public.request_log
       WHERE CASE WHEN jsonb_typeof(response) = 'string'
                  THEN (response #>> '{}')::jsonb->'needs_review'
                  ELSE response->'needs_review' END = 'true'::jsonb
     ), recent AS MATERIALIZED (
       SELECT id, request_id, submitted_at, response
       FROM public.request_log
       WHERE id NOT IN (SELECT id FROM held)
       ORDER BY submitted_at DESC, id DESC
       LIMIT GREATEST(0, 100 - (SELECT COUNT(*) FROM held))
     ), selected AS MATERIALIZED (
       SELECT id, request_id, submitted_at, response FROM held
       UNION ALL
       SELECT id, request_id, submitted_at, response FROM recent
     )
     SELECT request_id, submitted_at,
            result->>'decision' AS decision,
            result->'articles' AS articles,
            result->'needs_review' AS needs_review,
            result->>'spe_schema' AS spe_schema,
            CASE WHEN result->'needs_review' = 'true'::jsonb
                 THEN 'staff_review' ELSE 'decided' END AS status,
            (SELECT jsonb_build_object(
               'id', a.id, 'request_id', a.request_id, 'action', a.action,
               'decision', a.decision, 'reason', a.reason,
               'staff_name', a.staff_name, 'created_at', a.created_at)
             FROM public.staff_action a WHERE a.request_log_id = history.id
             ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS last_staff_action
     FROM (
       SELECT id, request_id, submitted_at,
              CASE WHEN jsonb_typeof(response) = 'string'
                   THEN (response #>> '{}')::jsonb
                   ELSE response END AS result
       FROM selected
     ) AS history ORDER BY submitted_at DESC, id DESC`,
    [],
  );
}
