/**
 * watsonx.ai fallback for the rule-based parser — Issue #15 (EHDS Track 3)
 *
 * Only active when WATSONX_API_KEY, WATSONX_PROJECT_ID and WATSONX_URL are
 * all set in the function environment.  When disabled every exported function
 * is a no-op and the app behaves exactly as before.
 *
 * Safety contract (agreed 2026-10-30):
 *   - Only definition strings + the request question are sent.  No applicant
 *     data, no patient data, no database values.
 *   - An AI-assisted plan NEVER auto-approves.  The pipeline sets
 *     needs_review: true / status: staff_review so humans check the rewrite.
 *   - The LLM may only make outcomes stricter (approve → staff review, or flag
 *     a prohibited purpose).  It can never approve, relax a rejection, or
 *     change numbers.  Enforcement is in pipeline.ts, not here.
 *   - Rewrites are cached per exact request question text in llm_rewrite_cache
 *     so three-run consistency is guaranteed.
 */

import { parseRequest } from "./parser.ts";
import type { ParseResult } from "./parser.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RewriteItem {
  /** The original definition string that the parser could not consume. */
  original: string;
  /** The LLM's rewrite of that string into supported parser phrasing. */
  rewritten: string;
}

export interface AiAssist {
  used: true;
  model: string;
  rewritten: RewriteItem[];
}

