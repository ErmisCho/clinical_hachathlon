/**
 * Explanation module – Issue #33 (EHDS Track 3)
 *
 * explain(request, decisionResult, plan?) → ExplanationResult
 *
 * Produces:
 *   - rule: plain-language rule name
 *   - trigger_phrases: EXACT substrings of request purpose/question
 *   - articles: [{number, title, summary, quote, ref, point, applies}]
 *   - plan_summary? (for approved requests with a query plan)
 *
 * verifyQuotes(explanation, request) → boolean
 *   Returns true when every quote is a verbatim (whitespace-normalised)
 *   substring of the stored regulation text AND every trigger_phrase is a
 *   verbatim substring of the request purpose+question AND every `applies`
 *   is a verbatim substring of its article `quote`.
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
  /**
   * The point/sub-clause that applies, e.g. "(e)" or "(b)".
   * null when the whole paragraph applies without a named point.
   */
  point: string | null;
  /**
   * The exact text to bold — a verbatim substring of `quote` that is the
   * specific sentence or phrase within the cited article that applies to
   * this decision.
   */
  applies: string;
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
// Allowed-purpose mapping: pattern → { point, applies }
// Each entry corresponds to a pattern in decision.ts ALLOWED_PATTERNS in the
// same order. `applies` MUST be a verbatim substring of Art. 53(1) text.
// ---------------------------------------------------------------------------

interface AllowedMapping {
  pattern: RegExp;
  point: string;
  applies: string;
}

const ALLOWED_MAPPINGS: AllowedMapping[] = [
  {
    pattern: /\bresearch\b/i,
    point: "(e)",
    applies:
      "scientific research related to health or care sectors that contributes to public health or health technology assessments",
  },
  {
    pattern: /\bpublic\s+health\b/i,
    point: "(a)",
    applies:
      "the public interest in the areas of public or occupational health",
  },
  {
    pattern: /\bprevention\b/i,
    point: "(a)",
    applies:
      "the public interest in the areas of public or occupational health",
  },
  {
    pattern: /\bpolicy/i,
    point: "(b)",
    applies:
      "policymaking and regulatory activities to support public sector bodies",
  },
  {
    pattern: /\bguideline/i,
    point: "(b)",
    applies:
      "policymaking and regulatory activities to support public sector bodies",
  },
  {
    pattern: /\bquality\s+(programme|program|improvement|in\s+healthcare)/i,
    point: "(a)",
    applies:
      "activities ensuring high levels of quality and safety of healthcare",
  },
  {
    pattern: /\bofficial\s+statistic/i,
    point: "(c)",
    applies:
      "statistics as defined in Article 3, point (1), of Regulation (EC) No 223/2009",
  },
  {
    pattern: /\bhealth\s+report/i,
    point: "(c)",
    applies:
      "statistics as defined in Article 3, point (1), of Regulation (EC) No 223/2009",
  },
  {
    pattern: /\bteaching\b/i,
    point: "(d)",
    applies:
      "education or teaching activities in health or care sectors at vocational or higher education level",
  },
  {
    pattern: /\btrain.*model/i,
    point: "(e)(ii)",
    applies:
      "training, testing and evaluation of algorithms, including in medical devices, in vitro diagnostic medical devices, AI systems and digital health applications",
  },
  {
    pattern: /\bvalidat.*model/i,
    point: "(e)(ii)",
    applies:
      "training, testing and evaluation of algorithms, including in medical devices, in vitro diagnostic medical devices, AI systems and digital health applications",
  },
  {
    pattern: /\bprediction\b/i,
    point: "(e)",
    applies:
      "scientific research related to health or care sectors that contributes to public health or health technology assessments",
  },
  {
    pattern: /\bclinical\b/i,
    point: "(e)",
    applies:
      "scientific research related to health or care sectors that contributes to public health or health technology assessments",
  },
  {
    pattern: /\bepidemiolog/i,
    point: "(e)",
    applies:
      "scientific research related to health or care sectors that contributes to public health or health technology assessments",
  },
  {
    pattern: /\btreatment\s+gap/i,
    point: "(a)",
    applies:
      "activities ensuring high levels of quality and safety of healthcare",
  },
  {
    pattern: /\brisk\s+factor/i,
    point: "(e)",
    applies:
      "scientific research related to health or care sectors that contributes to public health or health technology assessments",
  },
  {
    pattern: /\bprevention\s+advice/i,
    point: "(a)",
    applies:
      "activities ensuring high levels of quality and safety of healthcare",
  },
  {
    pattern: /\bannual\b/i,
    point: "(c)",
    applies:
      "statistics as defined in Article 3, point (1), of Regulation (EC) No 223/2009",
  },
];

