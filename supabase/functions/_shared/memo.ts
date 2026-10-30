/**
 * Legal reasoning memo — Issue #35 (EHDS Track 3)
 *
 * draftMemo(purpose, question, decision, articles, articleTexts) → MemoResult | null
 *
 * Calls the configured LLM (temperature 0) to draft a short (~150 word) reasoned decision
 * memo that quotes verbatim paragraphs of Regulation (EU) 2025/327 Chapter IV.
 *
 * Safety contract:
 *   - Only purpose, question, decision, article refs and their STORED texts are
 *     sent. Patient data, applicant name, definitions and answers are never sent.
 *   - The memo NEVER changes the decision/articles/numbers; the deterministic
 *     engine decides; the memo only explains.
 *   - Every quoted span is verified verbatim against the stored regulation text
 *     before the memo is returned. A memo with any unverifiable quote is dropped
 *     and memo_status is set to "rejected_unverified_quote".
 *   - The feature is fully disabled when OPENROUTER_API_KEY is absent; callers
 *     receive null and the app behaves exactly as before.
 *
 * Reuses: isEnabled() / chatComplete() / llmConfig() from llm_fallback.ts
 */

import { chatComplete, isEnabled, llmConfig } from "./llm_fallback.ts";
import REG from "./regulation/reg_2025_327.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MemoQuote {
  /** The verbatim quoted text, exactly as it appears in the regulation. */
  text: string;
  /** Article reference, e.g. "Art. 53(1)" */
  ref: string;
}

export interface MemoResult {
  /** The full drafted memo text (≤ ~150 words). */
  text: string;
  /** All verified quoted spans extracted from the memo text. */
  quotes: MemoQuote[];
  /** The LLM model identifier used. */
  model: string;
}

export type MemoStatus =
  | "ok"
  | "rejected_unverified_quote"
  | "disabled"
  | "error";

export interface DraftMemoOutcome {
  memo?: MemoResult;
  memo_status: MemoStatus;
}

// ---------------------------------------------------------------------------
// Helpers: regulation text lookup
// ---------------------------------------------------------------------------

type RegData = typeof REG;

/** Concatenate all paragraph texts for an article. */
function allArticleText(artNum: string): string {
  const art = (REG as RegData).articles[artNum as keyof typeof REG.articles];
  if (!art) return "";
  return art.paragraphs.map((p) => p.text).join(" ");
}

/** Build a map from article number → full concatenated text. */
function buildArticleTextMap(articles: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const num of articles) {
    const text = allArticleText(num);
    if (text) map[num] = text;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Whitespace normalisation
// ---------------------------------------------------------------------------

function normalise(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Quote extraction and verification
// ---------------------------------------------------------------------------

/**
 * Extract every double-quoted span from memoText and return them.
 * A span is delimited by straight or curly double-quote pairs.
 */
function extractQuotedSpans(memoText: string): string[] {
  const spans: string[] = [];
  // Match "..." (straight) and \u201C...\u201D (curly) double-quotes
  const re = /[""]([^""]+)[""]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(memoText)) !== null) {
    const span = m[1].trim();
    if (span.length > 0) spans.push(span);
  }
  return spans;
}

/**
 * For each extracted span, find the first article whose stored text contains it
 * (verbatim, whitespace-normalised). Returns null if any span cannot be
 * verified against any of the articles' stored texts.
 */
