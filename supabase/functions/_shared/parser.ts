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
const prefixList = "([A-Z][A-Z0-9.]*(?: or [A-Z][A-Z0-9.]*)*)";
// Shared, non-capturing grammar fragments keep synonymous prefix predicates
// consistent across diagnosis, condition and medication rules.
const prefixVerb =
  "(?:starting with|starts? with|beginning with|that starts? with)";
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
      if ((m = d.match(/^(.+?) = aged (\d+) or older on 31 December 2025$/i))) {
        add(m[1], { type: "age", min_age: Number(m[2]) });
      } else if (
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
      } else if ((m = d.match(/^(.+?) = sex '(female|male)'$/i))) {
        add(m[1], {
          type: "sex",
          value: m[2].toLowerCase() as "female" | "male",
        });
      } else if ((m = d.match(/^Age bands on 31 December 2025: (.+)$/i))) {
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
        /^A medication is active on 31 December 2025 if start_date is on or before that day and end_date is empty or on or after that day$/i
          .test(d)
      ) {
        active = true;
      } else if (
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
        (m = d.match(
          /^Cohort = (.+?) who have at least one (.+?) value \(LOINC (\d+-\d+)\)$/i,
        ))
      ) {
        cohortText = m[1];
        observations.push({ name: m[2], loinc: m[3], latest: false });
      } else if (
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
    return /^(?:all )?(?:adults?|patients?|women|men|concept\d+)(?: with (?:an? )?(?:active )?concept\d+)?(?: who have (?:an? |at least one )?obs\d+ value| with a obs\d+)?$/
      .test(t);
  };
  if (cohortText && !countPhrase(cohortText)) {
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
    plan.dimensions = dimensions;
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
      metrics.push({
        type: "count",
        label: "subset",
        filters: subset.map((c) => c.filter),
      }, {
        type: "percentage",
        label: "percentage",
        numerator_label: "subset",
        denominator_label: "cohort",
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
        metrics.push({
          type: "mean_observation",
          label: "mean",
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
        metrics.push({
          type: "count",
          label: "without_medication",
          filters: [{ ...medication.filter, negate: true } as CohortFilter],
        }, {
          type: "percentage",
          label: "percentage",
          numerator_label: "without_medication",
          denominator_label: "cohort",
        });
      }
    } else if (percentages.length > 1) {
      if (!countPhrase(percentages[0])) {
        fail(report.original, "Unrecognised denominator count");
      }
      for (const [i, name] of percentages.slice(1).entries()) {
        const medication = meds.find((c) =>
          c.name.toLowerCase() === name.toLowerCase()
        );
        if (!medication) fail(report.original, `Undefined medication: ${name}`);
        else {
          metrics.push({
            type: "percentage",
            label: `medication_${i}`,
            numerator_filters: [medication.filter],
            denominator_label: "cohort",
          });
        }
      }
    } else {
      if (!countPhrase(body)) {
        fail(report.original, "Unsupported report count or metric");
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
    }
  } else if (records) {
    const recordTypes: RecordType[] = [];
    const providedLoincs = new Set<string>();
    let allObservations = false;
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
            } else {fail(
                question,
                `Unsupported record type or measurement: ${item}`,
              );}
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
    plan.spe_record_types = [...new Set(recordTypes)];
    if (!allObservations && providedLoincs.size) {
      plan.spe_observation_loincs = [...providedLoincs];
    }
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