/** Find the point and applies for an allowed-purpose decision from request text. */
function allowedPurposePoint(
  requestText: string,
): { point: string; applies: string } {
  for (const m of ALLOWED_MAPPINGS) {
    if (m.pattern.test(requestText)) {
      return { point: m.point, applies: m.applies };
    }
  }
  // Fallback: generic Art. 53(1) applies sentence
  return {
    point: null as unknown as string,
    applies:
      "Health data access bodies shall only grant access to electronic health data referred to in Article 51 for secondary use to a health data user where the processing of the data by that health data user is necessary for one of the following purposes:",
  };
}

// ---------------------------------------------------------------------------
// Prohibited-purpose mapping: pattern → { point_label, applies }
// `applies` MUST be a verbatim substring of Art. 54(1) text.
// ---------------------------------------------------------------------------

interface ProhibitedMapping {
  patterns: RegExp[];
  point: string | null;
  applies: string;
}

const PROHIBITED_MAPPINGS: ProhibitedMapping[] = [
  {
    // insurance premiums / insurance decisions → Art. 54(1)(b)
    patterns: [
      /insurance\s+premium/i,
      /align.*premium/i,
      /premium.*risk/i,
      /exclud.*insurance/i,
      /insurance.*contract/i,
      /\bunderwriting\b/i,
      /\binsurance\b.*\b(?:risk scor|coverage|eligibility)/i,
    ],
    point: "(b)",
    applies:
      "taking decisions in relation to a natural person or a group of natural persons in relation to job offers, offering less favourable terms in the provision of goods or services, including exclusion of such persons or groups from the benefit of an insurance or credit contract, the modification of their contributions and insurance premiums or conditions of loans, or taking any other decisions in relation to a natural person or a group of natural persons which result in discriminating against them on the basis of the health data obtained",
  },
  {
    // advertising or marketing → Art. 54(1)(c)
    patterns: [
      /\badvertis/i,
      /\bmarketing\b/i,
      /physician advertising/i,
      /advertising campaign/i,
      /\bsales\s+leads?\b/i,
      /\bpromotional\s+outreach\b/i,
      /\btarget\b.*\bcommercial\s+offers?\b/i,
    ],
    point: "(c)",
    applies: "carrying out advertising or marketing activities",
  },
  {
    // detrimental decisions about employees / job offers → Art. 54(1)(b)
    patterns: [
      /\bemployee\b/i,
      /match.*employee/i,
      /employee.*list/i,
      /renew.*contract/i,
      /sick\s+leave/i,
      /\bjob\s+applicants?\b.*\b(?:rank|screen|hiring)\b/i,
      /\b(?:rank|screen)\b.*\b(?:workers?|staff|job\s+applicants?)\b/i,
    ],
    point: "(b)",
    applies:
      "taking decisions in relation to a natural person or a group of natural persons in relation to job offers, offering less favourable terms in the provision of goods or services, including exclusion of such persons or groups from the benefit of an insurance or credit contract, the modification of their contributions and insurance premiums or conditions of loans, or taking any other decisions in relation to a natural person or a group of natural persons which result in discriminating against them on the basis of the health data obtained",
  },
  {
    // tobacco / nicotine / illicit products → Art. 54(1)(d)
    patterns: [
      /\bnicotine\b/i,
      /\btobacco\b/i,
      /\bcigarette/i,
      /nicotine\s+pouch/i,
      /healthier\s+alternative/i,
    ],
    point: "(d)",
    applies:
      "developing products or services that may harm individuals, public health or society at large, such as illicit drugs, alcoholic beverages, tobacco and nicotine products, weaponry or products or services which are designed or modified in such a way that they create addiction, contravene public order or cause a risk for human health",
  },
  {
    // development of alcoholic products → Art. 54(1)(d)
    patterns: [
      /\b(?:develop|optimise|optimize|tailor)\w*\b.*\balcohol(?:ic)?\s+(?:products?|beverages?|drinks?)\b/i,
    ],
    point: "(d)",
    applies:
      "developing products or services that may harm individuals, public health or society at large, such as illicit drugs, alcoholic beverages, tobacco and nicotine products, weaponry or products or services which are designed or modified in such a way that they create addiction, contravene public order or cause a risk for human health",
  },
  {
    // re-identification of data subjects → Art. 54(1)(e)
    patterns: [
      /\bre[- ]?identif(?:y|ication)\b/i,
      /\brecover\b.*\bidentities\b/i,
      /\blink\b.*\bpseudonyms?\b.*\b(?:names|addresses)\b/i,
    ],
    point: "(e)",
    applies:
      "carrying out activities in conflict with ethical provisions laid down in national law.",
  },
  {
    // weapons or illicit drugs → Art. 54(1)(d)
    patterns: [/\bweapon/i, /\billicit\s+drug/i],
    point: "(d)",
    applies:
      "developing products or services that may harm individuals, public health or society at large, such as illicit drugs, alcoholic beverages, tobacco and nicotine products, weaponry or products or services which are designed or modified in such a way that they create addiction, contravene public order or cause a risk for human health",
  },
  {
    // passing data to third parties not in permit
    patterns: [/\bthird\s+part/i],
    point: null,
    applies:
      "Health data users shall only process electronic health data for secondary use on the basis of and in accordance with the purposes contained in a data permit",
  },
];

