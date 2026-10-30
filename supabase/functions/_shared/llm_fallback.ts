/**
 * LLM fallback for the rule-based parser — Issue #15, provider switched in #94
 *
 * Calls an OpenAI-compatible /chat/completions endpoint (default: OpenRouter,
 * Mistral Small 3.2, an EU provider).  Only active when OPENROUTER_API_KEY is
 * set in the function environment.  When disabled every exported function
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

/** Endpoint settings, or null when OPENROUTER_API_KEY is absent (AI features off). */
export function llmConfig(): { apiKey: string; baseUrl: string; model: string } | null {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (Deno.env.get("LLM_BASE_URL") || "https://openrouter.ai/api/v1").replace(/\/$/, ""),
    model: Deno.env.get("LLM_MODEL") || "mistralai/mistral-small-3.2-24b-instruct",
  };
}

/** True when the LLM endpoint is configured. */
export function isEnabled(): boolean {
  return llmConfig() !== null;
}

/** One deterministic chat completion; throws on any HTTP or shape error. */
export async function chatComplete(
  prompt: string,
  maxTokens: number,
  timeoutMs: number,
): Promise<string> {
  const cfg = llmConfig();
  if (!cfg) throw new Error("LLM disabled");
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "EHDS Access Desk",
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`LLM request failed: ${res.status}`);
  const data = await res.json() as {
    choices?: { message?: { content?: unknown } }[];
  };
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("Unexpected LLM response shape");
  return text.trim();
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
 * Attempt an LLM-assisted re-parse of a request whose rule-based parse
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

  const model = llmConfig()!.model;

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

  // Call the LLM
  let rewriteStrings: string[];
  try {
    const prompt = buildPrompt(question, failingDefs);
    const generated = await chatComplete(prompt, 512, 12000);
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
}
