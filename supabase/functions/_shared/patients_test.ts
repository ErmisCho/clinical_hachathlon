import { ELIGIBLE_PATIENTS_QUERY, REFERENCE_DATE } from "./patients.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("patient query starts from the eligible view", () => {
  assert(
    /\bfrom public\.eligible_patients as p$/.test(ELIGIBLE_PATIENTS_QUERY),
    "Patient queries must start from the view that excludes opt-outs",
  );
  assert(
    !/\bfrom public\.patients\b/.test(ELIGIBLE_PATIENTS_QUERY),
    "The base patient table must not be queried directly",
  );
});

Deno.test("dataset reference date stays fixed", () => {
  assert(REFERENCE_DATE === "2025-12-31", "Unexpected reference date");
});
