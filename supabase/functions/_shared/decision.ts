/**
 * Decision module – Issue #3, #50 (EHDS Track 3)
 *
 * Implements the four-step decision order from the track README:
 *   1. Prohibited purpose  → REJECT,               Art. 54
 *   2. health data request  → APPROVE_STATISTICAL,  Art. 53, 69
 *   3. access application + explains why statistics not enough
 *                           → APPROVE_SPE,          Art. 53, 66, 68, 73
 *   4. any other access application
 *                           → APPROVE_STATISTICAL,  Art. 53, 66, 69
 *
 * Rules are loaded from rules/decision_rules.json (versioned data file).
 * Negation handling: a phrase inside a negated clause does not fire a
 * prohibited rule and does not count as an allowed purpose.
 *
 * Negated clause patterns: "will not/won't/never/no ... be used for",
 * "not for", "without any", "we will not", "we won't", "we never",
 * "no ... purpose", "not related to", "not a ... study", "not for any",
 * "not intend", etc.  The implementation strips negated windows before
 * applying each phrase match.
 */

import RULES_DATA from "./rules/decision_rules.json" with { type: "json" };

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
  /** Rule id(s) from decision_rules.json that fired (first match for REJECT/APPROVE_SPE/APPROVE_STATISTICAL). */
  rule_id: string;
  /** Version string from decision_rules.json used for this decision. */
  rules_version: string;
  /** EXACT substrings of purpose/question (just the regex match, no ellipses):
   *  – REJECT: the literal matched text from the prohibited-purpose rule
   *  – APPROVE_SPE: the literal SPE justification phrase(s)
   *  – APPROVE_STATISTICAL: the literal allowed-purpose phrase
   *  Deduplicated; safe for verbatim substring checks.
   */
  matched: string[];
  /** Display contexts: the same matches but with surrounding words and "…"
   *  markers added. Parallel to matched[]. */
  matched_context: string[];
}

// ---------------------------------------------------------------------------
// Load and compile rules from decision_rules.json
// ---------------------------------------------------------------------------

type RuleKind = "prohibited" | "allowed" | "spe_justification";

export interface ExtraProhibitedRule {
  id: string;
  article_ref: string;
  label: string;
  phrases: string[];
  examples: string[];
  counter_examples: string[];
}

interface RawRule {
  id: string;
  kind: RuleKind;
  article_ref: string;
  label: string;
  phrases: string[];
  examples: string[];
  counter_examples: string[];
}

interface CompiledRule {
  id: string;
  kind: RuleKind;
  article_ref: string;
  label: string;
  patterns: RegExp[];
  examples: string[];
  counter_examples: string[];
}

const RULES_VERSION: string = (RULES_DATA as { version: string }).version;

const ALL_RULES: CompiledRule[] = (RULES_DATA as { rules: RawRule[] }).rules
  .map((r) => ({
    id: r.id,
    kind: r.kind,
    article_ref: r.article_ref,
    label: r.label,
    patterns: r.phrases.map((p) => new RegExp(p, "i")),
    examples: r.examples,
    counter_examples: r.counter_examples,
  }));

const PROHIBITED_RULES = ALL_RULES.filter((r) => r.kind === "prohibited");
const ALLOWED_RULES = ALL_RULES.filter((r) => r.kind === "allowed");
const SPE_RULES = ALL_RULES.filter((r) => r.kind === "spe_justification");

// ---------------------------------------------------------------------------
// Negation handling
// ---------------------------------------------------------------------------

/**
 * Negation window patterns.  Each captures a "negation anchor" followed by
 * up to the end of the clause (period/semicolon/newline or ~120 chars).
 *
 * Strategy: blank everything from the negation anchor up to the nearest
 * sentence-ending punctuation (. ; ! ?) or up to 120 characters, whichever
 * comes first.  This correctly silences "will not use the data for marketing"
 * even when "marketing" is several words after "will not".
 *
 * Covers:
 *   - "will not / won't / never / no" + rest of clause
 *   - "not for", "not a ... study", "not related to", "not intend",
 *     "not any", "not in any", "without any", "not be used for"
 *   - Contractions: "isn't", "aren't", "don't", "doesn't", "haven't"
 *
 * Note: [^.;!?\n] matches any character that is not end-of-clause.
 */
