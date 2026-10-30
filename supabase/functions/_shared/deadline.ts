/**
 * Decision deadline computation — Issue #74
 *
 * Computes the statutory deadline for issuing or refusing a decision, based on
 * the type of application and the verbatim text of Regulation (EU) 2025/327.
 *
 *  - Data permit (health data access application) → Art. 68(4): 3 months
 *  - Health data request                          → Art. 69(4): 3 months
 *
 * The basis_quote is a verbatim substring of the stored regulation paragraph.
 */

import REG from "./regulation/reg_2025_327.json" with { type: "json" };

export interface DecisionDeadline {
  /** ISO 8601 date (UTC midnight) on which the decision is legally due. */
  due: string;
  /** Article reference, e.g. "Art. 68(4)". */
  basis_ref: string;
  /**
   * Verbatim substring of the stored regulation paragraph that states the
   * timeline.  A backend test asserts this is a substring of the stored text.
   */
  basis_quote: string;
}

/** Art. 68(4): data permit — three months from receipt. */
const ART_68_4_QUOTE =
  "the health data access body shall issue or refuse a data permit within three months of receiving a complete health data access application";

/** Art. 69(4): health data request — three months from receipt. */
const ART_69_4_QUOTE =
  "The health data access body shall assess the health data request within three months of receipt of the request";

/**
 * Add the specified number of calendar months to a date, returning an ISO 8601
 * date string (YYYY-MM-DD) in UTC.  Uses the same day-of-month clamping as
 * `Date` (e.g. 31 Jan + 1 month → 28/29 Feb).
 */
function addMonths(isoDate: string, months: number): string {
  const d = new Date(isoDate);
  d.setUTCMonth(d.getUTCMonth() + months);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Compute the statutory decision deadline for a request.
 *
 * @param requestedAs  The `requested_as` field from the access request body.
 * @param submitted    ISO 8601 timestamp or date of the complete submission.
 * @returns            A DecisionDeadline or null if the inputs are invalid.
 */
export function computeDeadline(
  requestedAs: string,
  submitted: string,
): DecisionDeadline | null {
  if (!submitted || !requestedAs) return null;
  if (isNaN(new Date(submitted).getTime())) return null;

  if (requestedAs === "health data access application") {
    // Verify the quote is still present in the stored regulation text.
    const para68 = (REG.articles as Record<string, { paragraphs: { ref: string; text: string }[] }>)["68"]
      ?.paragraphs.find((p) => p.ref === "4");
    if (!para68 || !para68.text.includes(ART_68_4_QUOTE)) return null;

    return {
      due: addMonths(submitted, 3),
      basis_ref: "Art. 68(4)",
      basis_quote: ART_68_4_QUOTE,
    };
  }

  if (requestedAs === "health data request") {
    const para69 = (REG.articles as Record<string, { paragraphs: { ref: string; text: string }[] }>)["69"]
      ?.paragraphs.find((p) => p.ref === "4");
    if (!para69 || !para69.text.includes(ART_69_4_QUOTE)) return null;

    return {
      due: addMonths(submitted, 3),
      basis_ref: "Art. 69(4)",
      basis_quote: ART_69_4_QUOTE,
    };
  }

  return null;
}