/** Find the point and applies for a prohibited-purpose decision from request text. */
function prohibitedPurposePoint(requestText: string): {
  point: string | null;
  applies: string;
  ref: string;
} {
  const norm = requestText.normalize("NFKC").replace(/[\u2010-\u2015]/g, "-").replace(/\s+/g, " ");
  for (const m of PROHIBITED_MAPPINGS) {
    for (const p of m.patterns) {
      if (p.test(norm)) {
        // Build ref: Art. 54(1) with optional sub-point
        const ref = m.point ? `Art. 54(1)${m.point}` : "Art. 54(1)";
        return { point: m.point, applies: m.applies, ref };
      }
    }
  }
  // Fallback
  return {
    point: null,
    applies:
      "In particular, seeking access to and processing electronic health data obtained via a data permit issued pursuant to Article 68 or a health data request approved pursuant to Article 69 for the following uses shall be prohibited:",
    ref: "Art. 54(1)",
  };
}

// ---------------------------------------------------------------------------
// Plan summary generator
// ---------------------------------------------------------------------------

/**
 * Small lookup table for LOINC codes → readable names used in the fixtures.
 * Codes not in this table fall back to their raw LOINC string.
 */
const LOINC_NAMES: Record<string, string> = {
  "39156-5": "BMI",
  "4548-4": "HbA1c",
  "62238-1": "eGFR",
};

/**
 * Small lookup table for ICD-10 prefixes → readable condition names.
 * Used as a fallback when the request text doesn't name the condition.
 */
const ICD10_NAMES: Record<string, string> = {
  "E11": "type 2 diabetes",
  "E66": "obesity",
  "I10": "hypertension",
  "I48": "atrial fibrillation",
  "I50": "heart failure",
  "I63": "ischaemic stroke",
  "C50": "breast cancer",
  "F32": "depression",
  "J44": "COPD",
  "J45": "asthma",
  "N18": "chronic kidney disease",
  "S72": "hip fracture",
};

/**
 * Small lookup table for ATC prefixes → readable medication names.
 */
const ATC_NAMES: Record<string, string> = {
  "B01AA": "vitamin K antagonist",
  "B01AF": "direct oral anticoagulant",
  "C09AA": "ACE inhibitor",
  "C09CA": "angiotensin receptor blocker (ARB)",
  "C10AA": "statin",
  "A10BK": "SGLT2 inhibitor",
  "C03CA": "loop diuretic",
  "N06AB": "SSRI antidepressant",
  "R03": "bronchodilator",
};

/** Resolve a LOINC code to a readable name with the code in brackets. */
function loincName(loinc: string): string {
  const name = LOINC_NAMES[loinc];
  return name ? `${name} (LOINC ${loinc})` : `LOINC ${loinc}`;
}

/** Resolve an ICD-10 prefix to a readable condition name with code in brackets. */
function icd10Name(prefix: string): string {
  const name = ICD10_NAMES[prefix];
  return name ? `${name} (ICD-10 ${prefix})` : `ICD-10 ${prefix}`;
}

/** Resolve an ATC prefix to a readable name with code in brackets. */
function atcName(prefix: string): string {
  const name = ATC_NAMES[prefix];
  return name ? `${name} (ATC ${prefix})` : `ATC ${prefix}`;
}

