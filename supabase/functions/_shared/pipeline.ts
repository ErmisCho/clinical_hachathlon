/**
 * End-to-end pipeline — Issue #13 (EHDS Track 3)
 *
 * answerRequest(request, sql) → full API response per docs/api.md
 *
 * Order:
 *   1. decide()         – REJECT short-circuits immediately; no patient data touched
 *   2. parseRequest()   – parse failure returns decision + needs_review + parse_errors
 *   3a. APPROVE_STATISTICAL → runPlan()
 *   3b. APPROVE_SPE        → createSpe()
 */

import { decide, type HealthDataRequest } from "./decision.ts";
import { parseRequest } from "./parser.ts";
import { runPlan, type SqlClient as EngineSqlClient } from "./engine.ts";
import { createSpe, type SqlClient as SpeSqlClient } from "./spe.ts";
import type { Answer } from "./engine.ts";

/** A sql client that satisfies both engine and spe requirements. */
export type SqlClient = EngineSqlClient & SpeSqlClient;

/** Full API response shape (docs/api.md). */
export interface PipelineResponse {
  request_id: string;
  decision: "REJECT" | "APPROVE_STATISTICAL" | "APPROVE_SPE";
  articles: string[];
  reason: string;
  /** True when the decision requires human review (edge-case purpose). */
  needs_review: boolean;
  /** Present and non-null only for APPROVE_STATISTICAL and APPROVE_SPE. */
  answer: Answer | { cohort_size: number } | null;
  /** Present only for APPROVE_SPE. */
  spe_schema?: string;
  /** Present when parseRequest fails (needs_review is also set to true). */
  parse_errors?: { definition: string; reason: string }[];
}

export async function answerRequest(
  request: unknown,
  sql: SqlClient,
): Promise<PipelineResponse> {
  const req = request as HealthDataRequest;
  const request_id = typeof req?.id === "string" ? req.id : "";

  // Step 1 — decide first; never touch patient data for a REJECT.
  const { decision, articles, reason, needs_review } = decide(req);

  if (decision === "REJECT") {
    return { request_id, decision, articles, reason, needs_review, answer: null };
  }

  // Step 2 — parse.
  const parsed = parseRequest(request);
  if (!parsed.ok) {
    return {
      request_id,
      decision,
      articles,
      reason,
      needs_review: true,
      answer: null,
      parse_errors: parsed.errors,
    };
  }

  const { plan } = parsed;

  // Step 3 — execute.
  if (decision === "APPROVE_SPE") {
    const { schema, cohort_size } = await createSpe(plan, sql, request_id);
    return {
      request_id,
      decision,
      articles,
      reason,
      needs_review,
      answer: { cohort_size },
      spe_schema: schema,
    };
  }

  // APPROVE_STATISTICAL
  const answer = await runPlan(plan, sql);
  return { request_id, decision, articles, reason, needs_review, answer };
}