export interface FallbackResult {
  /** Parsed result using rewritten definitions (already validated). */
  parsed: ParseResult;
  ai_assist: AiAssist;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** True when all three watsonx credentials are present in Deno.env. */
export function isEnabled(): boolean {
  return !!(
    Deno.env.get("WATSONX_API_KEY") &&
    Deno.env.get("WATSONX_PROJECT_ID") &&
    Deno.env.get("WATSONX_URL")
  );
}

/** Derive the (short) model identifier for audit. */
function modelId(url: string): string {
  // e.g. "ibm/granite-13b-instruct-v2" from WATSONX_URL parameter if embedded;
  // otherwise a sensible default.
  return "ibm/granite-13b-instruct-v2";
}

// IAM token cache — one token per process lifetime is enough for edge functions.
let _cachedToken: { token: string; expiry: number } | null = null;

async function getIamToken(apiKey: string): Promise<string> {
  const now = Date.now();
  if (_cachedToken && _cachedToken.expiry > now + 60_000) {
    return _cachedToken.token;
  }
  const body = new URLSearchParams({
    grant_type: "urn:ibm:params:oauth:grant-type:apikey",
    apikey: apiKey,
  });
  const res = await fetch("https://iam.cloud.ibm.com/identity/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`IAM token request failed: ${res.status}`);
  const data = await res.json() as {
    access_token: string;
    expires_in: number;
  };
  _cachedToken = {
    token: data.access_token,
    expiry: now + (data.expires_in ?? 3600) * 1000,
  };
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Supported definition patterns extracted from parser.ts grammar.
 * These are shown to the LLM so it can rewrite non-standard phrasings.
 */
const SUPPORTED_PATTERNS = `
Supported definition patterns (copy the phrasing exactly; angle brackets = fill-in):
1. <ConceptName> = aged <N> or older on 31 December 2025
2. <ConceptName> = any condition with an ICD-10 code starting with <PREFIX> [or <PREFIX>]
3. <ConceptName> = ATC code starting with <PREFIX> [or <PREFIX>]
4. <ConceptName> = sex '<female|male>'
5. Age bands on 31 December 2025: <N>-<M>[, <N>-<M>]...[, <N>+]
6. A medication is active on 31 December 2025 if start_date is on or before that day and end_date is empty or on or after that day
7. Use the latest <MeasurementName> (LOINC <code>) per patient[; patients without a <MeasurementName> are left out]
8. Cohort = <concept> who have at least one <MeasurementName> value (LOINC <code>)
9. <ConceptName> = encounter with type '<inpatient|outpatient|emergency>'
10. Count [inpatient] stays [not patients] whose <start_date is in YYYY|primary_icd10 starting with PREFIX>
11. <Numerator> = <CountPhrase> / <CountPhrase> × 100, one decimal
12. Report per <region|band|regions and age bands|hospitals|data holders>: <count phrase>[, <count phrase>]...
13. Report the size of the cohort you would make available
14. Report for each patient in <RegionName>: patient ID, birth date and date of the <condition> diagnosis
`.trim();

function buildPrompt(
  question: string,
  failingDefinitions: string[],
): string {
  const defList = failingDefinitions.map((d, i) =>
    `Definition ${i + 1}: ${d}`
  ).join("\n");
  return `You are rewriting health data request definitions into a specific grammar.

Request question (context only, do NOT include in output):
${question}

${SUPPORTED_PATTERNS}

The following definitions could not be parsed. Rewrite each one into the closest supported pattern above. Keep all numbers, codes, and names unchanged. Output ONLY a JSON array of strings, one rewritten definition per element, in the same order as the input definitions. Do not add explanations or extra text.

Definitions to rewrite:
${defList}

Output (JSON array only):`;
}

// ---------------------------------------------------------------------------
// Cache helpers — in-memory for the process lifetime (edge functions are
// short-lived); the DB cache table ensures cross-invocation consistency.
// ---------------------------------------------------------------------------

const _memCache = new Map<string, RewriteItem[]>();

/** SHA-256 hex of the exact request question text. */
async function hashQuestion(question: string): Promise<string> {
  const enc = new TextEncoder().encode(question);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

// ---------------------------------------------------------------------------
// Database cache read / write (best-effort; a failure is silently ignored)
// ---------------------------------------------------------------------------

export interface CacheSql {
  unsafe(
    text: string,
    params: (string | number | boolean)[],
  ): PromiseLike<Record<string, unknown>[]>;
}

async function readCache(
  sql: CacheSql,
  hash: string,
): Promise<RewriteItem[] | null> {
  try {
    const rows = await sql.unsafe(
      "SELECT rewrites FROM public.llm_rewrite_cache WHERE request_hash = $1",
      [hash],
    );
    if (rows.length > 0) {
      const rewrites = rows[0]["rewrites"] as RewriteItem[] | null;
      return Array.isArray(rewrites) ? rewrites : null;
    }
  } catch {
    // Silently ignore cache miss on DB error.
  }
  return null;
}

async function writeCache(
  sql: CacheSql,
  hash: string,
  rewrites: RewriteItem[],
  model: string,
): Promise<void> {
  try {
    await sql.unsafe(
      `INSERT INTO public.llm_rewrite_cache (request_hash, rewrites, model)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (request_hash) DO NOTHING`,
      [hash, JSON.stringify(rewrites), model],
    );
  } catch {
    // Best-effort only; a write failure does not break the request.
  }
}

// ---------------------------------------------------------------------------
// Core: call watsonx.ai text/generation endpoint
// ---------------------------------------------------------------------------

async function callWatsonx(
  prompt: string,
  apiKey: string,
  projectId: string,
  baseUrl: string,
): Promise<string> {
  const token = await getIamToken(apiKey);
  const url =
    `${baseUrl.replace(/\/$/, "")}/ml/v1/text/generation?version=2024-05-01`;
  const payload = {
    model_id: "ibm/granite-13b-instruct-v2",
    project_id: projectId,
    input: prompt,
    parameters: {
      decoding_method: "greedy",
      temperature: 0,
      max_new_tokens: 512,
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`watsonx generation failed: ${res.status}`);
  const data = await res.json() as {
    results?: { generated_text: string }[];
  };
  const text = data.results?.[0]?.generated_text;
  if (typeof text !== "string") throw new Error("Unexpected watsonx response shape");
  return text.trim();
}

// ---------------------------------------------------------------------------
// Parse LLM response into an array of rewrite strings
// ---------------------------------------------------------------------------

function parseGeneratedRewrites(
  generated: string,
  count: number,
): string[] | null {
  // The LLM should emit a JSON array; extract it even if there is preamble.
  const start = generated.indexOf("[");
  const end = generated.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(generated.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    if (parsed.length !== count) return null;
    if (!parsed.every((s) => typeof s === "string")) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Attempt a watsonx-assisted re-parse of a request whose rule-based parse
 * failed.  Returns null when:
 *   - the module is disabled (no credentials)
 *   - all definition errors come from structural issues, not unparseable text
 *   - the LLM output cannot be parsed or still fails validation
 *   - any network/timeout error occurs
 *
 * The sql parameter is optional — when absent the DB cache is skipped.
 */
export async function attemptFallback(
  request: Record<string, unknown>,
  parseErrors: { definition: string; reason: string }[],
  sql?: CacheSql,
): Promise<FallbackResult | null> {
  if (!isEnabled()) return null;

  const apiKey = Deno.env.get("WATSONX_API_KEY")!;
  const projectId = Deno.env.get("WATSONX_PROJECT_ID")!;
  const baseUrl = Deno.env.get("WATSONX_URL")!;
  const model = modelId(baseUrl);

  // Only rewrite concept definitions (those that name a new term) that the
  // grammar does not recognise.  Cascaded errors on report/count clauses are
  // skipped — they will resolve automatically once the concept is rewritten.
  // Structural errors (missing id, etc.) are also excluded.
  const allDefinitions = Array.isArray(request.definitions)
    ? (request.definitions as string[])
    : [];
  // Report/count clauses start with these prefixes and cannot be meaningfully
  // rewritten by the LLM; their failures are always cascaded from a missing concept.
  const DERIVED_PREFIXES = /^(?:report |count |use the latest |cohort = )/i;
  const failingDefs = parseErrors
    .map((e) => e.definition)
    .filter((d) => allDefinitions.includes(d) && !DERIVED_PREFIXES.test(d));
  if (failingDefs.length === 0) return null;

  const question = typeof request.question === "string" ? request.question : "";
  const hash = await hashQuestion(question + "\x00" + failingDefs.join("\x00"));

  // In-memory cache hit
  if (_memCache.has(hash)) {
    const cached = _memCache.get(hash)!;
    const rewritten = applyRewrites(request, failingDefs, cached);
    const parsed = parseRequest(rewritten);
    if (parsed.ok) {
      return { parsed, ai_assist: { used: true, model, rewritten: cached } };
    }
    return null;
  }

  // DB cache hit
  if (sql) {
    const cached = await readCache(sql, hash);
    if (cached !== null) {
      _memCache.set(hash, cached);
      const rewritten = applyRewrites(request, failingDefs, cached);
      const parsed = parseRequest(rewritten);
      if (parsed.ok) {
        return { parsed, ai_assist: { used: true, model, rewritten: cached } };
      }
      return null;
    }
  }

  // Call watsonx
  let rewriteStrings: string[];
  try {
    const prompt = buildPrompt(question, failingDefs);
    const generated = await callWatsonx(prompt, apiKey, projectId, baseUrl);
    const parsed = parseGeneratedRewrites(generated, failingDefs.length);
    if (!parsed) return null;
    rewriteStrings = parsed;
  } catch {
    // Any error (timeout, network, parse) → behave as today (no fallback).
    return null;
  }

  const rewriteItems: RewriteItem[] = failingDefs.map((orig, i) => ({
    original: orig,
    rewritten: rewriteStrings[i],
  }));

  // Re-parse with rewritten definitions
  const rewrittenRequest = applyRewrites(request, failingDefs, rewriteItems);
  const parsed = parseRequest(rewrittenRequest);
  if (!parsed.ok) {
    // Invalid rewrite — ignore, behave as today
    return null;
  }

  // Cache the valid rewrites
  _memCache.set(hash, rewriteItems);
  if (sql) {
    await writeCache(sql, hash, rewriteItems, model);
  }

  return { parsed, ai_assist: { used: true, model, rewritten: rewriteItems } };
}

// ---------------------------------------------------------------------------
// Internal: build a new request object with failing definitions replaced
// ---------------------------------------------------------------------------

function applyRewrites(
  request: Record<string, unknown>,
  failingDefs: string[],
  rewrites: RewriteItem[],
): Record<string, unknown> {
  const definitions = Array.isArray(request.definitions)
    ? [...(request.definitions as string[])]
    : [];
  for (const item of rewrites) {
    const idx = definitions.indexOf(item.original);
    if (idx !== -1) {
      definitions[idx] = item.rewritten;
    }
  }
  return { ...request, definitions };
}

/** Exposed for testing: reset in-memory cache between test cases. */
export function _resetMemCache(): void {
  _memCache.clear();
  _cachedToken = null;
}
