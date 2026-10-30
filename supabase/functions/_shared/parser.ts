import { validatePlan } from "./plan.ts";
import type {
  AgeBand,
  CohortFilter,
  EncounterFilter,
  Grouping,
  QueryPlan,
  RecordType,
} from "./plan.ts";

export type ParseResult =
  | { ok: true; plan: QueryPlan }
  | { ok: false; errors: { definition: string; reason: string }[] };

type Concept = { name: string; filter: CohortFilter };
const clean = (text: string) =>
  text.trim().replace(/\.$/, "").replace(/\s+/g, " ");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Convert a word/phrase to a snake_case identifier.
 *  Pure-digit tokens are merged into the preceding token (e.g. "type 2" → "type2").
 */
function toLabel(text: string): string {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter((t) =>
    t.length > 0
  );
  const merged: string[] = [];
  for (const token of tokens) {
    if (/^\d+$/.test(token) && merged.length > 0) {
      merged[merged.length - 1] += token;
    } else {
      merged.push(token);
    }
  }
  return merged.join("_");
}

/** Clinical acronym: first letter of each part, splitting common medical prefixes.
 *  "Oral anticoagulant" → "oac", "Atrial fibrillation" → "af".
 */
function clinicalAcronym(name: string): string {
  const words = name.toLowerCase().split(/[\s-]+/).filter(Boolean);
  const parts: string[] = [];
  for (const word of words) {
    if (/^\d+$/.test(word)) continue;
    const m = word.match(
      /^(anti|pre|post|sub|super|hyper|hypo|trans|intra|inter|extra)(.+)/,
    );
    if (m) {
      parts.push(m[1][0], m[2][0]);
    } else {
      parts.push(word[0]);
    }
  }
  return parts.join("");
}

/** Derive a readable label for a cohort-count metric from the text phrase used in
 *  the report clause.  Falls back to a plain snake_case of the phrase when no
 *  recognised pattern applies.
 */
function deriveCohortLabel(
  phrase: string,
  conceptList: { name: string; filter: CohortFilter }[],
  obsList: { name: string }[],
  tokenizeFn: (t: string) => string,
): string {
  const tokenized = tokenizeFn(phrase);
  // Observation in phrase → patients_with_<obs> or women/men_with_<obs>
  for (let i = 0; i < obsList.length; i++) {
    if (tokenized.includes(`obs${i}`)) {
      const obsLabel = toLabel(obsList[i].name);
      const lower = phrase.toLowerCase();
      if (/\bwomen\b/.test(lower)) return `women_with_${obsLabel}`;
      if (/\bmen\b/.test(lower)) return `men_with_${obsLabel}`;
      return `patients_with_${obsLabel}`;
    }
  }
  // Concept in phrase
  for (let i = 0; i < conceptList.length; i++) {
    if (tokenized.includes(`concept${i}`)) {
      const c = conceptList[i];
      const cLabel = toLabel(c.name);
      const lower = phrase.toLowerCase();
      // "adults with <condition>"
      if (/^(?:number of )?(?:all )?adults?\s+with\b/.test(lower)) {
        return `adults_with_${cLabel}`;
      }
      // "patients with (an active) <medication>"
      if (
        c.filter.type === "has_medication" &&
        /^(?:all )?patients?\s+with\b/.test(lower)
      ) {
        return `patients_with_${cLabel.split("_")[0]}`;
      }
      // "patients with <condition>"
      if (/^(?:all )?patients?\s+with\b/.test(lower)) {
        return cLabel.includes("_")
          ? `${clinicalAcronym(c.name)}_patients`
          : `${cLabel}_patients`;
      }
    }
  }
  // No recognised concept pattern — clean up the phrase directly
  let label = phrase.toLowerCase()
    .replace(/^number of\s+/, "")
    .replace(/\b(?:an?|the)\s+/g, "");
  return toLabel(label.trim());
}
const prefixList = "([A-Z][A-Z0-9.]*(?: or [A-Z][A-Z0-9.]*)*)";
// Shared, non-capturing grammar fragments keep synonymous prefix predicates
// consistent across diagnosis, condition and medication rules.
const prefixVerb =
  "(?:starting with|starts? with|beginning with|begins? with|that starts? with)";
// Like prefixVerb but the "with" is optional — accepts bare "beginning X" as well as "beginning with X".
const prefixVerbBare =
  "(?:starting(?:\\s+with)?|starts?(?:\\s+with)?|beginning(?:\\s+with)?|begins?(?:\\s+with)?|that\\s+starts?(?:\\s+with)?)";
const primaryDiagnosis =
  `(?:the )?(?:(?:main|primary) diagnos(?:is|es)(?: \\(primary_icd10\\))?|primary_icd10) ${prefixVerb} ([A-Z][A-Z0-9.]*)`;
const holderGroup =
  "(?:hospitals?|data holders?|data_holders?|Klinikum|Kliniken|Klinika)(?: \\(data_holder\\))?";
const reportGroup =
  `(?:regions?|bands?|age bands?|regions? and age bands?|age bands? and regions?|${holderGroup})`;

// Measurement vocabulary from the track data README, not request-specific plans.
const measurementLoincs: Readonly<Record<string, string>> = {
  hba1c: "4548-4",
  bmi: "39156-5",
  "systolic blood pressure": "8480-6",
  egfr: "62238-1",
  "egfr (kidney function)": "62238-1",
};

function providedMeasurement(
  item: string,
  definitions: { name: string; loinc: string }[],
): string | undefined {
  const text = item.toLowerCase().replace(/ values?$/, "");
  const codeOnly = text.match(/^loinc(?: code)? (\d+-\d+)$/);
  if (codeOnly) return codeOnly[1];
  const annotated = text.match(/^(.+?) \(loinc(?: code)? (\d+-\d+)\)$/);
  const name = (annotated ? annotated[1] : text).replace(/ values?$/, "");
  const defined = definitions.find((o) => o.name.toLowerCase() === name)?.loinc;
  const known = measurementLoincs[name];
  const explicit = annotated?.[2];
  const codes = new Set(
    [defined, known, explicit].filter((code) => code !== undefined),
  );
  if (codes.size > 1) throw new Error(`Conflicting LOINC codes for ${name}`);
  return defined ?? known ?? explicit;
}

