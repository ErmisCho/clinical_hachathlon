-- Independent reference authored from applicant definitions and the data model.
-- Raw cells are for verification only; disclosure controls apply before release.
WITH groups AS (SELECT DISTINCT data_holder AS grp FROM public.eligible_patients WHERE data_holder IS NOT NULL)
SELECT ARRAY[g.grp, 'copd_stays_2024'] AS path, 'count' AS kind,
 (SELECT count(DISTINCT e.encounter_id)::text FROM public.eligible_patients p
  JOIN public.encounters e ON e.patient_id = p.patient_id
  WHERE e.data_holder = g.grp AND e.type = 'inpatient' AND e.primary_icd10 LIKE 'J44%' AND e.start_date >= DATE '2024-01-01' AND e.start_date < DATE '2025-01-01') AS n
FROM groups g ORDER BY path;