/**
 * Readable names for known metric labels used in the sample fixtures.
 * Keys are the snake_case label values from plan_examples.ts.
 * Values are the plain-English strings a non-technical reader understands.
 */
const METRIC_LABEL_NAMES: Record<string, string> = {
  // R01
  "adults": "adults",
  "type2_diabetes": "adults with type 2 diabetes (ICD-10 E11)",
  "prevalence_pct": "prevalence (%)",
  // R02
  "patients_with_hba1c": "patients with HbA1c (LOINC 4548-4)",
  "mean_hba1c": "mean HbA1c",
  // R03
  "af_patients": "patients with atrial fibrillation",
  "without_oac": "of whom without an oral anticoagulant",
  "share_without_oac_pct": "share without an oral anticoagulant (%)",
  // R04
  "patients_with_sglt2": "patients with an active SGLT2 inhibitor",
  // R05 / R06
  "cohort_size": "cohort size",
  // R07
  "inpatient_stays": "inpatient stays",
  // R08
  "women_with_bmi": "women with a BMI measurement",
  "mean_bmi": "mean BMI",
  // R09
  "adults_with_hypertension": "adults with hypertension (ICD-10 I10)",
  "ace_inhibitor_pct": "ACE inhibitor (%)",
  "arb_pct": "ARB (%)",
  // R10
  "copd_patients": "patients with COPD (ICD-10 J44)",
  // EX examples
  "adults_with_t2d": "adults with type 2 diabetes",
  "inpatient_stays_copd": "inpatient stays with COPD",
};

/**
 * Return a readable metric name for a given label.
 * Uses the explicit lookup first; falls back to converting snake_case to words
 * with _pct suffix replaced by " (%)".
 */
function metricReadableName(label: string): string {
  const known = METRIC_LABEL_NAMES[label];
  if (known) return known;
  // Fallback: convert snake_case, handle _pct suffix
  return label.replace(/_pct$/, " (%)").replace(/_/g, " ");
}