/** Parse every conjunction before applying any part of an encounter sentence. */
function encounterClauses(text: string): Partial<EncounterFilter> {
  const result: Partial<EncounterFilter> = {};
  for (const clause of text.split(/ and (?:whose )?/i)) {
    const year = clause.match(/^(?:the )?start_date is in (\d{4})$/i);
    const diagnosis = clause.match(new RegExp(`^${primaryDiagnosis}$`, "i"));
    if (year) {
      if (result.start_year !== undefined) {
        throw new Error("Repeated start-year clause");
      }
      result.start_year = Number(year[1]);
    } else if (diagnosis) {
      if (result.primary_icd10_prefix !== undefined) {
        throw new Error("Repeated primary-diagnosis clause");
      }
      result.primary_icd10_prefix = diagnosis[1].toUpperCase();
    } else {
      throw new Error(`Unsupported encounter clause: ${clause}`);
    }
  }
  return result;
}

/** Extract an explicit metric label from a semicolon-separated suffix.
 *  Recognises: "; metric: foo_bar" and "; metrics: foo and bar"
 *  Returns { kind: "single", label } | { kind: "pair", count: label1, mean: label2 } | null
 */
function extractMetricSuffix(
  text: string,
): { kind: "single"; label: string } | {
  kind: "pair";
  count: string;
  mean: string;
} | null {
  // "; metric: label"
  const single = text.match(/;\s*metric:\s*([a-z][a-z0-9_]*)$/i);
  if (single) return { kind: "single", label: single[1] };
  // "; metrics: count_label and mean_label"
  const pair = text.match(
    /;\s*metrics:\s*([a-z][a-z0-9_]*)\s+and\s+([a-z][a-z0-9_]*)$/i,
  );
  if (pair) return { kind: "pair", count: pair[1], mean: pair[2] };
  return null;
}

/** A deliberately bounded grammar for the track's definition language.
 * Definitions are consumed in full. IDs and applicant metadata never select rules.
 * Aggregate report clauses take precedence over record delivery in the question
 * (as in the agreed aggregate plan for the hypertension medication request).
 */
