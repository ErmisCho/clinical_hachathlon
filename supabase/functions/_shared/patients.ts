/** Trusted backend queries start from this view to apply opt-outs once. */
export const ELIGIBLE_PATIENTS_QUERY =
  "select p.patient_id, p.sex, p.birth_date, p.region, p.data_holder " +
  "from public.eligible_patients as p";

/** Fixed dataset reference date; do not use the current date for cohort ages. */
export const REFERENCE_DATE = "2025-12-31";
