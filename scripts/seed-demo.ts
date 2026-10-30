/** Curated demo maintenance. No I/O on import; run with clean, seed, or all. */
import type { HealthDataRequest } from "../supabase/functions/_shared/decision.ts";
import type { PipelineResponse } from "../supabase/functions/_shared/pipeline.ts";
import type { StaffReview } from "../supabase/functions/requests/review.ts";
import { trackRequestFile } from "./eval.ts";

// Fixed reference numbers use the API's supported alphanumeric format.
// Retain these numbers so cleanup never broadens to unrelated AT references.
export const CURATED_IDS = [
  "AT20260412",
  "AT20260413",
  "AT20260414",
  "AT20260415",
  "AT20260416",
  "AT20260417",
  "AT20260418",
  "AT20260419",
  "AT20260420",
  "AT20260421",
  "AT20260422",
  "AT20260423",
  "AT20260424",
] as const;
export const CLEAN_PATTERN =
  `^((Q34|T49|P43|H47|UI47|L45|M45|N45)[A-Za-z0-9]*_|D_|(${
    CURATED_IDS.join("|")
  })$)`;
export const CLEAN_SCHEMA_PATTERN =
  `^spe_((q34|t49|p43|h47|ui47|l45|m45|n45)[a-z0-9]*_|d_|(${
    CURATED_IDS.join("|").toLowerCase()
  })$)`;
export function isDemoId(id: string): boolean {
  return new RegExp(CLEAN_PATTERN).test(id);
}
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

type LoadFixture = (id: string) => Promise<HealthDataRequest>;
export interface DemoEntry {
  request: HealthDataRequest & { id: string; submitted: string };
  label: string;
  expected?: PipelineResponse["decision"];
  held?: boolean;
  review?: StaffReview;
}

// Fictional identities composed for this demo; never copied from fixture applicants.
const people = [
  "Dr. Verena Auenstetter",
  "Mag. Lukas Birkenleitner",
  "Dr. Marlene Felsenbrunner",
  "Mag. Tobias Waldstegner",
  "Dr. Klara Sonnleitenberger",
  "Mag. Florian Erlenwinkler",
  "Dr. Johanna Kiesengruber",
  "Mag. Matthias Talbrucker",
];
const organisations: Record<string, string> = {
  R01: "Amt für Bevölkerungsgesundheit Auenried",
  R02: "Felsenquell Privatversicherung AG",
  R03: "Institut für Versorgungsforschung Birkensteg",
  R04: "Erlenbogen Arzneimittelkommunikation GmbH",
  R05: "Talwiesen Prädiktive Gesundheit GmbH",
  R06: "Kiesenau Personalmanagement GmbH",
  R07: "Agentur für Gesundheitsplanung Waldkiesel",
  R08: "Institut für Präventionsforschung Sonnenried",
  R09: "Institut für Allgemeinmedizin Auenfalk",
  R10: "Birkenquell Nikotinprodukte GmbH",
  AT20260412: "Krankenhausverbund Felsenauen",
  AT20260413: "Agentur für Gesundheitsplanung Waldkiesel",
  AT20260414: "Felsenquell Privatversicherung AG",
  AT20260415: "Amt für Bevölkerungsgesundheit Auenried",
  AT20260416: "Talwiesen Prädiktive Gesundheit GmbH",
  AT20260417: "Institut für Versorgungsforschung Birkensteg",
  AT20260418: "Krankenhausverbund Felsenauen",
  AT20260419: "Institut für Nierenforschung Erlenbogen",
  AT20260420: "Agentur für Regionalentwicklung Kiesental",
  AT20260421: "Institut für Angewandte Datenmethoden Auenfalk",
  AT20260422: "Sonnenried Analyseberatung GmbH",
  AT20260423: "Amt für Bevölkerungsgesundheit Auenried",
  AT20260424: "Erlenbogen Ernährungsprodukte GmbH",
};