export function parseRequest(request: unknown): ParseResult {
  const errors: { definition: string; reason: string }[] = [];
  const fail = (definition: string, reason: string) =>
    errors.push({ definition, reason });
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return {
      ok: false,
      errors: [{ definition: "request", reason: "Expected a request object" }],
    };
  }
  const raw = request as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id.trim()) {
    fail("id", "Expected a non-empty request id");
  }
  if (!Array.isArray(raw.definitions) || !raw.definitions.length) {
    fail("definitions", "Expected a non-empty array of definitions");
    return { ok: false, errors };
  }
  const question = typeof raw.question === "string" ? clean(raw.question) : "";
  const concepts: Concept[] = [];
  const observations: { name: string; loinc: string; latest: boolean }[] = [];
  let bands: AgeBand[] | undefined;
  let encounter: EncounterFilter | undefined;
  let active = false;
  let report: { original: string; group: string; body: string } | undefined;
  let ratio: {
    original: string;
    name: string;
    numerator: string;
    denominator: string;
  } | undefined;
  let records = false;
  let region: string | undefined;
  let cohortText: string | undefined;
  // Explicit metric label override (new-wording fixtures); takes precedence over derivation.
  let metricLabel: string | undefined;
  // Explicit mean-metric pair override; set by "Overall results only, ...; metrics: A and B".
  let meanMetricPair: { count: string; mean: string } | undefined;
  // Record types set by a "Requested tables:" definition (bypasses question parsing).
  let speRecordTypesDef: RecordType[] | undefined;
  let speLoincsDef: string[] | undefined;

  const mergeEncounter = (fields: Partial<EncounterFilter>) => {
    for (
      const key of [
        "encounter_type",
        "start_year",
        "primary_icd10_prefix",
      ] as const
    ) {
      if (
        encounter?.[key] !== undefined && fields[key] !== undefined &&
        encounter[key] !== fields[key]
      ) {
        throw new Error(`Conflicting encounter constraint: ${key}`);
      }
    }
    encounter = { ...encounter, ...fields, type: "encounter_filter" };
  };
  const add = (name: string, filter: CohortFilter) => {
    if (concepts.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`Duplicate concept: ${name}`);
    }
    concepts.push({ name, filter });
  };
  for (const definition of raw.definitions) {
    if (typeof definition !== "string") {
      fail(String(definition), "Expected a definition string");
      continue;
    }
    const d = clean(definition);
    let m: RegExpMatchArray | null;
    try {
      // -----------------------------------------------------------------------
      // No-op definitions: restate defaults that the system already enforces.
      // -----------------------------------------------------------------------
      if (
        /^Exclude patients who opted out(?: of reuse)?$/i.test(d)
      ) {
        // eligible_patients view already excludes opted-out patients; no-op.
      } else if (
        /^Use 31 December 2025 as the reference date(?:;\s*age is 2025 minus birth year)?$/i
          .test(d)
      ) {
        // Reference date is always 31 December 2025; no-op.
      } else if (
        // -----------------------------------------------------------------------
        // Age definition
        // -----------------------------------------------------------------------
        (m = d.match(/^(.+?) = aged (\d+) or older on 31 December 2025$/i))
      ) {
        add(m[1], { type: "age", min_age: Number(m[2]) });
      } else if (
        // -----------------------------------------------------------------------
        // ICD-10 condition definitions
        // Standard form:  "X = any condition(s) with ICD-10 code(s) starting with Y"
        // New form 1:     "X means a conditions.icd10 code beginning Y"
        // New form 2:     "X means a condition code beginning Y"
        // New form 3:     "X means conditions.icd10 beginning Y" (bare)
        // Combined:       "X means conditions.icd10 beginning Y; adults are 18 or older"
        //                 "X means conditions.icd10 beginning Y; adult means at least 18 years"
        //                 "X means conditions.icd10 beginning Y; age at least N"
        // -----------------------------------------------------------------------
        (m = d.match(
          new RegExp(
            `^(.+?) = any conditions? with (?:an? )?ICD-10 codes?(?: \\(icd10\\))? ${prefixVerb} ${prefixList}$`,
            "i",
          ),
        ))
      ) {
        add(m[1], {
          type: "has_condition",
          icd10_prefixes: m[2].toUpperCase().split(/ or /i),
        });
      } else if (
        // "X means a conditions.icd10 code beginning Y[; trailing clause]"
        // Accepts: "X means conditions.icd10 beginning Y"  (bare column reference)
        //          "X means a conditions.icd10 code beginning Y"
        //          "X means a condition code beginning Y"
        //          "X means condition ICD-10 code beginning Y"
        // Optional trailing: "; adults are 18 or older" / "; adult means at least 18 years" / "; age at least 18"
        (m = d.match(
          new RegExp(
            `^(.+?) means? (?:(?:a |an )?(?:conditions?\\.icd10(?: (?:ICD-10 )?codes?)?|condition (?:ICD-10 )?codes?)|conditions?\\.icd10) ${prefixVerbBare} ([A-Z][A-Z0-9.]*)(?:,\\s*regardless of conditions\\.csv)?(?:;\\s*(.+))?$`,
            "i",
          ),
        ))
      ) {
        const name = m[1].trim();
        const code = m[2].toUpperCase();
        add(name, { type: "has_condition", icd10_prefixes: [code] });
        // Optional trailing clause: "adults are 18 or older" / "adult means at least 18 years" / "age at least 18"
        if (m[3]) {
          const trail = m[3].trim();
          const ageM = trail.match(
            /^(?:adults? (?:are|means?|is) (?:aged? )?(?:at least )?(\d+)(?:\s+years?)?(?:\s+or\s+older)?|age (?:at least )?(\d+)(?:\s+or\s+older)?|adults? are (\d+) or older)$/i,
          );
          if (ageM) {
            const minAge = Number(ageM[1] ?? ageM[2] ?? ageM[3]);
            if (!concepts.some((c) =>
              c.filter.type === "age" && c.name.toLowerCase() === "adult"
            )) {
              add("Adult", { type: "age", min_age: minAge });
            }
          } else {
            throw new Error(`Unsupported trailing clause in condition definition: ${trail}`);
          }
        }
      } else if (
        // -----------------------------------------------------------------------
        // ATC medication definitions
        // Standard form:  "X = ATC code(s) starting with Y"
        // New form 1:     "X are prescriptions with ATC beginning Y"
        // New form 2:     "X means ATC beginning Y"
        // -----------------------------------------------------------------------
        d.split(/;\s*/).every((part) =>
          new RegExp(
            `^(.+?) = ATC codes?(?: \\(atc\\))? ${prefixVerb} ${prefixList}$`,
            "i",
          )
            .test(part)
        )
      ) {
        for (const part of d.split(/;\s*/)) {
          const match = part.match(
            new RegExp(
              `^(.+?) = ATC codes?(?: \\(atc\\))? ${prefixVerb} ${prefixList}$`,
              "i",
            ),
          )!;
          add(match[1], {
            type: "has_medication",
            atc_prefixes: match[2].toUpperCase().split(/ or /i),
            active_on_ref_date: true,
          });
        }
      } else if (
        // "X are prescriptions with ATC beginning Y" or "X means ATC beginning Y"
        (m = d.match(
          new RegExp(
            `^(.+?) (?:are prescriptions? with ATC|means? ATC) ${prefixVerbBare} ${prefixList}$`,
            "i",
          ),
        ))
      ) {
        add(m[1], {
          type: "has_medication",
          atc_prefixes: m[2].toUpperCase().split(/ or /i),
          active_on_ref_date: true,
        });
      } else if (
        // -----------------------------------------------------------------------
        // Sex definition
        // -----------------------------------------------------------------------
        (m = d.match(/^(.+?) = sex '(female|male)'$/i))
      ) {
        add(m[1], {
          type: "sex",
          value: m[2].toLowerCase() as "female" | "male",
        });
      } else if (
        // "Female sex; age N to M inclusive at the reference date"
        (m = d.match(
          /^(female|male) sex;\s*age (\d+) to (\d+) inclusive(?: at the reference date)?$/i,
        ))
      ) {
        const sexVal = m[1].toLowerCase() as "female" | "male";
        const minAge = Number(m[2]);
        const maxAge = Number(m[3]);
        // Unique synthetic names so they don't collide with user-defined concepts.
        if (
          !concepts.some((c) =>
            c.filter.type === "sex" && (c.filter as { value: string }).value === sexVal
          )
        ) {
          add(`_sex_${sexVal}`, { type: "sex", value: sexVal });
        }
        if (!concepts.some((c) => c.filter.type === "age")) {
          add(`_age_${minAge}_${maxAge}`, {
            type: "age",
            min_age: minAge,
            max_age: maxAge,
          });
        }
      } else if (
        // -----------------------------------------------------------------------
        // Age bands
        // -----------------------------------------------------------------------
        (m = d.match(/^Age bands on 31 December 2025: (.+)$/i))
      ) {
        if (bands) throw new Error("Multiple age-band definitions");
        bands = m[1].split(/,\s*/).map((part) => {
          const b = part.match(/^(\d+)(?:-(\d+)|(\+))$/);
          if (!b) throw new Error(`Unreadable age band: ${part}`);
          return {
            label: part,
            min_age: Number(b[1]),
            ...(b[2] ? { max_age: Number(b[2]) } : {}),
          };
        });
        if (
          bands.some((b, i) =>
            (b.max_age !== undefined && b.max_age < b.min_age) ||
            (i > 0 && b.min_age <= (bands![i - 1].max_age ?? Infinity))
          )
        ) {
          throw new Error("Age bands must be ordered and non-overlapping");
        }
      } else if (
        // -----------------------------------------------------------------------
        // Active-medication definition (two phrasings)
        // -----------------------------------------------------------------------
        /^A medication is active on 31 December 2025 if start_date is on or before that day and end_date is empty or on or after that day$/i
          .test(d) ||
        /^A prescription is current if it started on or before 31 December 2025 and its end date is (?:blank|empty|null) or on or after that date$/i
          .test(d)
      ) {
        active = true;
      } else if (
        // -----------------------------------------------------------------------
        // Latest-observation definition
        // Standard:   "Use the latest X (LOINC Y) per patient[; patients without X are left out]"
        // New form 1: "Use the last observation on or before the reference date with LOINC Y; do not average all visits"
        // New form 2: "Use each adult's latest observation through 31 December 2025 with LOINC Y"
        // -----------------------------------------------------------------------
        (m = d.match(
          /^Use the latest (.+?) \(LOINC (\d+-\d+)\) per patient(?:; patients without a (.+?) are left out)?$/i,
        ))
      ) {
        if (m[3] && m[3].toLowerCase() !== m[1].toLowerCase()) {
          throw new Error(
            "Excluded measurement differs from latest measurement",
          );
        }
        observations.push({ name: m[1], loinc: m[2], latest: true });
      } else if (
        // "Use the last observation on or before the reference date with LOINC Y; do not average all visits"
        (m = d.match(
          /^Use the last observation on or before the reference date with LOINC (\d+-\d+)(?:;[^.]+)?$/i,
        ))
      ) {
        const loinc = m[1];
        // Look up a human-readable name from the measurement vocabulary.
        const obsName = Object.entries(measurementLoincs).find(([, v]) =>
          v === loinc
        )?.[0] ?? loinc;
        observations.push({ name: obsName, loinc, latest: true });
      } else if (
        // "Use each adult's latest observation through 31 December 2025 with LOINC Y"
        // Apostrophe may be straight (') or curly (\u2019)
        (m = d.match(
          /^Use (?:each (?:adult[\u2019']s|patient[\u2019']s)|the) latest observation(?: through 31 December 2025)? with LOINC (\d+-\d+)$/i,
        ))
      ) {
        const loinc = m[1];
        const obsName = Object.entries(measurementLoincs).find(([, v]) =>
          v === loinc
        )?.[0] ?? loinc;
        observations.push({ name: obsName, loinc, latest: true });
      } else if (
        // -----------------------------------------------------------------------
        // Cohort + observation for SPE (new-wording fixtures):
        // "Cohort = X who have at least one Y value (LOINC Z)"  [existing]
        // "Cohort: adults aged at least N with a conditions.icd10 code beginning C and at least one X observation (LOINC Y)"
        // -----------------------------------------------------------------------
        (m = d.match(
          /^Cohort = (.+?) who have at least one (.+?) value \(LOINC (\d+-\d+)\)$/i,
        ))
      ) {
        cohortText = m[1];
        observations.push({ name: m[2], loinc: m[3], latest: false });
      } else if (
        // "Cohort: adults aged at least N with a conditions.icd10 code beginning CODE and at least one OBS_NAME observation (LOINC LOINC_CODE)"
        (m = d.match(
          /^Cohort:\s*adults aged at least (\d+) with (?:a |an )?conditions?\.icd10 code beginning ([A-Z][A-Z0-9.]*) and at least one (.+?) observation \(LOINC (\d+-\d+)\)$/i,
        ))
      ) {
        const minAge = Number(m[1]);
        const icd10 = m[2].toUpperCase();
        const obsName = m[3].trim();
        const loinc = m[4];
        // Synthesise concepts for age and condition without polluting existing namespace.
        if (!concepts.some((c) => c.filter.type === "age")) {
          add("_cohort_adult", { type: "age", min_age: minAge });
        }
        if (
          !concepts.some((c) =>
            c.filter.type === "has_condition" &&
            (c.filter as { icd10_prefixes: string[] }).icd10_prefixes.includes(icd10)
          )
        ) {
          add("_cohort_condition", {
            type: "has_condition",
            icd10_prefixes: [icd10],
          });
        }
        observations.push({ name: obsName, loinc, latest: false });
        // cohortText is used by the SPE path; for the stats path we don't need it.
        cohortText = `adults with _cohort_condition`;
      } else if (
        // -----------------------------------------------------------------------
        // Encounter type definition
        // -----------------------------------------------------------------------
        (m = d.match(
          /^(.+?) = encounters? with type '(inpatient|outpatient|emergency)'$/i,
        ))
      ) {
        mergeEncounter({
          encounter_type: m[2].toLowerCase() as
            | "inpatient"
            | "outpatient"
            | "emergency",
        });
      } else if (
        // "Inpatient encounters only, start date in calendar year YYYY"
        (m = d.match(
          /^Inpatient (?:encounters?|stays?) only,?\s*start date in (?:calendar year )?(\d{4})$/i,
        ))
      ) {
        mergeEncounter({
          encounter_type: "inpatient",
          start_year: Number(m[1]),
        });
      } else if (
        // "Only inpatient stays starting in YYYY; encounters.primary_icd10 begins CODE"
        // "Only inpatient encounters beginning in YYYY; primary_icd10 begins CODE"
        (m = d.match(
          /^Only inpatient (?:stays?|encounters?) (?:starting|beginning) in (\d{4});\s*(?:encounters?\.)?primary_icd10 begins? ([A-Z][A-Z0-9.]*)$/i,
        ))
      ) {
        mergeEncounter({
          encounter_type: "inpatient",
          start_year: Number(m[1]),
          primary_icd10_prefix: m[2].toUpperCase(),
        });
      } else if (
        (m = d.match(
          /^Count (inpatient )?(?:stays?|encounters?)(?: \(not patients?\))? (?:whose|with) (.+)$/i,
        ))
      ) {
        mergeEncounter({
          ...encounterClauses(m[2]),
          ...(m[1] ? { encounter_type: "inpatient" as const } : {}),
        });
      } else if (
        (m = d.match(
          new RegExp(
            `^(?:[^=]+ = )?(?:(stays?|encounters?|inpatient stays?) with )?${primaryDiagnosis}$`,
            "i",
          ),
        ))
      ) {
        mergeEncounter({
          primary_icd10_prefix: m[2].toUpperCase(),
          ...(m[1]?.toLowerCase().startsWith("inpatient")
            ? { encounter_type: "inpatient" as const }
            : {}),
        });
      } else if (
        // "X means encounters.primary_icd10 beginning CODE[, regardless of conditions.csv]"
        // This explicitly sets a primary_icd10 encounter filter.
        (m = d.match(
          /^(?:.+? means? )?encounters?\.primary_icd10 (?:begins?|beginning) ([A-Z][A-Z0-9.]*)(?:,\s*regardless of conditions\.csv)?$/i,
        ))
      ) {
        mergeEncounter({ primary_icd10_prefix: m[1].toUpperCase() });
      } else if (
        // -----------------------------------------------------------------------
        // Ratio definition
        // -----------------------------------------------------------------------
        (m = d.match(/^(.+?) = (.+?) \/ (.+?) [×x] 100, one decimal$/i))
      ) {
        if (ratio) {
          throw new Error("Multiple ratio definitions are unsupported");
        }
        ratio = {
          original: definition,
          name: m[1],
          numerator: m[2],
          denominator: m[3],
        };
      } else if (
        // -----------------------------------------------------------------------
        // Report clauses — existing "Report per GROUP: BODY"
        // -----------------------------------------------------------------------
        (m = d.match(
          new RegExp(`^Report per (${reportGroup}): (.+)$`, "i"),
        ))
      ) {
        if (report) throw new Error("Multiple report clauses are unsupported");
        report = {
          original: definition,
          group: new RegExp(`^${holderGroup}$`, "i").test(m[1])
            ? "data_holder"
            : m[1].toLowerCase(),
          body: m[2],
        };
      } else if (
        // -----------------------------------------------------------------------
        // New-style simple count + explicit metric (no grouping)
        // "Count each adult (N years or older) once; metric: label"
        // "Count distinct people of any age; metric: label"
        // -----------------------------------------------------------------------
        // "once" is optional — "Count distinct people of any age; metric: X" works too.
        (m = d.match(
          /^Count (?:each )?(?:distinct )?(?:people|adults?)(?: \((\d+) years? or older\))?(?: of any age)?(?:\s+once)?;\s*metric:\s*([a-z][a-z0-9_]*)$/i,
        ))
      ) {
        if (report) throw new Error("Multiple report clauses are unsupported");
        const minAge = m[1] ? Number(m[1]) : undefined;
        const label = m[2];
        if (
          minAge !== undefined &&
          !concepts.some((c) => c.filter.type === "age")
        ) {
          add("Adult", { type: "age", min_age: minAge });
        }
        metricLabel = label;
        // Synthesise a report body: use "adults with <concept>" or "patients with <concept>".
        // Will be resolved later using the concept list. Use sentinel group "".
        report = { original: definition, group: "", body: "_count_metric_only" };
      } else if (
        // -----------------------------------------------------------------------
        // New-style grouped count + explicit metric
        // "Group by patients.data_holder, include all hospitals, and count each adult once; metric: label"
        // "All ages, grouped by patients.data_holder; metric: label"
        // "Group by patients.data_holder, count distinct patients; metric: label"
        // -----------------------------------------------------------------------
        (m = d.match(
          /^(?:(?:Group by (patients?\.data_holder|encounters?\.data_holder|patients?\.region)(?:,\s*(?:include all (?:hospitals?|three hospitals?)|not .+?)?)?,\s*(?:count (?:each )?(?:distinct )?(?:adults?|patients?|encounters?)(?:\s+once)?|include .+?))|(?:All ages,\s*grouped by (patients?\.data_holder|encounters?\.data_holder|patients?\.region)));\s*metric:\s*([a-z][a-z0-9_]*)$/i,
        ))
      ) {
        if (report) throw new Error("Multiple report clauses are unsupported");
        const groupCol = (m[1] ?? m[2]).toLowerCase();
        const label = m[3];
        const groupKey = /region/.test(groupCol) ? "region" : "data_holder";
        // Check if "each adult" implies an age filter.
        if (
          /count each adult/i.test(d) &&
          !concepts.some((c) => c.filter.type === "age")
        ) {
          add("Adult", { type: "age", min_age: 18 });
        }
        metricLabel = label;
        report = {
          original: definition,
          group: groupKey,
          body: "_count_metric_only",
        };
      } else if (
        // -----------------------------------------------------------------------
        // New-style grouped count with encounter counting
        // "Group by encounters.data_holder, not the patient's home region or record holder; include all three hospitals"
        // "Group by patients.region, including every region; count encounters rather than distinct people"
        // -----------------------------------------------------------------------
        (m = d.match(
          /^Group by (patients?\.data_holder|encounters?\.data_holder|patients?\.region)(?:,\s*(?:not .+?|including every region))?(?:;\s*(?:include all .+?|count encounters rather than distinct people))?$/i,
        ))
      ) {
        if (report) throw new Error("Multiple report clauses are unsupported");
        const groupCol = m[1].toLowerCase();
        const groupKey = /region/.test(groupCol) ? "region" : "data_holder";
        report = {
          original: definition,
          group: groupKey,
          body: "_encounter_count",
        };
      } else if (
        // -----------------------------------------------------------------------
        // New-style encounter count + explicit metric (no grouping)
        // "Count distinct encounter_id, not patients; no grouping. Metric: label"
        // -----------------------------------------------------------------------
        (m = d.match(
          /^Count distinct encounter(?:_id|s?),? not patients?(?:;\s*no grouping)?\.?\s*[Mm]etric:\s*([a-z][a-z0-9_]*)$/i,
        ))
      ) {
        if (report) throw new Error("Multiple report clauses are unsupported");
        metricLabel = m[1];
        report = { original: definition, group: "", body: "_encounter_count" };
      } else if (
        // "Count distinct encounters; metric: label"
        // If a grouping report already exists (from "Group by..."), only update the metric label.
        (m = d.match(
          /^Count distinct encounters?;\s*metric:\s*([a-z][a-z0-9_]*)$/i,
        ))
      ) {
        metricLabel = m[1];
        if (!report) {
          report = { original: definition, group: "", body: "_encounter_count" };
        }
      } else if (
        // -----------------------------------------------------------------------
        // New-style mean report without grouping
        // "Overall results only, one decimal for the mean; metrics: hba1c_measured and hba1c_mean"
        // "No grouping; mean to one decimal. Metrics: label1 and label2"
        // -----------------------------------------------------------------------
        // Separator between the intro clause and "metrics:" may be ";" (semicolon) or "." (period).
        (m = d.match(
          /^(?:Overall results only,\s*one decimal for the mean|No grouping;\s*mean to one decimal)[;.]\s*[Mm]etrics?:\s*([a-z][a-z0-9_]*)\s+and\s+([a-z][a-z0-9_]*)$/i,
        ))
      ) {
        if (report) throw new Error("Multiple report clauses are unsupported");
        meanMetricPair = { count: m[1], mean: m[2] };
        // Use a synthetic body; actual metrics come from meanMetricPair.
        report = { original: definition, group: "", body: "_mean_metric_only" };
      } else if (
        // -----------------------------------------------------------------------
        // Standalone "Metric: label" — sets the explicit label for encounter-count
        // or simple-count plans where no other report clause is needed.
        // -----------------------------------------------------------------------
        (m = d.match(/^[Mm]etric:\s*([a-z][a-z0-9_]*)$/i))
      ) {
        metricLabel = m[1];
        if (!report) {
          // Sentinel report: will be resolved in the plan-building section.
          report = { original: definition, group: "", body: "_metric_only" };
        }
      } else if (
        // -----------------------------------------------------------------------
        // "If aggregate access suffices, report the single metric cohort_size"
        // (J56 downgrade clause)
        // -----------------------------------------------------------------------
        /^If aggregate access suffices,?\s*report the single metric cohort_size$/i
          .test(d)
      ) {
        if (!report) {
          metricLabel = "cohort_size";
          report = {
            original: definition,
            group: "",
            body: "_count_metric_only",
          };
          records = false;
        }
      } else if (
        // -----------------------------------------------------------------------
        // "Requested tables: X and Y, restricting observations to LOINC Z; ..."
        // SPE table definition; sets record types without needing the question.
        // -----------------------------------------------------------------------
        (m = d.match(
          /^Requested tables?:\s*(.+?),\s*restricting observations to LOINC (\d+-\d+)(?:;.+)?$/i,
        ))
      ) {
        const tableList = m[1].toLowerCase().split(/\s*(?:,\s*|\s+and\s+)/).map(
          (t) => t.trim(),
        ).filter(Boolean);
        const loinc = m[2];
        const validTypes = ["conditions", "medications", "observations", "encounters"];
        const resolvedTypes: RecordType[] = [];
        for (const t of tableList) {
          if (validTypes.includes(t)) {
            resolvedTypes.push(t as RecordType);
          } else {
            throw new Error(`Unknown requested table: ${t}`);
          }
        }
        // Ensure observations is included (needed for LOINC restriction).
        if (!resolvedTypes.includes("observations")) {
          resolvedTypes.push("observations");
        }
        speRecordTypesDef = [...new Set(resolvedTypes)];
        speLoincsDef = [loinc];
        records = true;
      } else if (
        // -----------------------------------------------------------------------
        // "Requested tables: X and Y; ..." (without LOINC restriction)
        // -----------------------------------------------------------------------
        (m = d.match(
          /^Requested tables?:\s*(.+?)(?:;.+)?$/i,
        ))
      ) {
        // Only match if no LOINC restriction (already handled above).
        const tableStr = m[1];
        // If this actually contains "restricting observations to LOINC", skip (handled above).
        if (/restricting observations to LOINC/i.test(tableStr)) {
          fail(definition, "Unsupported definition or phrasing; no rule consumes the complete definition");
          continue;
        }
        const tableList = tableStr.toLowerCase().split(/\s*(?:,\s*|\s+and\s+)/).map(
          (t) => t.trim(),
        ).filter(Boolean);
        const validTypes = ["conditions", "medications", "observations", "encounters"];
        const resolvedTypes: RecordType[] = [];
        for (const t of tableList) {
          if (validTypes.includes(t)) {
            resolvedTypes.push(t as RecordType);
          } else {
            throw new Error(`Unknown requested table: ${t}`);
          }
        }
        speRecordTypesDef = [...new Set(resolvedTypes)];
        records = true;
      } else if (
        /^Report the size of the cohort you would make available$/i.test(d)
      ) {
        records = true;
      } else if (
        (m = d.match(
          /^Report for each patient in ([\p{L} -]+): patient ID, birth date and date of the (.+?) diagnosis$/iu,
        ))
      ) {
        region = m[1];
        cohortText = `adults with ${m[2]}`;
        records = true;
      } else {
        fail(
          definition,
          "Unsupported definition or phrasing; no rule consumes the complete definition",
        );
      }
    } catch (error) {
      fail(definition, (error as Error).message);
    }
  }

  // Substitute only names defined by this request, never a fixed disease/code map.
  const tokenize = (text: string): string => {
    let result = text.toLowerCase();
    const replacements = [
      ...concepts.map((c, i) => ({ name: c.name, token: `concept${i}` })),
      ...observations.map((o, i) => ({ name: o.name, token: `obs${i}` })),
    ].sort((a, b) => b.name.length - a.name.length);
    for (const { name, token } of replacements) {
      result = result.replace(
        new RegExp(`\\b${escape(name.toLowerCase())}\\b`, "g"),
        token,
      );
    }
    return result;
  };
  const countPhrase = (text: string): boolean => {
    const t = tokenize(text).replace(/^number of /, "");
    // An undefined population must not silently become an all-patient count.
    if (
      /\badults?\b/.test(t) &&
      !concepts.some((c) =>
        c.filter.type === "age" && c.name.toLowerCase() === "adult"
      )
    ) return false;
    if (/\b(?:women|men)\b/.test(t)) return false;
    if (/^inpatient stays?$/.test(t)) {
      return encounter?.encounter_type === "inpatient";
    }
    if (/^(?:stays?|encounters?)$/.test(t)) return encounter !== undefined;
    // Encounter predicates currently select an encounter counting unit. Never
    // interpret a patient count as a stay count merely because both use visits.
    if (encounter) return false;
    return /^(?:all )?(?:adults?|patients?|women|men|concept\d+)(?: with (?:an? )?(?:active )?concept\d+)?(?: who have (?:an? |at least one )?obs\d+ value| with a obs\d+)?$/
      .test(t);
  };
  if (cohortText && !countPhrase(cohortText) && cohortText !== "adults with _cohort_condition") {
    fail(cohortText, "Unrecognised cohort expression");
  }
  if (observations.length > 1) {
    fail("LOINC", "Only one measurement concept is supported per request");
  }
  const meds = concepts.filter((c) => c.filter.type === "has_medication");
  if (meds.length && !active) {
    fail(
      "active medication",
      "Medication filters require the explicit active-on-31-December-2025 definition",
    );
  }
  const cohort: CohortFilter[] = concepts.filter((c) =>
    c.filter.type !== "has_medication"
  ).map((c) => c.filter);
  const age = question.match(/aged (\d+) (?:and over|or older)/i);
  if (age && !cohort.some((f) => f.type === "age")) {
    cohort.push({ type: "age", min_age: Number(age[1]) });
  }
  for (const observation of observations) {
    cohort.push({ type: "has_observation", loinc: observation.loinc });
  }
  if (region) cohort.push({ type: "region", value: region });
  if (encounter) cohort.push(encounter);
  const plan: QueryPlan = {
    request_id: typeof raw.id === "string" ? raw.id : "",
    cohort_filters: cohort,
    count_unit: encounter ? "encounter" : "patient",
    metrics: [{ type: "count", label: "cohort" }],
  };
  const metrics = plan.metrics;
  if (report) {
    const dimensions: Grouping[] = [];
    // Canonical outer dimension is age, matching the agreed cross-tab contract.
    if (/band/.test(report.group)) {
      if (!bands) {
        fail(report.original, "Age grouping requires explicit age bands");
      } else dimensions.push({ by: "age_band", bands });
    }
    if (/region/.test(report.group)) dimensions.push({ by: "region" });
    if (/hospital|data holder|data_holder/.test(report.group)) {
      dimensions.push({ by: "data_holder" });
    }
    if (dimensions.length > 0) plan.dimensions = dimensions;

    // Sentinel bodies from new-style report clauses
    if (report.body === "_mean_metric_only") {
      // Non-grouped mean report with explicit metric labels.
      if (!meanMetricPair) {
        fail(report.original, "Mean metric pair not defined");
      } else if (observations.length !== 1 || !observations[0].latest) {
        fail(
          report.original,
          "Mean requires an explicitly latest LOINC measurement",
        );
      } else {
        const obsLabel = toLabel(observations[0].name);
        // Use the explicit labels from the "metrics: A and B" clause.
        metrics[0].label = meanMetricPair.count;
        metrics.push({
          type: "mean_observation",
          label: meanMetricPair.mean,
          loinc: observations[0].loinc,
          use_latest: true,
        });
        // Ensure the cohort has a compatible filter for the observation.
        // (has_observation already added above from the observation list)
        // The count phrase check is skipped for mean reports using explicit metrics.
        void obsLabel; // label used for reference only
      }
    } else if (report.body === "_count_metric_only" || report.body === "_metric_only") {
      // Simple count with an explicit metric label; no body-phrase counting needed.
      if (!metricLabel) {
        fail(report.original, "Metric label required for this report style");
      } else {
        // Add any medication filters to cohort (existing logic).
        for (const medication of meds) {
          cohort.push(medication.filter);
        }
        metrics[0].label = metricLabel;
      }
    } else if (report.body === "_encounter_count") {
      // Encounter count with an explicit metric label; no body-phrase needed.
      if (!metricLabel) {
        fail(report.original, "Metric label required for this encounter count");
      } else {
        metrics[0].label = metricLabel;
      }
    } else {
      // -----------------------------------------------------------------------
      // Existing report-body logic (standard "Report per ..." clauses)
      // -----------------------------------------------------------------------
      let body = report.body.replace(/(?:,? (?:with )?one decimal)$/, "");
      const mean = body.match(/^(.+?) and (?:their )?mean (.+)$/i);
      const gap = body.match(
        /^(.+?), how many of them have no active (.+?) and that share in %$/i,
      );
      const percentages = body.split(/,\s*% with an active /i);
      if (ratio) {
        const suffix = new RegExp(` and (?:the )?${escape(ratio.name)}$`, "i");
        if (!suffix.test(body)) {
          fail(report.original, "Report does not name the defined percentage");
        }
        body = body.replace(suffix, "");
        const comma = body.indexOf(",");
        if (
          comma < 0 || !countPhrase(body.slice(0, comma)) ||
          !countPhrase(body.slice(comma + 1).trim())
        ) {
          fail(
            report.original,
            "Expected denominator and numerator counts before the percentage",
          );
        }
        const denominator = ratio.denominator.replace(/ in the region$/i, "");
        if (
          !countPhrase(ratio.numerator) || !countPhrase(denominator) ||
          tokenize(denominator).replace(/^all /, "") !==
            tokenize(body.slice(0, comma))
        ) fail(ratio.original, "Unsupported percentage numerator or denominator");
        const subset = concepts.filter((c) => c.filter.type === "has_condition");
        if (
          subset.length !== 1 ||
          tokenize(ratio.numerator) !== tokenize(body.slice(comma + 1).trim())
        ) fail(ratio.original, "Cannot resolve percentage subset");
        for (const c of subset) cohort.splice(cohort.indexOf(c.filter), 1);
        // Derive labels from request text:
        // cohort denominator = first item before comma in the body
        // subset = condition concept name
        // percentage = ratio definition name + _pct
        const cohortLabel = deriveCohortLabel(
          body.slice(0, comma),
          concepts,
          observations,
          tokenize,
        );
        const subsetLabel = toLabel(subset[0].name);
        const pctLabel = `${toLabel(ratio.name)}_pct`;
        metrics[0].label = metricLabel ?? cohortLabel;
        metrics.push({
          type: "count",
          label: subsetLabel,
          filters: subset.map((c) => c.filter),
        }, {
          type: "percentage",
          label: pctLabel,
          numerator_label: subsetLabel,
          denominator_label: metrics[0].label,
        });
      } else if (mean) {
        const observation = observations.find((o) =>
          o.name.toLowerCase() === mean[2].toLowerCase()
        );
        if (!countPhrase(mean[1]) || !observation?.latest) {
          fail(
            report.original,
            "Mean requires a recognised count and an explicitly latest LOINC measurement",
          );
        } else {
          // Derive labels: count = patients_with_<obs> (or women/men_with_<obs>)
          // mean = mean_<obs>
          const obsLabel = toLabel(observation.name);
          const countLabel = deriveCohortLabel(
            mean[1],
            concepts,
            observations,
            tokenize,
          );
          const meanLabel = `mean_${obsLabel}`;
          metrics[0].label = metricLabel ?? countLabel;
          metrics.push({
            type: "mean_observation",
            label: meanLabel,
            loinc: observation.loinc,
            use_latest: true,
          });
        }
      } else if (gap) {
        const medication = meds.find((c) =>
          c.name.toLowerCase() === gap[2].toLowerCase()
        );
        if (!countPhrase(gap[1]) || !medication) {
          fail(report.original, "Unrecognised treatment-gap count or medication");
        } else {
          // Derive labels: cohort = deriveCohortLabel from gap denominator phrase
          // without = without_<acronym(medication)>
          // share = share_without_<acronym(medication)>_pct
          const cohortLabel = deriveCohortLabel(
            gap[1],
            concepts,
            observations,
            tokenize,
          );
          const medAcronym = clinicalAcronym(medication.name);
          const withoutLabel = `without_${medAcronym}`;
          const shareLabel = `share_without_${medAcronym}_pct`;
          metrics[0].label = metricLabel ?? cohortLabel;
          metrics.push({
            type: "count",
            label: withoutLabel,
            filters: [{ ...medication.filter, negate: true } as CohortFilter],
          }, {
            type: "percentage",
            label: shareLabel,
            numerator_label: withoutLabel,
            denominator_label: metrics[0].label,
          });
        }
      } else if (percentages.length > 1) {
        if (!countPhrase(percentages[0])) {
          fail(report.original, "Unrecognised denominator count");
        }
        // Derive cohort label from the denominator phrase (percentages[0])
        const cohortLabel = deriveCohortLabel(
          percentages[0],
          concepts,
          observations,
          tokenize,
        );
        metrics[0].label = metricLabel ?? cohortLabel;
        for (const [i, name] of percentages.slice(1).entries()) {
          const medication = meds.find((c) =>
            c.name.toLowerCase() === name.toLowerCase()
          );
          if (!medication) fail(report.original, `Undefined medication: ${name}`);
          else {
            // Derive percentage label: medication name snake_case + _pct
            const pctLabel = `${toLabel(medication.name)}_pct`;
            metrics.push({
              type: "percentage",
              label: pctLabel,
              numerator_filters: [medication.filter],
              denominator_label: metrics[0].label,
            });
          }
        }
      } else {
        if (!countPhrase(body)) {
          fail(
            report.original,
            encounter && /\b(?:patients?|adults?)\b/i.test(body)
              ? "Patient counts with encounter filters require review: counting stays would give a different number"
              : "Unsupported report count or metric",
          );
        }
        for (const medication of meds) {
          if (
            !tokenize(body).includes(`concept${concepts.indexOf(medication)}`)
          ) {
            fail(
              report.original,
              `Medication ${medication.name} has no supported use in the report`,
            );
          } else cohort.push(medication.filter);
        }
        // Derive the single count label from the report body phrase
        metrics[0].label = metricLabel ?? deriveCohortLabel(
          body,
          concepts,
          observations,
          tokenize,
        );
      }
    }
  } else if (records) {
    const recordTypes: RecordType[] = [];
    const providedLoincs = new Set<string>();
    let allObservations = false;

    if (speRecordTypesDef) {
      // Tables were set by a "Requested tables:" definition — use them directly.
      for (const rt of speRecordTypesDef) {
        recordTypes.push(rt);
        if (rt === "observations") allObservations = true;
      }
      if (speLoincsDef) {
        for (const loinc of speLoincsDef) providedLoincs.add(loinc);
        allObservations = false; // LOINC-restricted, not all observations
      }
    } else {
      const list = question.match(/^Provide pseudonymised (.+?) for /i);
      if (list && !/^records\b/i.test(list[1])) {
        const items = list[1].split(/,\s*| and /i);
        for (const item of items) {
          if (/^(conditions|medications|encounters|observations)$/i.test(item)) {
            recordTypes.push(item.toLowerCase() as RecordType);
            if (/^observations$/i.test(item)) allObservations = true;
          } else {
            try {
              const loinc = providedMeasurement(item, observations);
              if (loinc) {
                recordTypes.push("observations");
                providedLoincs.add(loinc);
              } else {
                fail(
                  question,
                  `Unsupported record type or measurement: ${item}`,
                );
              }
            } catch (error) {
              fail(question, (error as Error).message);
            }
          }
        }
      } else if (
        region &&
        /^Provide records of all adults with a .+ diagnosis in /i.test(question)
      ) {
        recordTypes.push("conditions");
      } else {
        fail(
          question || "question",
          "Cannot resolve requested record tables",
        );
      }
    }

    plan.spe_record_types = [...new Set(recordTypes)];
    if (!allObservations && providedLoincs.size) {
      plan.spe_observation_loincs = [...providedLoincs];
    }
    // SPE requests report the cohort size, not a report-derived label
    metrics[0].label = "cohort_size";
  } else fail("definitions", "No supported report clause found");
  if (errors.length) return { ok: false, errors };
  const validated = validatePlan(plan);
  if (!validated.ok) {
    return {
      ok: false,
      errors: validated.errors.map((e) => ({
        definition: e.path,
        reason: e.message,
      })),
    };
  }
  return { ok: true, plan: validated.plan };
}
