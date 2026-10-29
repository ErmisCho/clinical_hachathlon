/**
 * Explanation module – Issue #33 (EHDS Track 3)
 *
 * explain(request, decisionResult, plan?) → ExplanationResult
 *
 * Produces:
 *   - rule: plain-language rule name
 *   - trigger_phrases: EXACT substrings of request purpose/question
 *   - articles: [{number, title, summary, quote, ref}]
 *   - plan_summary? (for approved requests with a query plan)
 *
 * verifyQuotes(explanation, request) → boolean
 *   Returns true when every quote is a verbatim (whitespace-normalised)
 *   substring of the stored regulation text AND every trigger_phrase is a
 *   verbatim substring of the request purpose+question.
 */

import type { DecisionResult, HealthDataRequest } from "./decision.ts";
import type { QueryPlan } from "./plan.ts";
import REG from "./regulation/reg_2025_327.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArticleExplanation {
  number: string;
  title: string;
  /** One plain-language sentence. */
  summary: string;
  /** Verbatim paragraph text from reg_2025_327.json. */
  quote: string;
  /** Article + paragraph reference, e.g. "Art. 54(1)". */
  ref: string;
}

export interface ExplanationResult {
  /** Plain-language name for the rule that fired, e.g. "Prohibited purpose (Art. 54)". */
  rule: string;
  /**
   * EXACT substrings of purpose/question (verbatim, no ellipses) that triggered
   * the decision. Safe to check with String.prototype.includes().
   */
  trigger_phrases: string[];
  /**
   * Display-friendly context windows (with "…" markers) parallel to
   * trigger_phrases. May contain ellipses; not used in verbatim checks.
   */
  trigger_context: string[];
  articles: ArticleExplanation[];
  /** Only present for approved requests with a valid query plan. */
  plan_summary?: string;
}

// ---------------------------------------------------------------------------
// Regulation text helpers
// ---------------------------------------------------------------------------

type RegData = typeof REG;

/** Return the full text of a paragraph by article number and ref. */
function paraText(artNum: string, ref: string): string {
  const art = (REG as RegData).articles[artNum as keyof typeof REG.articles];
  if (!art) return "";
  const para = art.paragraphs.find((p) => p.ref === ref);
  return para?.text ?? "";
}

/** Return the full text of a paragraph by article number (first paragraph). */
function firstParaText(artNum: string): string {
  const art = (REG as RegData).articles[artNum as keyof typeof REG.articles];
  if (!art) return "";
  return art.paragraphs[0]?.text ?? "";
}

/** Return the title of an article. */
function artTitle(artNum: string): string {
  const art = (REG as RegData).articles[artNum as keyof typeof REG.articles];
  return art?.title ?? "";
}

// ---------------------------------------------------------------------------
// Whitespace normalisation for verbatim checks
// ---------------------------------------------------------------------------