/** Keep fixture semantics/definitions, replace identifying metadata only. */
export async function buildDemo(
  loadTrack: LoadFixture,
  loadJury: LoadFixture,
  now = new Date(),
): Promise<DemoEntry[]> {
  const entries: DemoEntry[] = [];
  function add(
    source: HealthDataRequest,
    id: string,
    label: string,
  ): DemoEntry {
    const i = entries.length;
    const entry: DemoEntry = {
      label,
      request: {
        ...source,
        id,
        // Spread all 23 applications across the preceding 21 days, oldest first.
        submitted: new Date(now.getTime() - (20 - i * 20 / 22) * 86400000)
          .toISOString(),
        applicant: {
          name: people[i % people.length],
          organisation: organisations[id],
          country: "AT",
        },
      },
    };
    entries.push(entry);
    return entry;
  }
  for (let n = 1; n <= 10; n++) {
    const id = `R${String(n).padStart(2, "0")}`;
    add(await loadTrack(id), id, "reference fixture");
  }
  const cases = [
    ["J02", "hospital grouping", "APPROVE_STATISTICAL"],
    ["J13", "inpatient main diagnosis", "APPROVE_STATISTICAL"],
    ["J26", "disguised insurance purpose", "REJECT"],
    ["J37", "negated marketing purpose", "APPROVE_STATISTICAL"],
    ["J21", "secure environment", "APPROVE_SPE"],
    ["J22", "records downgraded to statistics", "APPROVE_STATISTICAL"],
    ["J09", "active medication by holder", "APPROVE_STATISTICAL"],
    ["J17", "kidney function by hospital", "APPROVE_STATISTICAL"],
  ] as const;
  for (const [i, [fixture, label, expected]] of cases.entries()) {
    add(await loadJury(fixture), CURATED_IDS[i], label).expected = expected;
  }
  const unclear = [
    "We request regional asthma counts to compare catchment areas for our next location strategy. The results will inform a steering-group recommendation on where to establish additional services.",
    "We request regional asthma counts as a baseline for a joint analytical project with two partner organisations. The partners will use the comparison to prioritise areas for a subsequent feasibility assessment.",
    "We request regional asthma counts to assess demand for a proposed advisory service. The regional comparison will form part of the business case presented to prospective commissioning partners.",
    "We request regional asthma counts for a comparison of local service coverage. The comparison will support the next programme proposal submitted to our departmental steering group.",
    "We request regional asthma counts to assess the regional fit of a proposed partner programme. The comparison will support the partner's selection of areas for its first implementation phase.",
  ];
  for (let i = 0; i < unclear.length; i++) {
    // Supported definitions ensure staff can resolve purpose holds without parse errors.
    const source = { ...await loadJury("J37"), purpose: unclear[i] };
    const entry = add(
      source,
      CURATED_IDS[8 + i],
      i < 3 ? "awaiting purpose clarification" : "staff-resolved purpose",
    );
    entry.held = true;
    if (i >= 3) {
      entry.review = {
        request_id: entry.request.id,
        action: i === 3 ? "approve" : "override",
        ...(i === 4 ? { decision: "REJECT" as const } : {}),
        staff_name: i === 3
          ? "Mag. Leonie Bachstegner"
          : "Dr. Stefan Erlenbrucker",
        reason: i === 3
          ? "The applicant clarified that regional asthma counts support a public health prevention programme. Only anonymised aggregates are authorised; no individual records are needed."
          : "The applicant clarified that the partner would use the counts to select customers for targeted supplement advertising. This downstream use is prohibited under Article 54; access is refused.",
      };
    }
  }
  return entries;
}

