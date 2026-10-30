-- Independent reference authored from applicant definitions and the data model.
-- Raw cells are for verification only; disclosure controls apply before release.
WITH groups AS (SELECT DISTINCT region AS grp FROM public.eligible_patients WHERE region IS NOT NULL)
SELECT ARRAY[g.grp, 'stroke_stays_2025'] AS path, 'count' AS kind,
 (SELECT count(DISTINCT e.encounter_id)::text FROM public.eligible_patients p
  JOIN public.encounters e ON e.patient_id = p.patient_id
  WHERE p.region = g.grp AND e.type = 'inpatient' AND e.primary_icd10 LIKE 'I63%' AND e.start_date >= DATE '2025-01-01' AND e.start_date < DATE '2026-01-01') AS n
FROM groups g ORDER BY path;
