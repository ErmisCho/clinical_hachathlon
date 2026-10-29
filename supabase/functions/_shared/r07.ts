/**
 * Pure logic for request R07: inpatient stays in 2025 per region.
 *
 * Kept separate so it can be unit-tested without a database connection.
 */

/** A raw count row returned by the SQL query. */
export interface RegionCount {
  region: string;
  stay_count: number;
}

/** The formatted answer: region → count or "<10". */
export type R07Answer = Record<string, number | "<10">;

/**
 * Apply the small-cell rule: counts < 10 (including 0) become the string "<10".
 */
export function applySmallCell(n: number): number | "<10" {
  return n < 10 ? "<10" : n;
}

/**
 * Build the R07 answer object from raw DB rows.
 *
 * @param rows   Rows from the SQL query (may omit regions with 0 stays).
 * @param allRegions  Every region present in eligible_patients (so empty ones
 *                    appear in the output too).
 */
export function buildR07Answer(
  rows: RegionCount[],
  allRegions: string[],
): R07Answer {
  const countMap = new Map<string, number>();
  for (const row of rows) {
    countMap.set(row.region, row.stay_count);
  }

  const answer: R07Answer = {};
  for (const region of allRegions) {
    const n = countMap.get(region) ?? 0;
    answer[region] = applySmallCell(n);
  }
  return answer;
}

/** Fixed response envelope fields for R07. */
export const R07_DECISION = "APPROVE_STATISTICAL" as const;
export const R07_ARTICLES = ["53", "69"] as const;
export const R07_REASON =
  "Official statistics are an allowed purpose (Art. 53). Statistics answer the question (Art. 69).";

/** Full response shape returned by the edge function. */
export interface R07Response {
  request_id: "R07";
  decision: typeof R07_DECISION;
  articles: readonly ["53", "69"];
  reason: string;
  answer: R07Answer;
}

export function buildR07Response(answer: R07Answer): R07Response {
  return {
    request_id: "R07",
    decision: R07_DECISION,
    articles: R07_ARTICLES,
    reason: R07_REASON,
    answer,
  };
}