async function clean(databaseUrl: string, dryRun: boolean) {
  const { default: postgres } = await import("npm:postgres");
  const db = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 10,
  });
  const tables = [
    "staff_action",
    "request_event",
    "spe_download_log",
    "request_log",
  ];
  try {
    await db.begin(
      dryRun ? "isolation level repeatable read read only" : "",
      async (tx) => {
        if (!dryRun) {
          await tx.unsafe(
            `LOCK TABLE ${
              tables.map((t) => `public.${t}`).join(", ")
            } IN SHARE ROW EXCLUSIVE MODE`,
          );
        }
        // Include orphan audit rows and orphan SPEs, not just request_log entries.
        const ids = await tx.unsafe(
          `SELECT DISTINCT request_id FROM (${
            tables.map((t) => `SELECT request_id FROM public.${t}`).join(
              " UNION ALL ",
            )
          }) ids
         WHERE request_id ~ $1 ORDER BY request_id`,
          [CLEAN_PATTERN],
        );
        const schemas = await tx.unsafe(
          `SELECT nspname FROM pg_namespace WHERE nspname ~ $1 ORDER BY nspname`,
          [CLEAN_SCHEMA_PATTERN],
        );
        // A lower-case id could share an SPE with a matching upper-case test id.
        // Refuse to drop any schema referenced by a protected submission.
        for (const { nspname } of schemas) {
          const protectedRows = await tx.unsafe(
            `SELECT 1 FROM (${
              tables.map((t) => `SELECT request_id FROM public.${t}`).join(
                " UNION ALL ",
              )
            }) ids
             WHERE 'spe_' || lower(request_id) = $1 AND NOT (request_id ~ $2) LIMIT 1`,
            [nspname, CLEAN_PATTERN],
          );
          if (protectedRows.length) {
            throw new Error(`SPE belongs to a protected request: ${nspname}`);
          }
        }
        console.log(
          `${dryRun ? "Would remove" : "Removing"} request IDs: ${
            ids.map((r) => r.request_id).join(", ") || "none"
          }`,
        );
        const counts: Record<string, unknown>[] = [];
        for (const table of tables) {
          const linked = table === "staff_action" || table === "request_event"
            ? " OR request_log_id IN (SELECT id FROM public.request_log WHERE request_id ~ $1)"
            : "";
          const where = `request_id ~ $1${linked}`;
          const result = dryRun
            ? await tx.unsafe(
              `SELECT count(*)::text AS n FROM public.${table} WHERE ${where}`,
              [CLEAN_PATTERN],
            )
            : await tx.unsafe(
              `WITH removed AS (DELETE FROM public.${table} WHERE ${where} RETURNING 1) SELECT count(*)::text AS n FROM removed`,
              [CLEAN_PATTERN],
            );
          counts.push({
            table,
            [dryRun ? "would_remove" : "removed"]: result[0].n,
          });
        }
        for (const { nspname } of schemas) {
          if (!dryRun) {
            await tx.unsafe(
              `DROP SCHEMA IF EXISTS ${quoteIdentifier(nspname)} CASCADE`,
            );
          }
        }
        console.table(counts);
        console.log(
          `${dryRun ? "Would drop" : "Dropped"} SPE schemas: ${
            schemas.map((r) => r.nspname).join(", ") || "none"
          }`,
        );
      },
    );
  } finally {
    await db.end();
  }
}

