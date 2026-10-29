/**
 * Secure Processing Environment (SPE) creator.
 *
 * Creates an isolated Postgres schema per approved request holding only the
 * cohort's patients and the record types named in the plan. Nothing can be
 * downloaded: the schema is locked to service_role only, with RLS enabled.
 *
 * EHDS Art. 73 — data in a secure processing environment cannot be downloaded.
 */
import { type QueryPlan } from "./plan.ts";

/** Allowlist of record-type table names (from public schema) that may be copied. */
const ALLOWED_RECORD_TABLES = new Set([
  "conditions",
  "medications",
  "observations",
  "encounters",
]);

/** Demographic columns on patients (quasi-identifiers). Only copied when the
 *  plan explicitly requests the "patients" record type. */
const PATIENT_DEMOGRAPHIC_COLUMNS = [
  "sex",
  "birth_date",
  "region",
  "data_holder",
] as const;

/** Columns to copy per table (patient_id always included). */
const TABLE_COLUMNS: Record<string, string[]> = {
  conditions: ["patient_id", "icd10", "description", "onset_date"],
  medications: ["patient_id", "atc", "name", "start_date", "end_date"],
  observations: ["patient_id", "loinc", "name", "value", "unit", "date"],
  encounters: [
    "patient_id",
    "encounter_id",
    "data_holder",
    "type",
    "start_date",
    "end_date",
    "primary_icd10",
  ],
};

export interface SpeResult {
  schema: string;
  cohort_size: number;
  tables: string[];
}

/** Minimal interface for the postgres.js client used here. */
export interface SqlClient {
  // deno-lint-ignore no-explicit-any
  unsafe(query: string, params?: (string | number | boolean)[]): PromiseLike<any[]>;
  // Tagged-template transaction helper (postgres.js sql.begin)
  begin<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}

/**
 * Validate and normalise the schema name derived from requestId.
 * Schema name = "spe_" + requestId.toLowerCase(), only [a-z0-9_] allowed.
 * Throws if the result is invalid.
 */
export function schemaName(requestId: string): string {
  const lower = requestId.toLowerCase();
  if (!/^[a-z0-9_]+$/.test(lower)) {
    throw new Error(
      `requestId "${requestId}" produces an invalid schema name: only [a-z0-9_] are allowed`,
    );
  }
  return `spe_${lower}`;
}

/**
 * Return the list of table names that will be copied for a given plan.
 * This is a pure function used by tests and by createSpe.
 */
export function plannedTables(plan: QueryPlan): string[] {
  const types = plan.spe_record_types ?? [];
  // Validate each type against the allowlist (defensive check).
  for (const t of types) {
    if (!ALLOWED_RECORD_TABLES.has(t)) {
      throw new Error(`Record type "${t}" is not in the allowed list`);
    }
  }
  return types.slice();
}

/**
 * Return the columns to SELECT when copying the patients table.
 * Only patient_id by default; full demographics added when "patients" is in
 * spe_record_types (plan.ts RecordType does not include "patients" — this is
 * an intentional extension point; the check is a simple string match so the
 * plan validator does not need to change).
 */
export function patientColumns(plan: QueryPlan): string[] {
  const withDemographics =
    Array.isArray(plan.spe_record_types) &&
    (plan.spe_record_types as string[]).includes("patients");
  if (withDemographics) {
    return ["patient_id", ...PATIENT_DEMOGRAPHIC_COLUMNS];
  }
  return ["patient_id"];
}

/**
 * Build the WHERE clause params for the observation LOINC restriction.
 * Returns null when no restriction applies.
 * Used in tests to verify the generated SQL params independently.
 */
export function observationLoincParams(
  plan: QueryPlan,
): string[] | null {
  if (!plan.spe_observation_loincs || plan.spe_observation_loincs.length === 0) {
    return null;
  }
  return plan.spe_observation_loincs.slice();
}

/**
 * Build the cohort SELECT that returns patient_id values from eligible_patients.
 * Reuses the same cohort SQL structure as engine.ts (all values bound, no injection).
 */
