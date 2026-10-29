/**
 * Decision module – Issue #3 (EHDS Track 3)
 *
 * Implements the four-step decision order from the track README:
 *   1. Prohibited purpose  → REJECT,               Art. 54
 *   2. health data request  → APPROVE_STATISTICAL,  Art. 53, 69
 *   3. access application + explains why statistics not enough
 *                           → APPROVE_SPE,          Art. 53, 66, 68, 73
 *   4. any other access application
 *                           → APPROVE_STATISTICAL,  Art. 53, 66, 69
 *
 * Rules are pure keyword matching (Decision D in architecture.md):
 * same output on every run, no LLM, no randomness.
 */

export interface HealthDataRequest {
  id?: string;
  requested_as: string; // "health data request" | "health data access application"
  purpose: string;
  question?: string;
  [key: string]: unknown;
}

export interface DecisionResult {
  decision: "REJECT" | "APPROVE_STATISTICAL" | "APPROVE_SPE";
  articles: string[];
  reason: string;
  needs_review: boolean;
  matched: string[];
}

// ---------------------------------------------------------------------------
// Art. 54 – prohibited purpose keywords
// Each entry: { label, patterns[] } – fires if ANY pattern matches purpose or question.
// ---------------------------------------------------------------------------
const PROHIBITED_RULES: Array<{ label: string; patterns: RegExp[] }> = [
  {
    label: "insurance premiums / insurance decisions",
    patterns: [
      /insurance\s+premium/i,
      /align.*premium/i,
      /premium.*risk/i,
      /exclud.*insurance/i,
      /insurance.*contract/i,
      /\bunderwriting\b/i,
      /\binsurance\b.*\b(?:risk scor|coverage|eligibility)/i,
    ],
  },
  {
    label: "advertising or marketing",
    patterns: [
      /\badvertis/i,
      /\bmarketing\b/i,
      /physician advertising/i,
      /advertising campaign/i,
      /\bsales\s+leads?\b/i,
      /\bpromotional\s+outreach\b/i,
      /\btarget\b.*\bcommercial\s+offers?\b/i,
    ],
  },
  {
    label: "detrimental decisions about employees / re-identification",
    patterns: [
      /\bemployee\b/i,
      /match.*employee/i,
      /employee.*list/i,
      /renew.*contract/i,
      /sick\s+leave/i,
      /\bjob\s+applicants?\b.*\b(?:rank|screen|hiring)\b/i,
      /\b(?:rank|screen)\b.*\b(?:workers?|staff|job\s+applicants?)\b/i,
    ],
  },
  {
    label: "tobacco / nicotine / illicit products",
    patterns: [
      /\bnicotine\b/i,
      /\btobacco\b/i,
      /\bcigarette/i,
      /nicotine\s+pouch/i,
      /healthier\s+alternative/i,
    ],
  },
  {
    label: "development of alcoholic products",
    patterns: [
      /\b(?:develop|optimise|optimize|tailor)\w*\b.*\balcohol(?:ic)?\s+(?:products?|beverages?|drinks?)\b/i,
    ],
  },
  {
    label: "re-identification of data subjects",
    patterns: [
      /\bre[- ]?identif(?:y|ication)\b/i,
      /\brecover\b.*\bidentities\b/i,
      /\blink\b.*\bpseudonyms?\b.*\b(?:names|addresses)\b/i,
    ],
  },
  {
    label: "weapons or illicit drugs",
    patterns: [/\bweapon/i, /\billicit\s+drug/i],
  },
  {
    label: "passing data to third parties not in permit",
    patterns: [/\bthird\s+part/i],
  },
];

// ---------------------------------------------------------------------------
// Art. 53 – allowed purpose keywords (used only for needs_review flag)
// ---------------------------------------------------------------------------
const ALLOWED_PATTERNS: RegExp[] = [
  /\bresearch\b/i,
  /\bpublic\s+health\b/i,
  /\bprevention\b/i,
  /\bpolicy/i,
  /\bguideline/i,
  /\bquality\s+(programme|program|improvement|in\s+healthcare)/i,
  /\bofficial\s+statistic/i,
  /\bhealth\s+report/i,
  /\bteaching\b/i,
  /\btrain.*model/i,
  /\bvalidat.*model/i,
  /\bprediction\b/i,
  /\bclinical\b/i,
  /\bepidemiolog/i,
  /\btreatment\s+gap/i,
  /\brisk\s+factor/i,
  /\bprevention\s+advice/i,
  /\bannual\b/i,
];