function verifyAndAnnotateQuotes(
  spans: string[],
  articleTexts: Record<string, string>,
  articleRefs: Record<string, string>,
): MemoQuote[] | null {
  const quotes: MemoQuote[] = [];
  for (const span of spans) {
    const normSpan = normalise(span);
    let matched = false;
    for (const [artNum, fullText] of Object.entries(articleTexts)) {
      if (normalise(fullText).includes(normSpan)) {
        quotes.push({ text: span, ref: articleRefs[artNum] ?? `Art. ${artNum}` });
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Span is not verbatim in any cited article → reject the whole memo
      return null;
    }
  }
  return quotes;
}

// ---------------------------------------------------------------------------
// Per-request in-memory memo cache
// ---------------------------------------------------------------------------

const _memoCache = new Map<string, MemoResult | "rejected_unverified_quote">();

async function hashMemoKey(
  purpose: string,
  question: string,
  decision: string,
  articles: string[],
): Promise<string> {
  const raw = [purpose, question, decision, ...articles.sort()].join("\x00");
  const enc = new TextEncoder().encode(raw);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildMemoPrompt(
  purpose: string,
  question: string,
  decision: string,
  articleTexts: Record<string, string>,
  articleRefs: Record<string, string>,
): string {
  const articleList = Object.entries(articleTexts)
    .map(([num, text]) => {
      const ref = articleRefs[num] ?? `Art. ${num}`;
      return `--- ${ref} ---\n${text}`;
    })
    .join("\n\n");

  return `You are drafting a short legal reasoning memo for a Health Data Access Body decision.

Decision: ${decision}
Purpose: ${purpose}
Research question: ${question}

The following are the ONLY regulation texts you may quote. Every quotation in the memo must be verbatim from one of these texts. Enclose each quotation in double quotation marks.

${articleList}

Draft a concise reasoned memo (maximum 150 words) that explains this decision by citing the relevant paragraphs. Use "double quotes" for every verbatim quotation from the regulation. Do not invent any legal text; only quote from the texts above. Do not mention applicant names, patient data, or statistics.

Memo:`;
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Draft a legal reasoning memo grounded in the stored regulation text.
 *
 * @param purpose   - The request's stated purpose (no patient data)
 * @param question  - The research question (no patient data)
 * @param decision  - The pipeline decision string (e.g. "REJECT")
 * @param articles  - Article numbers cited by the decision (e.g. ["53","54"])
 * @param articleRefs - Human-readable refs, e.g. { "53": "Art. 53(1)" }
 *
 * Returns null when disabled (no credentials) or on any error.
 * Returns DraftMemoOutcome with memo_status "rejected_unverified_quote" when a
 * fabricated quote is detected.
 */
export async function draftMemo(
  purpose: string,
  question: string,
  decision: string,
  articles: string[],
  articleRefs: Record<string, string> = {},
): Promise<DraftMemoOutcome | null> {
  if (!isEnabled()) return null;

  // Build regulation text map — only cited articles, from stored JSON
  const articleTexts = buildArticleTextMap(articles);
  if (Object.keys(articleTexts).length === 0) return null;

  // Fill in any missing refs with a default
  const refs: Record<string, string> = {};
  for (const num of articles) {
    refs[num] = articleRefs[num] ?? `Art. ${num}`;
  }

  // Cache key
  const cacheKey = await hashMemoKey(purpose, question, decision, articles);
  const cached = _memoCache.get(cacheKey);
  if (cached !== undefined) {
    if (cached === "rejected_unverified_quote") {
      return { memo_status: "rejected_unverified_quote" };
    }
    return { memo: cached, memo_status: "ok" };
  }

  // Call the LLM
  let memoText: string;
  try {
    const prompt = buildMemoPrompt(purpose, question, decision, articleTexts, refs);
    memoText = await chatComplete(prompt, 300, 12000);
  } catch {
    // Any network/timeout error → feature is silent
    return null;
  }

  // Extract and verify all quoted spans
  const spans = extractQuotedSpans(memoText);
  const verifiedQuotes = verifyAndAnnotateQuotes(spans, articleTexts, refs);

  if (verifiedQuotes === null) {
    // Fabricated or unverifiable quote detected → reject the memo
    _memoCache.set(cacheKey, "rejected_unverified_quote");
    return { memo_status: "rejected_unverified_quote" };
  }

  const result: MemoResult = {
    text: memoText,
    quotes: verifiedQuotes,
    model: llmConfig()!.model,
  };
  _memoCache.set(cacheKey, result);
  return { memo: result, memo_status: "ok" };
}

/** Exposed for testing: reset in-memory memo cache between test cases. */
export function _resetMemoCache(): void {
  _memoCache.clear();
}
