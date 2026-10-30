import { decide, type HealthDataRequest } from "../_shared/decision.ts";
import RULES from "../_shared/rules/decision_rules.json" with { type: "json" };

export interface RegisterDatabase {
  unsafe(query: string): PromiseLike<Record<string, unknown>[]>;
  end(): Promise<void>;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const labels = new Map(RULES.rules.map((rule) => [rule.id, rule.label]));
const decisions = new Set(["REJECT", "APPROVE_STATISTICAL", "APPROVE_SPE"]);
const articles = new Set(["53", "54", "66", "68", "69", "73"]);

export function organisationType(value: unknown): string {
  if (typeof value !== "string") return "Other";
  // Specific commercial terms take priority over ambiguous "agency"/"public".
  const categories: [RegExp, string][] = [
    [
      /\b(insurance|insurer)\b|versicherung|versicherer|krankenkasse/i,
      "Insurer",
    ],
    [
      /\b(pharma\w*|company|gmbh|ag|kg|og|ltd|marketing)\b|\be\.u\./i,
      "Company",
    ],
    [
      /\b(university|research|institute)\b|universität|hochschule|institut|forschung|zentrum/i,
      "Research institution",
    ],
    [
      /\b(hospital|clinic)\b|krankenhaus|klinik|klinikum|spital|krankenhausverbund|gesundheitsverbund/i,
      "Healthcare provider",
    ],
    [
      /\b(ministry|agency|authority|public)\b|amt|behörde|ministerium|agentur für|landes|gemeinde/i,
      "Public body",
    ],
  ];
  return categories.find(([pattern]) => pattern.test(value))?.[1] ?? "Other";
}

/** Strict public projection; never spread a saved request or response. */
export function publicEntries(rows: Record<string, unknown>[]) {
  const seen = new Set<unknown>();
  return [...rows].sort((a, b) =>
    new Date(b.submitted_at as string).getTime() -
      new Date(a.submitted_at as string).getTime() ||
    (BigInt(String(a.id)) < BigInt(String(b.id)) ? 1 : -1)
  ).filter((row) => {
    if (seen.has(row.request_id)) return false;
    seen.add(row.request_id);
    return row.needs_review !== true;
  }).slice(0, 100).map((row) => {
    const date = new Date(row.submitted_at as string).toISOString().slice(
      0,
      10,
    );
    const id = String(row.id);
    if (
      !/^\d+$/.test(id) || typeof row.decision !== "string" ||
      !decisions.has(row.decision)
    ) {
      throw new Error("Invalid saved decision");
    }
    const rule = decide({
      requested_as: row.requested_as,
      requested_format: row.requested_format,
      purpose: row.purpose,
      question: row.question,
      definitions: row.definitions,
    } as HealthDataRequest).rule_id;
    return {
      reference: `HDAB-${date.slice(0, 4)}-${id.padStart(6, "0")}`,
      date,
      organisation_type: organisationType(row.organisation),
      purpose_category: labels.get(rule) ?? "Other",
      decision: row.decision,
      // Only legal article numbers can cross the public boundary.
      articles: Array.isArray(row.articles)
        ? row.articles.filter((article): article is string =>
          typeof article === "string" && articles.has(article)
        )
        : [],
    };
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export function createHandler(connect: () => RegisterDatabase) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    if (!/\/register\/?$/.test(new URL(req.url).pathname)) {
      return json({ error: "not found" }, 404);
    }
    let sql: RegisterDatabase | undefined;
    let stage: "connect" | "list" | "build" = "connect";
    try {
      sql = connect();
      stage = "list";
      // Decode legacy JSON strings inside SQL, but transfer only these fields.
      const request = `(CASE WHEN jsonb_typeof(request) = 'string'
        THEN (request #>> '{}')::jsonb ELSE request END)`;
      const response = `(CASE WHEN jsonb_typeof(response) = 'string'
        THEN (response #>> '{}')::jsonb ELSE response END)`;
      const rows = await sql.unsafe(`
        WITH latest AS MATERIALIZED (
          SELECT DISTINCT ON (request_id) id, request_id, submitted_at,
            ${request}->>'requested_as' AS requested_as,
            ${request}->>'requested_format' AS requested_format,
            ${request}->>'purpose' AS purpose,
            ${request}->>'question' AS question,
            ${request}->'definitions' AS definitions,
            ${request}->'applicant'->>'organisation' AS organisation,
            ${response}->>'decision' AS decision,
            ${response}->'articles' AS articles,
            ${response}->'needs_review' AS needs_review
          FROM public.request_log
          ORDER BY request_id, submitted_at DESC, id DESC
        )
        SELECT id, request_id, submitted_at, requested_as, requested_format,
          purpose, question, definitions, organisation, decision, articles, needs_review
        FROM latest
        WHERE needs_review IS DISTINCT FROM 'true'::jsonb
        ORDER BY submitted_at DESC, id DESC LIMIT 100
      `);
      stage = "build";
      return json({ entries: publicEntries(rows) });
    } catch (error) {
      const diagnostic = error as { code?: unknown; name?: unknown } | null;
      const code = typeof diagnostic?.code === "string" &&
          /^[0-9A-Z]{5}$/.test(diagnostic.code)
        ? diagnostic.code
        : typeof diagnostic?.name === "string"
        ? diagnostic.name
        : "Error";
      console.error("register: internal server error", { code, stage });
      return json({ error: "internal server error", code, stage }, 500);
    } finally {
      try {
        await sql?.end();
      } catch {
        console.error("register: database cleanup failed");
      }
    }
  };
}