// ---------------------------------------------------------------------------
// SPE justification keywords – applicant must explain why statistics are not enough
// ---------------------------------------------------------------------------
const SPE_JUSTIFICATION_PATTERNS: RegExp[] = [
  /aggregates?\s+are\s+not\s+enough/i,
  /statistics?\s+are\s+not\s+enough/i,
  // Asking for records is not itself an explanation of why statistics fail.
  /(?:aggregates?|statistics?)\s+(?:are|is)\s+insufficient\s+because\b/i,
];

// ---------------------------------------------------------------------------
// Main decision function
// ---------------------------------------------------------------------------
export function decide(req: HealthDataRequest): DecisionResult {
  const text = `${req.purpose ?? ""} ${req.question ?? ""}`
    .normalize("NFKC").replace(/[\u2010-\u2015]/g, "-").replace(/\s+/g, " ");

  // Step 1 – check prohibited purposes (Art. 54)
  const prohibitedMatched: string[] = [];
  for (const rule of PROHIBITED_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        prohibitedMatched.push(rule.label);
        break; // only count each rule once
      }
    }
  }
  if (prohibitedMatched.length > 0) {
    return {
      decision: "REJECT",
      articles: ["54"],
      reason: buildRejectReason(prohibitedMatched),
      needs_review: false,
      matched: prohibitedMatched,
    };
  }

  // Determine needs_review: purpose matches neither allowed nor prohibited
  const isAllowed = ALLOWED_PATTERNS.some((p) => p.test(text));
  const needs_review = !isAllowed;

  const requestedAs = (req.requested_as ?? "").toLowerCase();

  // Step 2 – "health data request" → APPROVE_STATISTICAL
  if (requestedAs === "health data request") {
    return {
      decision: "APPROVE_STATISTICAL",
      articles: ["53", "69"],
      reason:
        "Your purpose is an allowed use of health data (Art. 53). Anonymised statistics are sufficient to answer the question (Art. 69).",
      needs_review,
      matched: [],
    };
  }

  // Step 3 / Step 4 – "health data access application"
  const speMatched: string[] = [];
  for (const pattern of SPE_JUSTIFICATION_PATTERNS) {
    if (pattern.test(text)) {
      speMatched.push(pattern.source);
    }
  }

  if (speMatched.length > 0) {
    // Step 3 – explains why statistics are not enough → APPROVE_SPE
    return {
      decision: "APPROVE_SPE",
      articles: ["53", "66", "68", "73"],
      reason:
        "Your purpose is an allowed use of health data (Art. 53). You have explained why anonymised statistics are not sufficient; pseudonymised patient-level data is justified (Art. 66). Access is granted inside a secure processing environment under a data permit (Art. 68, 73).",
      needs_review,
      matched: speMatched,
    };
  }

  // Step 4 – access application without SPE justification → APPROVE_STATISTICAL
  return {
    decision: "APPROVE_STATISTICAL",
    articles: ["53", "66", "69"],
    reason:
      "Your purpose is an allowed use of health data (Art. 53). Anonymised statistics are sufficient to answer the question; pseudonymised records are not justified under Art. 66. Your request is approved as statistics (Art. 69).",
    needs_review,
    matched: [],
  };
}

// ---------------------------------------------------------------------------
// Helper: build a plain-language rejection reason
// ---------------------------------------------------------------------------
function buildRejectReason(labels: string[]): string {
  if (labels.some((l) => /insurance/i.test(l))) {
    return "Using health data to set or align insurance premiums is prohibited (Art. 54).";
  }
  if (labels.some((l) => /advertising|marketing/i.test(l))) {
    return "Advertising and marketing are prohibited purposes for health data (Art. 54).";
  }
  if (labels.some((l) => /employee/i.test(l))) {
    return "Using health data for decisions about employees, or matching it with an employee list, is prohibited (Art. 54). This could re-identify individuals and harm them.";
  }
  if (labels.some((l) => /nicotine|tobacco/i.test(l))) {
    return "Developing or marketing nicotine or tobacco products is a prohibited purpose for health data (Art. 54).";
  }
  if (labels.some((l) => /weapon|illicit/i.test(l))) {
    return "Developing harmful or illicit products is a prohibited purpose for health data (Art. 54).";
  }
  if (labels.some((l) => /third\s+part/i.test(l))) {
    return "Passing health data to third parties not named in the permit is prohibited (Art. 54).";
  }
  return `Your purpose matches a prohibited use of health data (Art. 54): ${labels.join("; ")}.`;
}