const NEGATION_WINDOWS: RegExp[] = [
  // "will not / won't / we will not / we won't / we never / never" → rest of clause
  /\b(?:will\s+not|won't|we\s+will\s+not|we\s+won't|we\s+never|never)\b[^.;!?\n]{0,120}/gi,
  // "not for" → rest of clause
  /\bnot\s+for\b[^.;!?\n]{0,100}/gi,
  // "not related to" → rest of clause
  /\bnot\s+related\s+to\b[^.;!?\n]{0,100}/gi,
  // "not a/an ... study/purpose/use/project" → rest of clause
  /\bnot\s+(?:a|an)\s+[^.;!?\n]{0,80}(?:study|purpose|use|project)\b/gi,
  // "not intend" → rest of clause
  /\bnot\s+intend\w*\b[^.;!?\n]{0,80}/gi,
  // "without any" → rest of clause
  /\bwithout\s+any\b[^.;!?\n]{0,80}/gi,
  // "no ... purpose/intent/intention/plan.../attempt..." + rest of clause
  /\bno\b[^.;!?\n]{0,30}(?:purpose|intent\w*|plan\w*|attempt\w*)\b[^.;!?\n]{0,100}/gi,
  // "not in any way" → rest of clause
  /\bnot\s+in\s+any\s+way\b[^.;!?\n]{0,80}/gi,
  // "not be used for" → rest of clause
  /\bnot\s+be\s+used\s+for\b[^.;!?\n]{0,100}/gi,
  // "isn't / aren't / don't / doesn't / haven't" → rest of clause
  /\b(?:isn't|aren't|don't|doesn't|haven't)\b[^.;!?\n]{0,80}/gi,
];

/**
 * Returns a copy of `text` with all negated windows blanked out (replaced
 * with spaces of equal length).  This preserves character offsets for the
 * parts of the text that were NOT negated, so that extractMatch() on the
 * original text still works.
 *
 * We blank instead of remove so that the extracted match positions from the
 * original text stay valid.  The blanked copy is used only for matching;
 * the original is used for extracting match text and context.
 */
function blankNegatedWindows(text: string): string {
  let result = text;
  for (const pattern of NEGATION_WINDOWS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => " ".repeat(match.length));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helper: extract the actual matched substring from the request text
// ---------------------------------------------------------------------------

/** Returns the matched substring expanded to the nearest word boundary so
 *  stem patterns like /\badvertis/ return "advertising" not "advertis". */
function extractMatch(text: string, pattern: RegExp): string | null {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : pattern.flags + "g";
  const re = new RegExp(pattern.source, flags);
  const m = re.exec(text);
  if (!m) return null;
  const end = m.index + m[0].length;
  // Extend to next word boundary (consume remaining word characters).
  const tail = text.slice(end).match(/^\w+/);
  return m[0] + (tail ? tail[0] : "");
}

/** Extract a context window around a match: up to `ctx` chars of surrounding
 *  words so the quoted phrase reads naturally. */
function matchContext(text: string, pattern: RegExp, ctx = 60): string | null {
  const m = pattern.exec(text);
  if (!m) return null;
  const start = Math.max(0, m.index - ctx);
  const end = Math.min(text.length, m.index + m[0].length + ctx);
  let snippet = text.slice(start, end).trim();
  if (start > 0) snippet = "…" + snippet;
  if (end < text.length) snippet = snippet + "…";
  return snippet;
}

// ---------------------------------------------------------------------------
// Main decision function
// ---------------------------------------------------------------------------
export function decide(
  req: HealthDataRequest,
  extraRules: readonly ExtraProhibitedRule[] = [],
  hdabCode?: string,
): DecisionResult {
  const rulesVersion = hdabCode
    ? `${RULES_VERSION}+${hdabCode}`
    : RULES_VERSION;
  const prohibitedRules = [
    // National matches retain their own identity, including when a base rule also fires.
    ...extraRules.map((r) => ({
      ...r,
      patterns: r.phrases.map((p) => new RegExp(p, "i")),
    })),
    ...PROHIBITED_RULES,
  ];
  const text = `${req.purpose ?? ""} ${req.question ?? ""}`
    .normalize("NFKC").replace(/[\u2010-\u2015]/g, "-").replace(/\s+/g, " ");

  // Build the negation-blanked copy for match detection only
  const textForMatch = blankNegatedWindows(text);

  // Step 1 – check prohibited purposes (Art. 54)
  const prohibitedMatchedLabels: string[] = [];
  const prohibitedExact: string[] = [];
  const prohibitedCtx: string[] = [];
  let prohibitedRuleId = "";
  for (const rule of prohibitedRules) {
    for (const pattern of rule.patterns) {
      // Check on the negation-blanked copy
      const flags = pattern.flags.includes("g")
        ? pattern.flags
        : pattern.flags + "g";
      const testRe = new RegExp(pattern.source, flags);
      if (testRe.test(textForMatch)) {
        // Extract match from original text for verbatim display
        const raw = extractMatch(text, pattern);
        if (raw !== null) {
          if (prohibitedRuleId === "") prohibitedRuleId = rule.id;
          prohibitedMatchedLabels.push(rule.label);
          prohibitedExact.push(raw);
          prohibitedCtx.push(matchContext(text, pattern, 50) ?? raw);
          break; // only count each rule once
        }
      }
    }
  }
  if (prohibitedMatchedLabels.length > 0) {
    return {
      decision: "REJECT",
      articles: ["54"],
      reason: buildRejectReason(prohibitedMatchedLabels),
      needs_review: false,
      rule_id: prohibitedRuleId,
      rules_version: rulesVersion,
      matched: dedup(prohibitedExact),
      matched_context: prohibitedCtx,
    };
  }

  // Determine needs_review: purpose matches neither allowed nor prohibited
  // Use negation-blanked text so "not for research" doesn't count as allowed
  const matchedAllowedRule = ALLOWED_RULES.find((rule) =>
    rule.patterns.some((p) => {
      const flags = p.flags.includes("g") ? p.flags : p.flags + "g";
      return new RegExp(p.source, flags).test(textForMatch);
    })
  );
  const isAllowed = matchedAllowedRule !== undefined;
  const needs_review = !isAllowed;

  // Extract exact allowed-purpose match (first match only, one phrase)
  let allowedExact: string[] = [];
  let allowedCtx: string[] = [];
  let allowedRuleId = matchedAllowedRule?.id ?? "";
  if (matchedAllowedRule) {
    for (const pattern of matchedAllowedRule.patterns) {
      const raw = extractMatch(text, pattern);
      if (raw !== null) {
        allowedExact = [raw];
        allowedCtx = [matchContext(text, pattern, 60) ?? raw];
        break;
      }
    }
  }

  const requestedAs = (req.requested_as ?? "").toLowerCase();

  // Step 2 – "health data request" → APPROVE_STATISTICAL
  if (requestedAs === "health data request") {
    return {
      decision: "APPROVE_STATISTICAL",
      articles: ["53", "69"],
      reason:
        "Your purpose is an allowed use of health data (Art. 53). Anonymised statistics are sufficient to answer the question (Art. 69).",
      needs_review,
      rule_id: allowedRuleId || "A01",
      rules_version: rulesVersion,
      matched: allowedExact,
      matched_context: allowedCtx,
    };
  }

  // Step 3 / Step 4 – "health data access application"
  const speExact: string[] = [];
  const speCtx: string[] = [];
  let speRuleId = "";
  for (const rule of SPE_RULES) {
    for (const pattern of rule.patterns) {
      const raw = extractMatch(text, pattern);
      if (raw !== null) {
        if (speRuleId === "") speRuleId = rule.id;
        speExact.push(raw);
        speCtx.push(matchContext(text, pattern, 60) ?? raw);
      }
    }
  }

  if (speExact.length > 0) {
    // Step 3 – explains why statistics are not enough → APPROVE_SPE
    return {
      decision: "APPROVE_SPE",
      articles: ["53", "66", "68", "73"],
      reason:
        "Your purpose is an allowed use of health data (Art. 53). You have explained why anonymised statistics are not sufficient; pseudonymised patient-level data is justified (Art. 66). Access is granted inside a secure processing environment under a data permit (Art. 68, 73).",
      needs_review,
      rule_id: speRuleId,
      rules_version: rulesVersion,
      matched: dedup(speExact),
      matched_context: speCtx,
    };
  }

  // Step 4 – access application without SPE justification → APPROVE_STATISTICAL
  return {
    decision: "APPROVE_STATISTICAL",
    articles: ["53", "66", "69"],
    reason:
      "Your purpose is an allowed use of health data (Art. 53). Anonymised statistics are sufficient to answer the question; pseudonymised records are not justified under Art. 66. Your request is approved as statistics (Art. 69).",
    needs_review,
    rule_id: allowedRuleId || "A01",
    rules_version: rulesVersion,
    matched: allowedExact,
    matched_context: allowedCtx,
  };
}

/** Deduplicate an array while preserving order. */
function dedup(arr: string[]): string[] {
  return [...new Set(arr)];
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
  return `Your purpose matches a prohibited use of health data (Art. 54): ${
    labels.join("; ")
  }.`;
}

// ---------------------------------------------------------------------------
// Export compiled rules for testing (examples/counter-examples)
// ---------------------------------------------------------------------------
export { ALL_RULES, RULES_VERSION };
export type { CompiledRule };
