/**
 * One-time script: reads ehds_reg.html (EUR-Lex archive snapshot) and writes
 * supabase/functions/_shared/regulation/reg_2025_327.json.
 *
 * Usage: deno run --allow-read --allow-write scripts/extract-regulation.ts
 */

const HTML_FILE = new URL("../ehds_reg.html", import.meta.url);
const OUT_FILE = new URL(
  "../supabase/functions/_shared/regulation/reg_2025_327.json",
  import.meta.url,
);

const SOURCE_URL = "https://eur-lex.europa.eu/eli/reg/2025/327/oj/eng";

// ---------------------------------------------------------------------------
// HTML stripping helpers
// ---------------------------------------------------------------------------

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&#160;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&ndash;": "\u2013",
  "&mdash;": "\u2014",
  "&thinsp;": "\u2009",
  "&#8209;": "\u2011",
  "&#8211;": "\u2013",
  "&#8212;": "\u2014",
  "&#8217;": "\u2019",
  "&#8216;": "\u2018",
  "&#8220;": "\u201c",
  "&#8221;": "\u201d",
  "&apos;": "'",
  "&quot;": '"',
};

function decodeEntities(s: string): string {
  // Named entities
  s = s.replace(/&[a-zA-Z0-9#]+;/g, (m) => ENTITIES[m] ?? m);
  // Numeric decimal entities not in table
  s = s.replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(parseInt(d, 10)));
  return s;
}

function normaliseSpace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function cleanText(html: string): string {
  return normaliseSpace(decodeEntities(stripTags(html)));
}

// ---------------------------------------------------------------------------
// Extract one article's HTML block between id="art_NN" and id="art_MM"
// ---------------------------------------------------------------------------

function extractArticleHtml(
  src: string,
  artNum: number,
  nextId: string | null,
): string {
  const marker = `id="art_${artNum}"`;
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`art_${artNum} not found`);
  if (nextId === null) {
    return src.slice(start);
  }
  const end = src.indexOf(`id="${nextId}"`);
  if (end < 0) throw new Error(`End marker ${nextId} not found`);
  return src.slice(start, end);
}

// ---------------------------------------------------------------------------
// Parse paragraphs from an article's HTML
// ---------------------------------------------------------------------------

interface Paragraph {
  ref: string;
  text: string;
}

interface ArticleData {
  title: string;
  paragraphs: Paragraph[];
}

function parseArticle(artNum: number, html: string): ArticleData {
  // Title is in <p class="oj-sti-art">
  const titleMatch = html.match(
    /<p[^>]*class="oj-sti-art"[^>]*>([\s\S]*?)<\/p>/,
  );
  const title = titleMatch ? cleanText(titleMatch[1]) : "";

  // Each numbered paragraph starts with a <div id="0NN.PPP"> or similar
  // The paragraph number is in <p class="oj-normal">N.</p> pattern, OR
  // the div id encodes it: id="053.001" means art 53, para 1.
  // Strategy: find all div[@id matching /^\d{3}\.\d{3}/] and extract text.
  const paraPattern = /id="(\d{3})\.(\d{3})">([\s\S]*?)(?=id="\d{3}\.\d{3}"|id="art_|$)/g;
  const paragraphs: Paragraph[] = [];
  let m: RegExpExecArray | null;
  while ((m = paraPattern.exec(html)) !== null) {
    const paraNum = parseInt(m[2], 10);
    const paraHtml = m[3];
    // Strip any trailing partial-tag artifacts left by the lookahead boundary
    const cleanedHtml = paraHtml
      .replace(/<div\b[^>]*$/, "")
      .replace(/<[a-zA-Z][^>]*$/, "");
    const text = cleanText(cleanedHtml);
    // Skip empty or very short
    if (text.length < 5) continue;
    paragraphs.push({ ref: String(paraNum), text });
  }

  // If no structured divs found, fall back to collecting all oj-normal paragraphs.
  // (Some articles, like Art. 54, use flat <p class="oj-normal"> without numbered divs.)
  if (paragraphs.length === 0) {
    // The article number is in <p class="oj-ti-art">, NOT in oj-normal,
    // so we collect ALL oj-normal paras.
    // Bare point labels "(a)", "(b)" … are single-letter table-cell paras — skip them.
    const allParas: string[] = [];
    const pPattern = /<p[^>]*class="oj-normal"[^>]*>([\s\S]*?)<\/p>/g;
    let pm: RegExpExecArray | null;
    while ((pm = pPattern.exec(html)) !== null) {
      const t = cleanText(pm[1]);
      if (/^\([a-z]\)$/.test(t)) continue; // skip lone "(a)" labels
      if (t.length > 3) allParas.push(t);
    }
    // Group by numbered paragraph openers "1.", "2.", …
    let cur: string[] = [];
    for (const t of allParas) {
      if (/^\d+\./.test(t) && cur.length > 0) {
        paragraphs.push({
          ref: String(paragraphs.length + 1),
          text: cur.join(" "),
        });
        cur = [t];
      } else {
        cur.push(t);
      }
    }
    if (cur.length > 0) {
      paragraphs.push({
        ref: String(paragraphs.length + 1),
        text: cur.join(" "),
      });
    }
  }

  return { title, paragraphs };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const html = await Deno.readTextFile(HTML_FILE);

const ARTICLE_DEFS: Array<[number, string | null]> = [
  [53, "art_54"],
  [54, "art_55"],
  [66, "art_67"],
  [67, "art_68"],
  [68, "art_69"],
  [69, "art_70"],
  [71, "art_72"],
  [73, "art_74"],
];

const articles: Record<string, ArticleData> = {};
for (const [artNum, nextId] of ARTICLE_DEFS) {
  const artHtml = extractArticleHtml(html, artNum, nextId);
  articles[String(artNum)] = parseArticle(artNum, artHtml);
}

const output = {
  source_url: SOURCE_URL,
  retrieved_at: "2025-05-03T23:07:27Z", // timestamp of archive.org snapshot used
  articles,
};

// Ensure output directory exists
await Deno.mkdir(
  new URL("../supabase/functions/_shared/regulation/", import.meta.url),
  { recursive: true },
);

await Deno.writeTextFile(OUT_FILE, JSON.stringify(output, null, 2));
console.log(`Written: ${new URL(OUT_FILE).pathname}`);
for (const [n] of ARTICLE_DEFS) {
  const a = articles[String(n)];
  console.log(
    `  Art ${n}: "${a.title}" — ${a.paragraphs.length} paragraph(s)`,
  );
}
