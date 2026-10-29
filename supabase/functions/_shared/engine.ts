import { type CohortFilter, type QueryPlan, validatePlan } from "./plan.ts";

export interface Query {
  text: string;
  params: (string | number)[];
}
export interface BuiltQueries {
  /** Null entries are age bands, whose universe is supplied by the plan. */
  groups: (Query | null)[];
  /** One query per metric; labelled percentages reuse counts and have no query. */
  metrics: (Query | null)[];
}
type Row = Record<string, unknown>;
export interface SqlClient {
  unsafe(text: string, params: (string | number)[]): PromiseLike<Row[]>;
}
export type Value = number | "<10" | "suppressed";
export type Answer = { [key: string]: Value | Answer };

function assertPlan(plan: QueryPlan): void {
  const result = validatePlan(plan);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  const labels = new Set<string>();
  for (const metric of plan.metrics) {
    if (labels.has(metric.label)) throw new Error("Duplicate metric label");
    labels.add(metric.label);
    if (metric.type === "percentage") {
      for (const label of [metric.denominator_label, metric.numerator_label]) {
        if (
          label !== undefined &&
          !plan.metrics.some((m) => m.type === "count" && m.label === label)
        ) {
          throw new Error(`Percentage must reference a count: ${label}`);
        }
      }
    }
  }
}

