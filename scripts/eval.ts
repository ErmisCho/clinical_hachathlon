import {
  consistent,
  type Expected,
  type Json,
  scoreResponse,
} from "./eval_lib.ts";

const usage = `Usage:
  deno run --allow-read --allow-net --allow-env=EHDS_TRACK_DIR scripts/eval.ts --target <base-url> [--key <key>]
  deno run --allow-read --allow-env=EHDS_TRACK_DIR scripts/eval.ts --responses <dir>
Offline: R01.json … R10.json contain one API response, or an array of three responses.
One response is read afresh three times; an array supplies independent saved runs.`;

/** Track root override; relative overrides are resolved against the working directory. */
export function trackRequestFile(name: string, trackDir?: string): string | URL {
  return trackDir
    ? `${trackDir.replace(/[\\/]+$/, "")}/requests/${name}`
    : new URL(`../../TRACK-3-ehds/requests/${name}`, import.meta.url);
}

export async function main(args: string[]): Promise<number> {
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help") {
      console.log(usage);
      return 0;
    }
    if (
      !["--target", "--responses", "--key"].includes(args[i]) ||
      !args[i + 1] || args[i + 1].startsWith("--") || options[args[i]]
    ) {
      throw new Error(usage);
    }
    options[args[i]] = args[++i];
  }
  if (
    Boolean(options["--target"]) === Boolean(options["--responses"]) ||
    (options["--key"] && !options["--target"])
  ) throw new Error(usage);
  const trackDir = Deno.env.get("EHDS_TRACK_DIR");
  const expected: Record<string, Expected> = JSON.parse(
    await Deno.readTextFile(trackRequestFile("expected.json", trackDir)),
  );
  let decisions = 0, numbers = 0, leakCount = 0, failures = 0;
  let slowest = 0, slowestId = "";
  const inconsistent: string[] = [];
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    const id = `R${String(i).padStart(2, "0")}`;
    if (!expected[id]) throw new Error(`Missing reference for ${id}`);
    const runs: Json[] = [];
    const scores = [];
    const errors: string[] = [];
    let elapsed = 0;
    for (let run = 0; run < 3; run++) {
      let started: number | undefined;
      try {
        let response: Json;
        if (options["--responses"]) {
          started = performance.now();
          const saved = JSON.parse(
            await Deno.readTextFile(`${options["--responses"]}/${id}.json`),
          );
          if (Array.isArray(saved) && saved.length !== 3) {
            throw new Error(
              "Saved run array must have exactly three responses",
            );
          }
          response = Array.isArray(saved) ? saved[run] : saved;
        } else {
          const body = await Deno.readTextFile(
            trackRequestFile(`${id}.json`, trackDir),
          );
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };
          if (options["--key"]) {
            headers.Authorization = `Bearer ${options["--key"]}`;
            headers.apikey = options["--key"];
          }
          started = performance.now();
          const result = await fetch(
            `${options["--target"].replace(/\/+$/, "")}/requests`,
            {
              method: "POST",
              headers,
              body,
              signal: AbortSignal.timeout(120_000),
            },
          );
          if (!result.ok) {
            await result.body?.cancel();
            throw new Error(`HTTP ${result.status}`);
          }
          response = await result.json();
        }
        // Stop the timer at the parsed answer, before evaluator scoring work.
        elapsed = Math.max(elapsed, performance.now() - started);
        started = undefined;
        runs.push(response);
        scores.push(scoreResponse(response, expected[id]));
      } catch (error) {
        errors.push(
          `run ${run + 1}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        if (started !== undefined) {
          elapsed = Math.max(elapsed, performance.now() - started);
        }
      }
    }
    if (elapsed >= slowest) {
      slowest = elapsed;
      slowestId = id;
    }
    const decision = scores.length === 3 && scores.every((s) => s.decision);
    const articles = scores.length === 3 && scores.every((s) => s.articles);
    const numeric = scores.length === 3 && scores.every((s) => s.numbers);
    const leaks = [...new Set(scores.flatMap((s) => s.leaks))];
    const stable = consistent(runs);
    if (decision && articles) decisions++;
    if (expected[id].answer !== null && numeric) numbers++;
    leakCount += leaks.length;
    if (!stable) inconsistent.push(id);
    if (
      !decision || !articles || !numeric || leaks.length || !stable ||
      errors.length
    ) failures++;
    rows.push({
      request: id,
      decision: decision ? "match" : "MISMATCH",
      articles: articles ? "match" : "MISMATCH",
      numbers: expected[id].answer === null
        ? "n/a"
        : numeric
        ? "match"
        : "MISMATCH",
      leaks: leaks.length,
      consistency: stable ? "same" : "DIFFERS / incomplete",
      "slowest ms": elapsed.toFixed(1),
    });
    for (const detail of [...errors, ...leaks]) console.log(`${id}: ${detail}`);
  }
  console.table(rows);
  console.log(
    `Decisions (including articles): ${decisions}/10; numbers: ${numbers}/6; leaks: ${leakCount}`,
  );
  console.log(`Inconsistent requests: ${inconsistent.join(", ") || "none"}`);
  console.log(
    `Slowest time: ${(slowest / 1000).toFixed(3)} s (${slowestId})${
      options["--responses"]
        ? " — offline read/parse time, not app latency"
        : ""
    }`,
  );
  return failures ? 1 : 0;
}

if (import.meta.main) {
  try {
    Deno.exitCode = await main(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exitCode = 1;
  }
}
