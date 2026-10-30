import { fixtureDir, loadJury } from "./jury-sim.ts";
import { JURY_FIXTURES } from "../supabase/functions/_shared/jury_fixtures.ts";

Deno.test("jury loader: J43–J57 match the offline index and independent SQL", async () => {
  const loaded = await loadJury();
  for (let number = 43; number <= 57; number++) {
    const id = `J${number}`;
    const disk = loaded.find((fixture) => fixture.id === id);
    const indexed = JURY_FIXTURES.find((fixture) => fixture.id === id);
    if (!disk || !indexed) throw new Error(`${id}: missing fixture`);
    for (const key of ["request", "expected"] as const) {
      if (JSON.stringify(disk[key]) !== JSON.stringify(indexed[key])) {
        throw new Error(`${id}: ${key} differs between loaders`);
      }
    }
    const sql = await Deno.readTextFile(new URL(`${id}.sql`, fixtureDir));
    if (
      sql.replaceAll("\r\n", "\n") !== indexed.sql?.replaceAll("\r\n", "\n") ||
      !sql.includes("public.eligible_patients")
    ) {
      throw new Error(`${id}: SQL missing, stale, or bypasses opt-outs`);
    }
    if (!["answer", "review"].includes(disk.expected.parse)) {
      throw new Error(`${id}: missing independent answerability annotation`);
    }
  }
});