/** All dynamic values are bound. SQL identifiers and syntax come only from code. */
export function buildQueries(plan: QueryPlan): BuiltQueries {
  assertPlan(plan);
  const encounter = plan.count_unit === "encounter";
  const from = "FROM public.eligible_patients AS p" +
    (encounter
      ? " JOIN public.encounters AS e ON e.patient_id = p.patient_id"
      : "");
  const dimensions = plan.dimensions ?? [];
  const groups = dimensions.map((d): Query | null => {
    if (d.by === "age_band") return null;
    // Group universes come from eligible patients, even if none has encounters.
    const column = d.by === "region" ? "p.region" : "p.data_holder";
    return {
      text:
        `SELECT DISTINCT ${column} AS value FROM public.eligible_patients AS p WHERE ${column} IS NOT NULL ORDER BY value`,
      params: [],
    };
  });
  const metrics = plan.metrics.map((metric): Query | null => {
    if (metric.type === "percentage" && metric.numerator_label !== undefined) {
      return null;
    }
    const params: (string | number)[] = [];
    const bind = (value: string | number) => {
      params.push(value);
      return `$${params.length}`;
    };
    const age = () =>
      `(${bind(2025)}::numeric - EXTRACT(YEAR FROM p.birth_date))`;
    const prefix = (column: string, values: string[]) =>
      "(" + values.map((v) => {
        const param = bind(v);
        // Literal prefix comparison: '%' and '_' in values are not wildcards.
        return `left(${column}, length(${param}::text)) = ${param}::text`;
      }).join(" OR ") + ")";
    const encounterPredicate = (
      f: Extract<CohortFilter, { type: "encounter_filter" }>,
      alias: string,
    ) => {
      const parts: string[] = [];
      if (f.encounter_type !== undefined) {
        parts.push(`${alias}.type = ${bind(f.encounter_type)}`);
      }
      if (f.start_year !== undefined) {
        parts.push(
          `EXTRACT(YEAR FROM ${alias}.start_date) = ${
            bind(f.start_year)
          }::numeric`,
        );
      }
      if (f.primary_icd10_prefix !== undefined) {
        parts.push(prefix(`${alias}.primary_icd10`, [f.primary_icd10_prefix]));
      }
      return parts.join(" AND ") || "TRUE";
    };
    const filter = (f: CohortFilter): string => {
      switch (f.type) {
        case "age":
          return `${age()} >= ${bind(f.min_age)}::numeric` +
            (f.max_age === undefined
              ? ""
              : ` AND ${age()} <= ${bind(f.max_age)}::numeric`);
        case "sex":
          return `p.sex = ${bind(f.value)}`;
        case "region":
          return `p.region = ${bind(f.value)}`;
        case "has_condition":
          return `EXISTS (SELECT 1 FROM public.conditions AS c WHERE c.patient_id = p.patient_id AND ${
            prefix("c.icd10", f.icd10_prefixes)
          })`;
        case "has_observation":
          return `EXISTS (SELECT 1 FROM public.observations AS o WHERE o.patient_id = p.patient_id AND o.loinc = ${
            bind(f.loinc)
          })`;
        case "has_medication": {
          const ref = bind("2025-12-31");
          return `${
            f.negate ? "NOT " : ""
          }EXISTS (SELECT 1 FROM public.medications AS m WHERE m.patient_id = p.patient_id AND ${
            prefix("m.atc", f.atc_prefixes)
          } AND m.start_date <= ${ref}::date AND (m.end_date IS NULL OR m.end_date >= ${ref}::date))`;
        }
        case "encounter_filter":
          return encounter
            ? encounterPredicate(f, "e")
            : `EXISTS (SELECT 1 FROM public.encounters AS ef WHERE ef.patient_id = p.patient_id AND ${
              encounterPredicate(f, "ef")
            })`;
      }
    };
    const joins: string[] = [];
    const columns = dimensions.map((d, i) => {
      if (d.by === "region") return "p.region";
      if (d.by === "data_holder") {
        return encounter ? "e.data_holder" : "p.data_holder";
      }
      const bands = d.bands.map((b) =>
        `SELECT ${bind(b.label)}::text AS label WHERE ${age()} >= ${
          bind(b.min_age)
        }::numeric` + (b.max_age === undefined
          ? ""
          : ` AND ${age()} <= ${bind(b.max_age)}::numeric`)
      );
      joins.push(
        `JOIN LATERAL (${bands.join(" UNION ALL ")}) AS band${i} ON TRUE`,
      );
      return `band${i}.label`;
    });
    let extra: CohortFilter[] = [];
    if (metric.type === "count") extra = metric.filters ?? [];
    if (metric.type === "percentage") {
      const denominator = plan.metrics.find((m) =>
        m.label === metric.denominator_label
      )!;
      extra = [
        ...(denominator.type === "count" ? denominator.filters ?? [] : []),
        ...metric.numerator_filters!,
      ];
    }
    const where = [...plan.cohort_filters, ...extra].map((f) =>
      `(${filter(f)})`
    ).join(" AND ") || "TRUE";
    const groupSelect = columns.map((c, i) =>
      `${c} AS g${i}`
    );
    const groupBy = columns.length ? ` GROUP BY ${columns.join(", ")}` : "";
    let text: string;
    if (metric.type === "mean_observation") {
      const loinc = bind(metric.loinc);
      // Deduplicate patients even when the counting unit is encounters.
      const inner = `SELECT DISTINCT ${
        [...groupSelect, "p.patient_id", "latest.value"].join(", ")
      } ${from} ${
        joins.join(" ")
      } JOIN LATERAL (SELECT o.value FROM public.observations AS o WHERE o.patient_id = p.patient_id AND o.loinc = ${loinc} ORDER BY o.date DESC NULLS LAST LIMIT 1) AS latest ON TRUE WHERE ${where}`;
      const aliases = columns.map((_, i) => `g${i}`);
      text =
        `SELECT ${
          [...aliases, "count(value)::text AS n", "sum(value)::text AS total"]
            .join(", ")
        } FROM (${inner}) AS per_patient` +
        (aliases.length ? ` GROUP BY ${aliases.join(", ")}` : "");
    } else {
      text = `SELECT ${
        [
          ...groupSelect,
          `count(DISTINCT ${
            encounter ? "e.encounter_id" : "p.patient_id"
          })::text AS n`,
        ].join(", ")
      } ${from} ${joins.join(" ")} WHERE ${where}${groupBy}`;
    }
    return { text, params };
  });
  return { groups, metrics };
}

/** Parse a base-ten value without binary floating-point arithmetic. */
function decimal(value: string | number): [bigint, bigint] {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(
    String(value),
  );
  if (!match) throw new Error("Invalid decimal value");
  const scale = (match[3]?.length ?? 0) - Number(match[4] ?? 0);
  let n = BigInt(match[2] + (match[3] ?? "")) * (match[1] === "-" ? -1n : 1n);
  if (scale < 0) n *= 10n ** BigInt(-scale);
  return [n, scale > 0 ? 10n ** BigInt(scale) : 1n];
}