function normalise(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Article summaries (one plain-language line each)
// ---------------------------------------------------------------------------

const SUMMARIES: Record<string, string> = {
  "53":
    "Lists the allowed purposes for accessing health data for secondary use, including research, statistics, education, and quality improvement.",
  "54":
    "Prohibits using health data for insurance decisions, advertising, harmful products, employee profiling, or third-party sharing outside the permit.",
  "66":
    "Requires that only the minimum necessary data be provided, in anonymised form unless pseudonymised data is justified.",
  "67":
    "Sets out what an applicant must include in a health data access application, including purpose, data description, and justification.",
  "68":
    "Governs the issuing of data permits: the access body assesses the application and may grant a time-limited permit for secure access.",
  "69":
    "Allows applicants to request anonymised statistical answers (a \u2018health data request\u2019) without needing a full data permit.",
  "71":
    "Gives individuals the right to opt out of having their health data used for secondary purposes at any time.",
  "73":
    "Requires that pseudonymised data be accessed only through a secure processing environment managed by the access body.",
};

// ---------------------------------------------------------------------------
// Plan summary generator
// ---------------------------------------------------------------------------

function describePlan(plan: QueryPlan): string {
  const parts: string[] = [];

  // Cohort filters
  const filters = plan.cohort_filters;
  const ageFilt = filters.find((f) => f.type === "age");
  const condFilt = filters.find((f) => f.type === "has_condition");
  const medFilt = filters.find((f) => f.type === "has_medication");
  const sexFilt = filters.find((f) => f.type === "sex");
  const regionFilt = filters.find((f) => f.type === "region");
  const obsFilt = filters.find((f) => f.type === "has_observation");
  const encFilt = filters.find((f) => f.type === "encounter_filter");

  if (encFilt && encFilt.type === "encounter_filter") {
    const t = encFilt.encounter_type ?? "any";
    const y = encFilt.start_year ? ` in ${encFilt.start_year}` : "";
    const dx = encFilt.primary_icd10_prefix
      ? ` with primary ICD-10 ${encFilt.primary_icd10_prefix}`
      : "";
    parts.push(`${t} encounters${y}${dx}`);
  } else {
    const cohortParts: string[] = [];
    if (sexFilt && sexFilt.type === "sex") cohortParts.push(sexFilt.value === "female" ? "female patients" : "male patients");
    else cohortParts.push("patients");

    if (ageFilt && ageFilt.type === "age") {
      const min = ageFilt.min_age;
      const max = ageFilt.max_age;
      if (max === undefined) cohortParts.push(`aged ${min}+ on 31 Dec 2025`);
      else cohortParts.push(`aged ${min}–${max} on 31 Dec 2025`);
    }
    if (condFilt && condFilt.type === "has_condition") {
      cohortParts.push(`with an ICD-10 code starting ${condFilt.icd10_prefixes.join(" or ")}`);
    }
    if (medFilt && medFilt.type === "has_medication") {
      const neg = medFilt.negate ? "without" : "with";
      cohortParts.push(`${neg} an active ATC code ${medFilt.atc_prefixes.join(" or ")} on 31 Dec 2025`);
    }
    if (obsFilt && obsFilt.type === "has_observation") {
      cohortParts.push(`with at least one observation (LOINC ${obsFilt.loinc})`);
    }
    if (regionFilt && regionFilt.type === "region") {
      cohortParts.push(`in ${regionFilt.value}`);
    }
    parts.push(cohortParts.join(", "));
  }

  // Count unit
  const unit = plan.count_unit === "encounter" ? "encounters" : "patients";

  // Dimensions
  const dims = plan.dimensions ?? [];
  const dimDescs = dims.map((d): string => {
    if (d.by === "region") return "region";
    if (d.by === "data_holder") return "hospital";
    if (d.by === "age_band") {
      const bands = d.bands.map((b) => b.label).join(", ");
      return `age band (${bands})`;
    }
    return (d as { by: string }).by;
  });

  // Metrics
  const metricDescs = plan.metrics.map((m): string => {
    if (m.type === "count") return `count of ${unit} (${m.label})`;
    if (m.type === "percentage") return `${m.label} as a percentage`;
    if (m.type === "mean_observation") return `mean ${m.loinc} (${m.label})`;
    return (m as { label: string }).label;
  });

  let summary = `${parts.join("; ")}`;
  if (dimDescs.length > 0) {
    summary += `; counted per ${dimDescs.join(" × ")}`;
  }
  summary += `; metrics: ${metricDescs.join(", ")}`;

  // SPE record types
  if (plan.spe_record_types && plan.spe_record_types.length > 0) {
    summary += `; pseudonymised ${plan.spe_record_types.join(", ")} records copied to secure environment`;
  }

  return summary.charAt(0).toUpperCase() + summary.slice(1);
}

// ---------------------------------------------------------------------------
// Main explain function
// ---------------------------------------------------------------------------

export function explain(
  request: HealthDataRequest,
  decisionResult: DecisionResult,
  plan?: QueryPlan,
): ExplanationResult {
  const { decision, articles, matched } = decisionResult;

  // trigger_phrases = exact regex matches (no ellipses); trigger_context = display snippets
  const trigger_phrases = matched.filter((s) => s.length > 0);
  const trigger_context = (decisionResult.matched_context ?? []).filter(
    (s) => s.length > 0,
  );

  // Build the rule name
  let rule: string;
  if (decision === "REJECT") {
    rule = "Prohibited purpose (Art. 54)";
  } else if (decision === "APPROVE_SPE") {
    rule = "Approved for pseudonymised access – secure processing environment (Art. 53, 66, 68, 73)";
  } else {
    // APPROVE_STATISTICAL
    if (articles.includes("66")) {
      rule = "Approved for anonymised statistics – access application (Art. 53, 66, 69)";
    } else {
      rule = "Approved for anonymised statistics – health data request (Art. 53, 69)";
    }
  }

  // Build per-article explanations, choosing the most relevant paragraph
  const articleExplanations: ArticleExplanation[] = articles.map((num) => {
    const title = artTitle(num);
    const summary = SUMMARIES[num] ?? "";

    // Choose the most relevant paragraph and ref
    let quote = "";
    let ref = "";

    if (num === "53") {
      quote = paraText("53", "1");
      ref = "Art. 53(1)";
    } else if (num === "54") {
      quote = firstParaText("54");
      ref = "Art. 54";
    } else if (num === "66") {
      if (decision === "APPROVE_SPE") {
        // Para 3 explains why pseudonymised is justified
        quote = paraText("66", "3");
        ref = "Art. 66(3)";
      } else {
        // Para 2 explains anonymisation requirement
        quote = paraText("66", "2");
        ref = "Art. 66(2)";
      }
    } else if (num === "67") {
      quote = paraText("67", "1");
      ref = "Art. 67(1)";
    } else if (num === "68") {
      quote = paraText("68", "1");
      ref = "Art. 68(1)";
    } else if (num === "69") {
      quote = paraText("69", "1");
      ref = "Art. 69(1)";
    } else if (num === "71") {
      quote = paraText("71", "1");
      ref = "Art. 71(1)";
    } else if (num === "73") {
      quote = paraText("73", "1");
      ref = "Art. 73(1)";
    } else {
      quote = firstParaText(num);
      ref = `Art. ${num}`;
    }

    return { number: num, title, summary, quote, ref };
  });

  // Plan summary (only for approvals with a valid plan)
  let plan_summary: string | undefined;
  if (plan && decision !== "REJECT") {
    plan_summary = describePlan(plan);
  }

  const result: ExplanationResult = {
    rule,
    trigger_phrases,
    trigger_context,
    articles: articleExplanations,
  };
  if (plan_summary !== undefined) {
    result.plan_summary = plan_summary;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Quote verification
// ---------------------------------------------------------------------------

/**
 * Returns true when:
 *   1. Every `quote` in the explanation is a verbatim (whitespace-normalised)
 *      substring of the stored regulation text for the cited article.
 *   2. Every `trigger_phrase` is a verbatim (whitespace-normalised) substring
 *      of the request purpose+question. No ellipsis stripping — trigger_phrases
 *      must already be exact substrings with no added markers.
 *
 * Returns false if any check fails.
 */
export function verifyQuotes(
  explanation: ExplanationResult,
  request: HealthDataRequest,
): boolean {
  const requestText = normalise(
    `${request.purpose ?? ""} ${request.question ?? ""}`,
  );

  // Check 1: every article quote is verbatim in the regulation
  for (const art of explanation.articles) {
    const artNum = art.number;
    const stored = (REG as RegData).articles[
      artNum as keyof typeof REG.articles
    ];
    if (!stored) return false;

    // Concatenate all paragraph texts for this article
    const allText = normalise(
      stored.paragraphs.map((p) => p.text).join(" "),
    );

    const normQuote = normalise(art.quote);
    if (normQuote.length === 0) return false;
    if (!allText.includes(normQuote)) return false;
  }

  // Check 2: every trigger_phrase is verbatim in the request — no stripping.
  // A phrase containing "…" will correctly fail because "…" is not in the request.
  for (const phrase of explanation.trigger_phrases) {
    if (phrase.length === 0) continue;
    const normPhrase = normalise(phrase);
    if (!requestText.includes(normPhrase)) return false;
  }

  return true;
}
