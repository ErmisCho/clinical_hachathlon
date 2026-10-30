import type { HdabConfig } from "../_shared/hdab/config.ts";
import {
  answerRequest,
  type PipelineResponse,
  type SqlClient,
} from "../_shared/pipeline.ts";
import {
  loadEventsForLog,
  recordReviewEvents,
  type RequestLogSql,
} from "../_shared/request_log.ts";

/** The body sent by the client – no staff identity fields. */
export interface StaffReviewBody {
  action: "approve" | "override";
  request_id: string;
  decision?: PipelineResponse["decision"];
  reason: string;
}

/** Server-side type: body plus identity injected from the verified Auth token. */
export interface StaffReview extends StaffReviewBody {
  /** Set server-side from the verified Auth token; not accepted from the client body. */
  staff_name: string;
  /** UUID from Supabase Auth; set server-side. */
  staff_user_id: string;
}

/** Staff controls are accepted only on the review route, never from a submission. */
export function validReview(value: unknown): value is StaffReviewBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return (body.action === "approve" || body.action === "override") &&
    typeof body.request_id === "string" &&
    /^[A-Za-z0-9_]{1,59}$/.test(body.request_id) &&
    typeof body.reason === "string" && body.reason.trim().length > 0 &&
    body.reason.length <= 8000 &&
    (body.action === "approve"
      ? body.decision === undefined
      : typeof body.decision === "string" &&
        ["REJECT", "APPROVE_STATISTICAL", "APPROVE_SPE"].includes(
          body.decision,
        ));
}

export class ReviewError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function object(value: unknown): Record<string, unknown> {
  const result = typeof value === "string" ? JSON.parse(value) : value;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Invalid saved request");
  }
  return result as Record<string, unknown>;
}

/** Called inside one transaction: lock, execute, update, and audit atomically. */
export async function reviewRequest(
  tx: RequestLogSql & SqlClient,
  review: StaffReview,
  hdab?: HdabConfig,
): Promise<PipelineResponse> {
  // Both staff_name and staff_user_id must be set by the caller (handler.ts) from
  // the verified Auth token.  Guard here so a programming error is caught early.
  if (!review.staff_name || !review.staff_user_id) {
    throw new ReviewError(500, "Staff identity not provided");
  }
  const rows = await tx.unsafe(
    `SELECT id, request, response FROM public.request_log WHERE request_id = $1
     ORDER BY submitted_at DESC, id DESC LIMIT 1 FOR UPDATE`,
    [review.request_id],
  );
  if (!rows.length) throw new ReviewError(404, "request not found");
  const row = rows[0];
  const saved = object(row.response);
  if (
    review.action === "approve" &&
    (saved.needs_review !== true || saved.decision === "REJECT")
  ) {
    throw new ReviewError(
      409,
      "request is not awaiting approval; use override to change a decision",
    );
  }
  const request = object(row.request);
  // The persisted id is authoritative, including for legacy JSON-string bodies.
  request.id = review.request_id;
  // createSpe uses begin internally; reuse this transaction rather than nesting BEGIN.
  const pipelineSql: SqlClient = {
    unsafe: (query, params) => tx.unsafe(query, params),
    begin: (fn) => fn(pipelineSql),
  };
  const response = await answerRequest(request, pipelineSql, {
    decision: review.decision,
    reason: review.reason,
  }, hdab);
  await tx`UPDATE public.request_log SET response = ${tx.json(response)}
    WHERE id = ${row.id}`;
  await tx`INSERT INTO public.staff_action
    (request_id, request_log_id, action, decision, reason, staff_name, staff_user_id)
    VALUES (${review.request_id}, ${row.id}, ${review.action}, ${response.decision},
            ${review.reason}, ${review.staff_name}, ${review.staff_user_id})`;
  // Load prior events then append new ones — gives full timeline in the review response.
  const priorEvents = await loadEventsForLog(tx, row.id);
  const newEvents = await recordReviewEvents(
    tx,
    row.id,
    review.request_id,
    response,
  );
  const timeline = [...priorEvents, ...newEvents];
  const lifecycle_status = timeline[timeline.length - 1]?.status ?? null;
  return { ...response, timeline, lifecycle_status };
}