function roundedRatio(n: bigint, d: bigint): number {
  if (d <= 0n) throw new Error("Invalid denominator");
  // Decimal half-up: ties round away from zero.
  const sign = n < 0n ? -1 : 1;
  const scaled = (n < 0n ? -n : n) * 10n;
  let quotient = scaled / d;
  const remainder = scaled % d;
  if (remainder * 2n >= d) quotient++;
  return sign * Number(quotient) / 10;
}

export function roundHalfUp(value: string | number): number {
  const [n, d] = decimal(value);
  return roundedRatio(n, d);
}

export type Statistic =
  | { type: "count"; n: string | number }
  | { type: "percentage"; n: string | number; denominator: string | number }
  | {
    type: "mean_observation";
    n: string | number;
    total: string | number | null;
  };

/** The single disclosure/rounding gate for every released statistical value. */
export function applySmallCell(stat: Statistic): Value {
  const n = BigInt(stat.n);
  if (stat.type === "count") return n < 10n ? "<10" : Number(n);
  if (n < 10n) return "suppressed";
  if (stat.type === "percentage") {
    const d = BigInt(stat.denominator);
    return d < 10n ? "suppressed" : roundedRatio(n * 100n, d);
  }
  if (stat.total === null) return "suppressed";
  const [total, scale] = decimal(stat.total);
  return roundedRatio(total, scale * n);
}

/** Execute only generated statements; no request prose enters this API. */
export async function runPlan(
  plan: QueryPlan,
  sql: SqlClient,
): Promise<Answer> {
  const queries = buildQueries(plan);
  const dimensions = plan.dimensions ?? [];
  const universes: string[][] = [];
  for (let i = 0; i < dimensions.length; i++) {
    const d = dimensions[i];
    const q = queries.groups[i];
    universes.push(
      d.by === "age_band"
        ? d.bands.map((b) => b.label)
        : (await sql.unsafe(q!.text, q!.params)).map((r) => String(r.value)),
    );
  }
  const rows: Map<string, Row>[] = [];
  for (const q of queries.metrics) {
    const result = q ? await sql.unsafe(q.text, q.params) : [];
    rows.push(
      new Map(result.map((r) => [
        JSON.stringify(dimensions.map((_, i) => String(r[`g${i}`]))),
        r,
      ])),
    );
  }
  const answer: Answer = Object.create(null);
  const fill = (keys: string[], target: Answer): void => {
    if (keys.length < dimensions.length) {
      for (const key of universes[keys.length]) {
        const child: Answer = Object.create(null);
        target[key] = child;
        fill([...keys, key], child);
      }
      return;
    }
    const key = JSON.stringify(keys);
    const count = (label: string) =>
      String(
        rows[plan.metrics.findIndex((m) => m.label === label)].get(key)?.n ?? 0,
      );
    for (let i = 0; i < plan.metrics.length; i++) {
      const m = plan.metrics[i];
      const row = rows[i].get(key);
      const n = String(row?.n ?? 0);
      target[m.label] = m.type === "count"
        ? applySmallCell({ type: "count", n })
        : m.type === "percentage"
        ? applySmallCell({
          type: "percentage",
          n: m.numerator_label === undefined ? n : count(m.numerator_label),
          denominator: count(m.denominator_label),
        })
        : applySmallCell({
          type: "mean_observation",
          n,
          total: row?.total == null ? null : String(row.total),
        });
    }
  };
  fill([], answer);
  // R07's published answer predates metric-labelled output; preserve that contract.
  if (
    plan.request_id === "R07" && dimensions.length === 1 &&
    plan.metrics.length === 1 && plan.metrics[0].type === "count"
  ) {
    for (const key of Object.keys(answer)) {
      answer[key] = (answer[key] as Answer)[plan.metrics[0].label];
    }
  }
  return answer;
}
