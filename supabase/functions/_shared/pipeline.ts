/**
 * End-to-end pipeline — Issue #13 (EHDS Track 3)
 *
 * answerRequest(request, sql) → full API response per docs/api.md
 *
 * Order:
 *   1. decide()         – REJECT short-circuits immediately; no patient data touched
 *   2. hold flagged requests before any patient queries or SPE creation
 *   3. parseRequest()   – parse failure returns decision + needs_review + parse_errors
 *   4a. APPROVE_STATISTICAL → runPlan()
 *   4b. APPROVE_SPE        → createSpe()
 *
 * Every executed response with a valid plan also includes:
 *   - explanation (when verifyQuotes passes; otherwise explanation_error is set)
 *   - population { eligible_patients } — count from eligible_patients view (opted-out already excluded)
 */

import { decide, type HealthDataRequest } from "./decision.ts";
import { parseRequest } from "./parser.ts";
import { runPlan, type SqlClient as EngineSqlClient } from "./engine.ts";
import { createSpe, type SqlClient as SpeSqlClient } from "./spe.ts";
import { explain, verifyQuotes } from "./explain.ts";
import type { Answer } from "./engine.ts";
import type { QueryPlan } from "./plan.ts";

/** A sql client that satisfies both engine and spe requirements. */
export type SqlClient = EngineSqlClient & SpeSqlClient;

/** Full API response shape (docs/api.md). */
export interface PipelineResponse {
  request_id: string;
  decision: "REJECT" | "APPROVE_STATISTICAL" | "APPROVE_SPE";
  articles: string[];
  reason: string;
  /** True when the purpose or definitions require human review. */
  needs_review: boolean;
  status?: "staff_review" | "decided";
  /** Non-null only after approval and successful parsing/execution. */
  answer: Answer | { cohort_size: number } | null;
  /** Present only for APPROVE_SPE. */
  spe_schema?: string;
  /** Present when parseRequest fails (needs_review is also set to true). */
  parse_errors?: { definition: string; reason: string }[];
  /** Explanation of the decision (omitted when verifyQuotes fails). */
  explanation?: {
    rule: string;
    trigger_phrases: string[];
    trigger_context: string[];
    articles: {
      number: string;
      title: string;
      summary: string;
      quote: string;
      ref: string;
    }[];
    plan_summary?: string;
  };
  /** Set when explanation could not be verified. */
  explanation_error?: string;
  /** Count of eligible patients (opted-out already excluded by the eligible_patients view). */
  population?: {
    eligible_patients: number;
  };
  /** Ordered lifecycle events attached by loadRequest; not present in freshly computed responses. */
  timeline?: { status: string; at: string }[];
  /** Last status in the timeline (e.g. "fulfilled"). Backwards-compatible addition: top-level status stays "staff_review"|"decided". */
  lifecycle_status?: string | null;
}

/** Query the count of eligible patients (opted-out rows are excluded by the view). */
async function queryPopulation(
  sql: SqlClient,
): Promise<{ eligible_patients: number }> {
  const rows = await sql.unsafe(
    "SELECT COUNT(*) AS n FROM public.eligible_patients",
    [],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return { eligible_patients: 0 };
  return { eligible_patients: Number(row["n"] ?? 0) };
}

export async function answerRequest(
  request: unknown,
  sql: SqlClient,
  /** Server-only staff instruction; never read from the applicant's JSON. */
  review?: { decision?: PipelineResponse["decision"]; reason: string },
): Promise<PipelineResponse> {
  const req = request as HealthDataRequest;
  const request_id = typeof req?.id === "string" ? req.id : "";

  // Step 1 — decide first; never touch patient data for a REJECT.
  const decisionResult = decide(req);
  if (review) {
    decisionResult.needs_review = false;
    if (review.decision) {
      decisionResult.decision = review.decision;
      decisionResult.articles = review.decision === "REJECT"
        ? ["54"]
        : review.decision === "APPROVE_SPE"
        ? ["53", "66", "68", "73"]
        : ["53", "69"];
    }
    decisionResult.reason = review.reason;
  }
  const { decision, articles, reason, needs_review } = decisionResult;

  if (decision === "REJECT" || needs_review) {
    // Explain a rejection or held decision without touching patient data.
    let explanationField: PipelineResponse["explanation"] | undefined;
    let explanation_error: string | undefined;
    try {
      const exp = explain(req, decisionResult);
      if (verifyQuotes(exp, req)) {
        explanationField = exp;
      } else {
        explanation_error = "Quote verification failed";
      }
    } catch (e) {
      explanation_error = String(e);
    }
    const base: PipelineResponse = {
      request_id,
      decision,
      articles,
      reason,
      needs_review,
      status: needs_review ? "staff_review" : "decided",
      answer: null,
    };
    if (explanationField) base.explanation = explanationField;
    if (explanation_error) base.explanation_error = explanation_error;
    return base;
  }

  // Step 2 — parse.
  const parsed = parseRequest(request);
  if (!parsed.ok) {
    // No plan; still explain the decision
    let explanationField: PipelineResponse["explanation"] | undefined;
    let explanation_error: string | undefined;
    try {
      const exp = explain(req, decisionResult);
      if (verifyQuotes(exp, req)) {
        explanationField = exp;
      } else {
        explanation_error = "Quote verification failed";
      }
    } catch (e) {
      explanation_error = String(e);
    }
    const base: PipelineResponse = {
      request_id,
      decision,
      articles,
      reason,
      needs_review: true,
      status: "staff_review",
      answer: null,
      parse_errors: parsed.errors,
    };
    if (explanationField) base.explanation = explanationField;
    if (explanation_error) base.explanation_error = explanation_error;
    return base;
  }

  const { plan } = parsed;

  // Step 3 — execute + population (both read patient data)
  let answer: Answer | { cohort_size: number };
  let spe_schema: string | undefined;
  let population: { eligible_patients: number };

  if (decision === "APPROVE_SPE") {
    const spe = await createSpe(plan as QueryPlan, sql, request_id);
    answer = { cohort_size: spe.cohort_size };
    spe_schema = spe.schema;
  } else {
    // APPROVE_STATISTICAL
    answer = await runPlan(plan as QueryPlan, sql);
  }
  population = await queryPopulation(sql);

  // Build explanation
  let explanationField: PipelineResponse["explanation"] | undefined;
  let explanation_error: string | undefined;
  try {
    const exp = explain(req, decisionResult, plan as QueryPlan);
    if (verifyQuotes(exp, req)) {
      explanationField = exp;
    } else {
      explanation_error = "Quote verification failed";
    }
  } catch (e) {
    explanation_error = String(e);
  }

  const base: PipelineResponse = {
    request_id,
    decision,
    articles,
    reason,
    needs_review,
    status: "decided",
    answer,
    population,
  };
  if (spe_schema) base.spe_schema = spe_schema;
  if (explanationField) base.explanation = explanationField;
  if (explanation_error) base.explanation_error = explanation_error;
  return base;
}