function describePlan(plan: QueryPlan, request?: HealthDataRequest): string {
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
      ? ` with primary diagnosis ${icd10Name(encFilt.primary_icd10_prefix)}`
      : "";
    parts.push(`${t} encounters${y}${dx}`);
  } else {
    const cohortParts: string[] = [];
    if (sexFilt && sexFilt.type === "sex") cohortParts.push(sexFilt.value === "female" ? "female patients" : "male patients");
    else cohortParts.push("patients");

    if (ageFilt && ageFilt.type === "age") {
      const min = ageFilt.min_age;
      const max = ageFilt.max_age;
      if (max === undefined) cohortParts.push(`aged ${min}+`);
      else cohortParts.push(`aged ${min}–${max}`);
    }
    if (condFilt && condFilt.type === "has_condition") {
      const names = condFilt.icd10_prefixes.map(icd10Name).join(" or ");
      cohortParts.push(`with ${names}`);
    }
    if (medFilt && medFilt.type === "has_medication") {
      const neg = medFilt.negate ? "without" : "with";
      const meds = medFilt.atc_prefixes.map(atcName).join(" or ");
      cohortParts.push(`${neg} an active ${meds}`);
    }
    if (obsFilt && obsFilt.type === "has_observation") {
      cohortParts.push(`with at least one ${loincName(obsFilt.loinc)} measurement`);
    }
    if (regionFilt && regionFilt.type === "region") {
      cohortParts.push(`in ${regionFilt.value}`);
    }
    parts.push(cohortParts.join(", "));
  }

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

  // Metrics — use readable names; no raw snake_case labels or redundant parentheticals
  const metricDescs = plan.metrics.map((m): string => {
    if (m.type === "count") return metricReadableName(m.label);
    if (m.type === "percentage") return metricReadableName(m.label);
    if (m.type === "mean_observation") {
      // Use the label lookup first; fall back to "mean <LOINC readable name>"
      const known = METRIC_LABEL_NAMES[m.label];
      return known ?? `mean ${loincName(m.loinc)}`;
    }
    return metricReadableName((m as { label: string }).label);
  });

  let summary = `${parts.join("; ")}`;
  if (dimDescs.length > 0) {
    summary += `, counted per ${dimDescs.join(" × ")}`;
  }
  summary += `; metrics: ${metricDescs.join(", ")}`;

  // SPE record types
  if (plan.spe_record_types && plan.spe_record_types.length > 0) {
    summary += `; pseudonymised ${plan.spe_record_types.join(", ")} records in secure processing environment`;
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

  // Pre-compute context for article point/applies lookup
  const requestText = `${request.purpose ?? ""} ${request.question ?? ""}`
    .normalize("NFKC").replace(/[\u2010-\u2015]/g, "-").replace(/\s+/g, " ");

  const prohibitedInfo = decision === "REJECT"
    ? prohibitedPurposePoint(requestText)
    : null;

  const allowedInfo = decision !== "REJECT"
    ? allowedPurposePoint(requestText)
    : null;

  // Build per-article explanations, choosing the most relevant paragraph
  const articleExplanations: ArticleExplanation[] = articles.map((num) => {
    const title = artTitle(num);
    const summary = SUMMARIES[num] ?? "";

    // Choose the most relevant paragraph and ref
    let quote = "";
    let ref = "";
    let point: string | null = null;
    let applies = "";

    if (num === "53") {
      quote = paraText("53", "1");
      const info = allowedInfo ?? { point: null as unknown as string, applies: quote.slice(0, 80) };
      point = info.point ?? null;
      applies = info.applies;
      ref = point ? `Art. 53(1)${point}` : "Art. 53(1)";
    } else if (num === "54") {
      quote = paraText("54", "1");
      if (prohibitedInfo) {
        ref = prohibitedInfo.ref;
        point = prohibitedInfo.point;
        applies = prohibitedInfo.applies;
      } else {
        ref = "Art. 54(1)";
        point = null;
        applies = "In particular, seeking access to and processing electronic health data obtained via a data permit issued pursuant to Article 68 or a health data request approved pursuant to Article 69 for the following uses shall be prohibited:";
      }
    } else if (num === "66") {
      if (decision === "APPROVE_SPE") {
        quote = paraText("66", "3");
        ref = "Art. 66(3)";
        point = null;
        applies = "Where the health data user has sufficiently demonstrated that the purpose of processing cannot be achieved with anonymised data";
      } else {
        quote = paraText("66", "2");
        ref = "Art. 66(2)";
        point = null;
        applies = "Health data access bodies shall provide electronic health data in an anonymised format, where the purpose of processing by the health data user can be achieved with such data";
      }
    } else if (num === "67") {
      quote = paraText("67", "1");
      ref = "Art. 67(1)";
      point = null;
      applies = "A natural or legal person may submit a health data access application for the purposes referred to in Article 53(1) to a health data access body.";
    } else if (num === "68") {
      quote = paraText("68", "1");
      ref = "Art. 68(1)";
      point = "(c)";
      applies = "the processing complies with Article 6(1) of Regulation (EU) 2016/679 and, in the case of pseudonymised data, there is sufficient justification that the purpose cannot be achieved with anonymised data";
    } else if (num === "69") {
      quote = paraText("69", "1");
      ref = "Art. 69(1)";
      point = null;
      applies = "The health data applicant may submit a health data request for the purposes referred to in Article 53 with the aim of obtaining a response only in an anonymised statistical format.";
    } else if (num === "71") {
      quote = paraText("71", "1");
      ref = "Art. 71(1)";
      point = null;
      applies = "Natural persons shall have the right to opt out at any time, and without providing any reason, from the processing of personal electronic health data relating to them for secondary use under this Regulation.";
    } else if (num === "73") {
      quote = paraText("73", "1");
      ref = "Art. 73(1)";
      point = null;
      applies = "Health data access bodies shall provide access to electronic health data pursuant to a data permit only through a secure processing environment";
    } else {
      quote = firstParaText(num);
      ref = `Art. ${num}`;
      point = null;
      applies = quote.split(".")[0] + ".";
    }

    return { number: num, title, summary, quote, ref, point, applies };
  });

  // Plan summary (only for approvals with a valid plan)
  let plan_summary: string | undefined;
  if (plan && decision !== "REJECT") {
    plan_summary = describePlan(plan, request);
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
 *   3. Every `applies` is a verbatim (whitespace-normalised) substring of its
 *      article `quote`.
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

    // Check 3: applies is a verbatim substring of the quote
    const normApplies = normalise(art.applies);
    if (normApplies.length === 0) return false;
    if (!normalise(art.quote).includes(normApplies)) return false;
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
