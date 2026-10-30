-- Independent reference authored from applicant definitions and the data model.
-- Raw cells are for verification only; disclosure controls apply before release.
WITH latest AS (
  SELECT p.patient_id, o.value FROM public.eligible_patients p
  JOIN LATERAL (SELECT value FROM public.observations o
    WHERE o.patient_id = p.patient_id AND o.loinc = '4548-4' AND o.date <= DATE '2025-12-31'
    ORDER BY o.date DESC LIMIT 1) o ON true
  WHERE 2025 - EXTRACT(YEAR FROM p.birth_date) >= 18 AND EXISTS (SELECT 1 FROM public.conditions c WHERE c.patient_id = p.patient_id AND c.icd10 LIKE 'E11%')
)
SELECT ARRAY['hba1c_measured'] AS path, 'count' AS kind, count(*)::text AS n, NULL::text AS total FROM latest
UNION ALL
SELECT ARRAY['hba1c_mean'], 'mean', count(value)::text, sum(value)::text FROM latest;
