import type { PipelineResponse } from "./pipeline.ts";

export interface RequestLogSql {
  (strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<unknown>;
  json(value: unknown): unknown;
  unsafe(
    query: string,
    params?: (string | number | boolean)[],
  ): PromiseLike<Record<string, unknown>[]>;
}

export async function saveRequest(
  sql: RequestLogSql,
  request: Record<string, unknown>,
  response: PipelineResponse,
): Promise<void> {
  // postgres.js serializes sql.json values itself; never stringify them first.
  await sql`INSERT INTO public.request_log (request_id, request, response)
    VALUES (${response.request_id}, ${sql.json(request)}, ${
    sql.json(response)
  })`;
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
    `SELECT response FROM public.request_log WHERE request_id = $1
     ORDER BY submitted_at DESC, id DESC LIMIT 1`,
    [id],
  );
  return rows.length ? responseObject(rows[0].response) : null;
}

export function listRequests(sql: RequestLogSql) {
  // Normalize legacy JSON strings in SQL so answers never enter the overview.
  return sql.unsafe(
    `SELECT request_id, submitted_at,
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
       FROM public.request_log
     ) AS history ORDER BY submitted_at DESC, id DESC`,
    [],
  );
}
