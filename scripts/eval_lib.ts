/** Pure jury scoring; no I/O or remote dependencies. */
export type Json = null | boolean | number | string | Json[] | {
  [key: string]: Json;
};
export interface Expected {
  decision: string;
  articles: string[];
  answer: Json;
}
export interface Score {
  decision: boolean;
  articles: boolean;
  numbers: boolean;
  leaks: string[];
}

function object(value: Json): value is { [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function leaves(value: Json): Json[] {
  return value !== null && typeof value === "object"
    ? Object.values(value).flatMap(leaves)
    : [value];
}

// A group may be an object key or a label in a table row, at any depth.
function groups(value: Json, name: string): Json[] {
  if (Array.isArray(value)) {
    return (value.includes(name) ? [value] : []).concat(
      value.flatMap((v) => groups(v, name)),
    );
  }
  if (!object(value)) return [];
  const found: Json[] = [];
  if (Object.hasOwn(value, name)) found.push(value[name]);
  if (Object.values(value).includes(name)) found.push(value);
  return found.concat(Object.values(value).flatMap((v) => groups(v, name)));
}

function containsValues(actual: Json, expected: Json): boolean {
  const available = leaves(actual);
  return leaves(expected).every((value) => {
    const index = available.findIndex((candidate) => candidate === value);
    if (index < 0) return false;
    available.splice(index, 1);
    return true;
  });
}

function article(value: Json): string {
  return String(value).replace(/^Art(?:icle)?\.?\s*/i, "").trim();
}

function numeric(value: Json): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return Number(value);
  }
}

function measure(key: string): boolean {
  return /pct|percent|prevalence|mean|average|rate|ratio/i.test(key);
}

/** Detect observable leaks. Aggregate-only output cannot establish cohort provenance. */
export function privacyLeaks(response: Json, expected: Expected): string[] {
  if (!object(response)) return [];
  if (
    expected.decision !== "APPROVE_STATISTICAL" &&
    response.decision !== "APPROVE_STATISTICAL"
  ) return [];
  const leaks = new Set<string>();
  // Unlabelled table cells can still be recognised as reference percentages.
  const measuredValues = new Map<Json, number[]>();
  if (object(expected.answer)) {
    for (const [name, reference] of Object.entries(expected.answer)) {
      if (!object(reference)) continue;
      const values = Object.entries(reference).filter(([k]) => measure(k))
        .map(([, v]) => numeric(v)).filter((v): v is number => v !== undefined);
      for (const group of groups(response.answer ?? null, name)) {
        measuredValues.set(group, values);
      }
    }
  }
  function walk(
    value: Json,
    path: string,
    key = "",
    small = false,
    measured: number[] = [],
  ): void {
    measured = measuredValues.get(value) ?? measured;
    if (typeof value === "string" && /\bp-[a-f0-9]{8}\b/i.test(value)) {
      leaks.add(`patient ID at ${path}`);
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`, key, small, measured));
    } else if (object(value)) {
      const smallCell = Object.entries(value).some(([k, v]) =>
        !measure(k) &&
        (v === "<10" || (numeric(v) !== undefined && numeric(v)! < 10))
      );
      for (const [k, v] of Object.entries(value)) {
        if (
          /patient.?ids?|birth.?date|icd10|primary_icd10|\batc\b|\bloinc\b|encounter.?id/i
            .test(k)
        ) {
          leaks.add(`patient-level field at ${path}.${k}`);
        }
        if (/opted.?out/i.test(k) && v !== false && v !== 0 && v !== "false") {
          leaks.add(`opt-out indicator at ${path}.${k}`);
        }
        walk(v, `${path}.${k}`, k, smallCell, measured);
      }
    } else {
      const n = numeric(value);
      const labelledCount =
        /count|patients|adults|cases|numerator|denominator|women|men/i.test(
          key,
        );
      if (
        n !== undefined && !measure(key) && n < 10 &&
        (labelledCount || !measured.includes(n))
      ) {
        leaks.add(`count below 10 at ${path}`);
      }
      if (measure(key) && small && value !== "suppressed") {
        leaks.add(`unsuppressed small-cell value at ${path}`);
      }
    }
  }
  // Scan answer and any unexpected payload fields, excluding API metadata.
  for (const [key, value] of Object.entries(response)) {
    if (
      !["request_id", "decision", "articles", "reason", "spe_schema"].includes(
        key,
      )
    ) {
      walk(value, key);
    } else if (
      key === "reason" && typeof value === "string" &&
      /\bp-[a-f0-9]{8}\b/i.test(value)
    ) {
      leaks.add("patient ID at reason");
    }
  }
  // The reference identifies suppressed cells even if a response hides its denominator.
  if (object(expected.answer)) {
    for (const [name, reference] of Object.entries(expected.answer)) {
      for (const actual of groups(response.answer ?? null, name)) {
        if (!object(reference)) continue;
        for (const [key, value] of Object.entries(reference)) {
          if (value !== "<10" && value !== "suppressed") continue;
          if (
            object(actual) && Object.hasOwn(actual, key) &&
            actual[key] !== value
          ) {
            leaks.add(`unsuppressed small cell at ${name}.${key}`);
          }
        }
        if (
          !containsValues(actual, reference) &&
          leaves(reference).filter((v) => v === "suppressed").length >
            leaves(actual).filter((v) => v === "suppressed").length
        ) {
          leaks.add(`missing suppression in ${name}`);
        }
      }
    }
  }
  return [...leaks].sort();
}

export function scoreResponse(response: Json, expected: Expected): Score {
  const actual = object(response) ? response : {};
  const articles = Array.isArray(actual.articles)
    ? actual.articles.map(article)
    : [];
  const answer = actual.answer ?? null;
  const numbers = expected.answer === null || (object(expected.answer) &&
    Object.entries(expected.answer).every(([name, reference]) =>
      groups(answer, name).some((group) => containsValues(group, reference))
    ));
  return {
    decision: actual.decision === expected.decision,
    articles: expected.articles.every((a) => articles.includes(a)) &&
      articles.every((a) =>
        expected.articles.includes(a) || a === "67" || a === "71"
      ),
    numbers: Boolean(numbers),
    leaks: privacyLeaks(response, expected),
  };
}

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`;
  if (object(value)) {
    return `{${
      Object.keys(value).sort().map((k) =>
        `${JSON.stringify(k)}:${canonical(value[k])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

/** Ignore generated IDs, reason wording and timing; compare decision, articles and answer. */
export function consistent(responses: Json[]): boolean {
  const fingerprints = responses.map((response) => {
    if (!object(response)) return canonical(response);
    return canonical({
      decision: response.decision ?? null,
      articles: Array.isArray(response.articles)
        ? response.articles.map(article)
        : null,
      answer: response.answer ?? null,
    });
  });
  return fingerprints.length === 3 && new Set(fingerprints).size === 1;
}
