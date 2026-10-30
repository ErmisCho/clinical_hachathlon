import type { ExtraProhibitedRule } from "../decision.ts";
import RAW from "./hdab_configs.json" with { type: "json" };

export interface HdabConfig {
  code: string;
  country: string;
  name: string;
  display_language: "de" | "en";
  languages: ("de" | "en")[];
  contact: string;
  branding: { primary: string; accent: string };
  extra_prohibited: ExtraProhibitedRule[];
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object");
  }
  const obj = value as Record<string, unknown>;
  if (
    Object.keys(obj).some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in obj))
  ) {
    throw new Error("Missing or unknown configuration field");
  }
  return obj;
}
function string(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Expected non-empty string");
  }
}
function strings(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) throw new Error("Expected string array");
  value.forEach(string);
}

/** Fail closed on misspellings, unsupported languages, or invalid patterns. */
export function validateConfig(value: unknown): HdabConfig {
  const c = object(value, [
    "code",
    "country",
    "name",
    "display_language",
    "languages",
    "contact",
    "branding",
    "extra_prohibited",
  ]);
  for (const key of ["code", "country", "name", "contact"]) string(c[key]);
  if (!/^[a-z]{2}$/.test(c.code as string)) {
    throw new Error("Invalid HDAB code");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.contact as string)) {
    throw new Error("Invalid contact");
  }
  strings(c.languages);
  if (
    !c.languages.length || c.languages.some((l) => l !== "en" && l !== "de") ||
    !c.languages.includes(c.display_language as string)
  ) throw new Error("Invalid language");
  const branding = object(c.branding, ["primary", "accent"]);
  for (const colour of Object.values(branding)) {
    if (typeof colour !== "string" || !/^#[0-9a-f]{6}$/i.test(colour)) {
      throw new Error("Invalid branding colour");
    }
  }
  if (!Array.isArray(c.extra_prohibited)) {
    throw new Error("Expected rules array");
  }
  const ids = new Set<string>();
  for (const value of c.extra_prohibited) {
    const r = object(value, [
      "id",
      "label",
      "article_ref",
      "phrases",
      "examples",
      "counter_examples",
    ]);
    for (const key of ["id", "label", "article_ref"]) string(r[key]);
    if (
      !(r.id as string).startsWith(`N-${(c.code as string).toUpperCase()}-`) ||
      ids.has(r.id as string) || r.article_ref !== "54"
    ) throw new Error("Invalid national rule identity");
    ids.add(r.id as string);
    for (const key of ["phrases", "examples", "counter_examples"]) {
      strings(r[key]);
    }
    if (
      !(r.phrases as string[]).length || !(r.examples as string[]).length ||
      !(r.counter_examples as string[]).length
    ) throw new Error("Rule needs phrases and examples");
    for (const phrase of r.phrases as string[]) {
      const pattern = new RegExp(phrase, "i");
      if (pattern.test("")) throw new Error("Rule cannot match empty text");
    }
  }
  return c as unknown as HdabConfig;
}

export function publicConfig(
  { extra_prohibited: _rules, ...config }: HdabConfig,
) {
  return config;
}

// ---------------------------------------------------------------------------
// Load and validate all configs from the bundled JSON at module load time.
// If validation fails (corrupt build artifact), log the error and fall back
// to the built-in Austria default so that requests not using x-hdab continue
// to work.  A startup crash that kills all routes is never acceptable.
// ---------------------------------------------------------------------------

const BUILTIN_AT: HdabConfig = {
  code: "at",
  country: "Austria",
  name: "Zugangsstelle für Gesundheitsdaten Österreich (Demo)",
  display_language: "en",
  languages: ["de", "en"],
  contact: "demo@example.org",
  branding: { primary: "#20364d", accent: "#27665f" },
  extra_prohibited: [],
};

function loadConfigs(): HdabConfig[] {
  try {
    const raw = RAW as { default: string; hdabs: unknown[] };
    if (!Array.isArray(raw.hdabs) || !raw.hdabs.length) {
      throw new Error("hdab_configs.json: hdabs must be a non-empty array");
    }
    const configs: HdabConfig[] = [];
    const codes = new Set<string>();
    for (const entry of raw.hdabs) {
      const config = validateConfig(entry);
      if (codes.has(config.code)) {
        throw new Error(`Duplicate HDAB code: ${config.code}`);
      }
      codes.add(config.code);
      configs.push(config);
    }
    const defaultCode = typeof raw.default === "string" ? raw.default : "at";
    if (!codes.has(defaultCode)) {
      throw new Error(`Default HDAB code "${defaultCode}" not found`);
    }
    return configs.sort((a, b) => a.code.localeCompare(b.code));
  } catch (err) {
    console.error("hdab: config load failed, falling back to built-in AT", err);
    return [BUILTIN_AT];
  }
}

export const HDABS: HdabConfig[] = loadConfigs();