async function seed(
  entries: DemoEntry[],
  baseUrl: string,
  staffToken?: string,
) {
  const root = baseUrl.replace(/\/+$/, "");
  const summary: Record<string, unknown>[] = [];
  let failed = false;
  let needsToken = false;
  for (const entry of entries) {
    const id = entry.request.id;
    const existing = await fetch(`${root}/requests/${encodeURIComponent(id)}`);
    let response: PipelineResponse;
    let operation = "kept existing";
    if (existing.status === 404) {
      await existing.body?.cancel();
      const result = await fetch(`${root}/requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry.request),
      });
      if (!result.ok) throw new Error(`Submit ${id}: HTTP ${result.status}`);
      response = await result.json();
      operation = "submitted";
    } else {
      if (!existing.ok) throw new Error(`Read ${id}: HTTP ${existing.status}`);
      response = await existing.json();
    }
    if (response.request_id !== id) {
      throw new Error(`Unexpected response ID for ${id}`);
    }
    if (
      operation === "submitted" && entry.held &&
      (!response.needs_review || response.decision === "REJECT" ||
        response.answer !== null)
    ) {
      failed = true;
    }
    if (entry.review && response.needs_review) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (staffToken) headers.Authorization = `Bearer ${staffToken}`;
      const result = await fetch(`${root}/requests/review`, {
        method: "POST",
        headers,
        body: JSON.stringify(entry.review),
      });
      if (result.status === 401 || result.status === 403) {
        await result.body?.cancel();
        needsToken = true;
        operation += "; staff token needed";
      } else {
        if (!result.ok) throw new Error(`Review ${id}: HTTP ${result.status}`);
        response = await result.json();
        operation += "; reviewed";
        if (
          response.needs_review ||
          response.decision !== (entry.review.decision ?? "APPROVE_STATISTICAL")
        ) failed = true;
      }
    }
    if (
      entry.expected &&
      (response.decision !== entry.expected || response.needs_review)
    ) failed = true;
    if (
      entry.review && !response.needs_review &&
      response.decision !== (entry.review.decision ?? "APPROVE_STATISTICAL")
    ) failed = true;
    if (
      entry.held && !entry.review &&
      (!response.needs_review || response.decision === "REJECT" ||
        response.answer !== null)
    ) failed = true;
    summary.push({
      id,
      sample: entry.label,
      decision: response.decision,
      queue: response.needs_review ? "staff_review" : "decided",
      operation,
    });
  }
  console.table(summary);
  if (needsToken) {
    console.log(
      "The 2 staff actions need a staff token. Set STAFF_TOKEN and rerun seed to resolve the remaining holds without duplicate submissions.",
    );
  }
  if (failed) {
    throw new Error(
      "Curated outcomes differed from expectations; inspect the summary before presenting the demo.",
    );
  }
}

export async function main(args: string[]) {
  if (args.includes("--help")) {
    console.log(
      "Usage: deno run --allow-read --allow-env --allow-net scripts/seed-demo.ts [clean|seed|all] [--dry-run]\nclean: DATABASE_URL; seed: BASE_URL, optional STAFF_TOKEN/EHDS_TRACK_DIR. Default: all. Run one maintenance process at a time.",
    );
    return;
  }
  const mode = args.find((a) => !a.startsWith("--")) ?? "all";
  if (
    !["clean", "seed", "all"].includes(mode) ||
    args.some((a) => a !== mode && a !== "--dry-run") ||
    args.filter((a) => a === mode).length > 1
  ) {
    throw new Error("Use [clean|seed|all] [--dry-run]; see --help");
  }
  const dryRun = args.includes("--dry-run");
  const databaseUrl = Deno.env.get("DATABASE_URL");
  const baseUrl = Deno.env.get("BASE_URL");
  if (mode !== "seed" && !databaseUrl) {
    throw new Error("clean requires DATABASE_URL");
  }
  if (mode !== "clean" && !dryRun && !baseUrl) {
    throw new Error("seed requires BASE_URL (functions/v1 URL)");
  }
  // Load every fixture before cleanup, so missing files cannot leave a half-seeded site.
  const entries = mode === "clean" ? [] : await buildDemo(
    async (id) =>
      JSON.parse(
        await Deno.readTextFile(
          trackRequestFile(`${id}.json`, Deno.env.get("EHDS_TRACK_DIR")),
        ),
      ),
    async (id) =>
      JSON.parse(
        await Deno.readTextFile(
          new URL(`../supabase/fixtures/jury/${id}.json`, import.meta.url),
        ),
      ),
  );
  if (mode !== "seed") await clean(databaseUrl!, dryRun);
  if (mode !== "clean") {
    if (dryRun) {
      console.table(
        entries.map((e) => ({
          id: e.request.id,
          organisation:
            (e.request.applicant as { organisation: string }).organisation,
          submitted: e.request.submitted,
          review: e.review?.action ?? "",
          staff: e.review?.staff_name ?? "",
        })),
      );
      console.log(
        "Dry run: no HTTP requests sent. Existing IDs will be skipped during seed.",
      );
    } else await seed(entries, baseUrl!, Deno.env.get("STAFF_TOKEN"));
  }
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    // Connection errors can contain credentials; print a safe class for driver failures.
    console.error(
      error instanceof Error && error.name === "Error"
        ? error.message
        : "Demo maintenance failed; check connection configuration.",
    );
    Deno.exitCode = 1;
  }
}