function buildCohortSql(
  plan: QueryPlan,
): { text: string; params: (string | number)[] } {
  const params: (string | number)[] = [];
  const bind = (v: string | number) => {
    params.push(v);
    return `$${params.length}`;
  };

  const conditions: string[] = [];
  for (const f of plan.cohort_filters) {
    switch (f.type) {
      case "age": {
        const age = `(${bind(2025)}::numeric - EXTRACT(YEAR FROM p.birth_date))`;
        conditions.push(`(${age} >= ${bind(f.min_age)}::numeric${
          f.max_age !== undefined ? ` AND ${age} <= ${bind(f.max_age)}::numeric` : ""
        })`);
        break;
      }
      case "sex":
        conditions.push(`(p.sex = ${bind(f.value)})`);
        break;
      case "region":
        conditions.push(`(p.region = ${bind(f.value)})`);
        break;
      case "has_condition": {
        const prefixClauses = f.icd10_prefixes.map((pfx) => {
          const p = bind(pfx);
          return `left(c.icd10, length(${p}::text)) = ${p}::text`;
        }).join(" OR ");
        conditions.push(
          `(EXISTS (SELECT 1 FROM public.conditions AS c WHERE c.patient_id = p.patient_id AND (${prefixClauses})))`,
        );
        break;
      }
      case "has_observation":
        conditions.push(
          `(EXISTS (SELECT 1 FROM public.observations AS o WHERE o.patient_id = p.patient_id AND o.loinc = ${
            bind(f.loinc)
          }))`,
        );
        break;
      case "has_medication": {
        const ref = bind("2025-12-31");
        const prefixClauses = f.atc_prefixes.map((pfx) => {
          const p = bind(pfx);
          return `left(m.atc, length(${p}::text)) = ${p}::text`;
        }).join(" OR ");
        conditions.push(
          `(${f.negate ? "NOT " : ""}EXISTS (SELECT 1 FROM public.medications AS m WHERE m.patient_id = p.patient_id AND (${prefixClauses}) AND m.start_date <= ${ref}::date AND (m.end_date IS NULL OR m.end_date >= ${ref}::date)))`,
        );
        break;
      }
      case "encounter_filter": {
        const parts: string[] = [];
        if (f.encounter_type !== undefined) parts.push(`ef.type = ${bind(f.encounter_type)}`);
        if (f.start_year !== undefined) parts.push(`EXTRACT(YEAR FROM ef.start_date) = ${bind(f.start_year)}::numeric`);
        if (f.primary_icd10_prefix !== undefined) {
          const pfx = bind(f.primary_icd10_prefix);
          parts.push(`left(ef.primary_icd10, length(${pfx}::text)) = ${pfx}::text`);
        }
        const pred = parts.join(" AND ") || "TRUE";
        conditions.push(
          `(EXISTS (SELECT 1 FROM public.encounters AS ef WHERE ef.patient_id = p.patient_id AND ${pred}))`,
        );
        break;
      }
    }
  }

  const where = conditions.length > 0 ? conditions.join(" AND ") : "TRUE";
  const text = `SELECT p.patient_id FROM public.eligible_patients AS p WHERE ${where}`;
  return { text, params };
}

/**
 * Create a per-request secure processing environment schema.
 *
 * - Schema name: spe_<requestId lower-cased>
 * - Drops and recreates if it already exists (idempotent / re-runnable)
 * - Copies only opted-in (eligible) patients matching the cohort filters
 * - Copies only the record types in plan.spe_record_types
 * - Observations restricted to spe_observation_loincs when set
 * - Revokes all from public/anon/authenticated; grants to service_role only
 * - Enables RLS on all copied tables
 * - Runs in a single transaction
 */
export async function createSpe(
  plan: QueryPlan,
  sql: SqlClient,
  requestId: string,
): Promise<SpeResult> {
  const schema = schemaName(requestId);
  const tables = plannedTables(plan);
  const cohort = buildCohortSql(plan);

  const cohort_size = await sql.begin(async (tx) => {
    // Transaction-scoped: released on commit or rollback. Normalized schema names
    // share a lock even when request-id casing differs; values stay bound.
    await tx.unsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [schema],
    );
    // Drop and recreate schema atomically.
    await tx.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await tx.unsafe(`CREATE SCHEMA ${schema}`);

    // Revoke all from public roles immediately.
    await tx.unsafe(
      `REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC, anon, authenticated`,
    );
    await tx.unsafe(
      `GRANT USAGE ON SCHEMA ${schema} TO service_role`,
    );

    // Copy cohort patients from eligible_patients (opted-out excluded by view).
    // Only patient_id unless the plan explicitly requests the "patients" record type.
    const pCols = patientColumns(plan).map((c) => `p.${c}`).join(", ");
    await tx.unsafe(
      `CREATE TABLE ${schema}.patients AS
         SELECT ${pCols}
         FROM public.eligible_patients AS p
         WHERE p.patient_id IN (${cohort.text})`,
      cohort.params,
    );

    await tx.unsafe(`ALTER TABLE ${schema}.patients ENABLE ROW LEVEL SECURITY`);
    await tx.unsafe(
      `REVOKE ALL ON TABLE ${schema}.patients FROM PUBLIC, anon, authenticated`,
    );
    await tx.unsafe(
      `GRANT SELECT ON TABLE ${schema}.patients TO service_role`,
    );

    // Copy each requested record type.
    for (const table of tables) {
      const cols = TABLE_COLUMNS[table].join(", ");
      if (table === "observations" && plan.spe_observation_loincs?.length) {
        // Restrict observations to requested LOINCs.
        const loincParams: (string | number)[] = [...cohort.params];
        const loincPlaceholders = plan.spe_observation_loincs.map((loinc) => {
          loincParams.push(loinc);
          return `$${loincParams.length}`;
        }).join(", ");

        await tx.unsafe(
          `CREATE TABLE ${schema}.${table} AS
             SELECT ${cols} FROM public.${table}
             WHERE patient_id IN (${cohort.text})
               AND loinc IN (${loincPlaceholders})`,
          loincParams,
        );
      } else {
        await tx.unsafe(
          `CREATE TABLE ${schema}.${table} AS
             SELECT ${cols} FROM public.${table}
             WHERE patient_id IN (${cohort.text})`,
          cohort.params,
        );
      }

      await tx.unsafe(
        `ALTER TABLE ${schema}.${table} ENABLE ROW LEVEL SECURITY`,
      );
      await tx.unsafe(
        `REVOKE ALL ON TABLE ${schema}.${table} FROM PUBLIC, anon, authenticated`,
      );
      await tx.unsafe(
        `GRANT SELECT ON TABLE ${schema}.${table} TO service_role`,
      );
    }
    // Keep the count under the same lock as DDL so a concurrent rebuild cannot
    // replace this request's cohort before its result is read.
    const countRows = await tx.unsafe(
      `SELECT COUNT(*)::text AS n FROM ${schema}.patients`,
    );
    return parseInt(countRows[0].n, 10);
  });

  return { schema, cohort_size, tables };
}
