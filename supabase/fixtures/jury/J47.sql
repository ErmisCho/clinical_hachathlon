-- Independent reference authored from applicant definitions and the data model.
-- Raw cells are for verification only; disclosure controls apply before release.
WITH hospitals AS (SELECT DISTINCT data_holder FROM public.eligible_patients WHERE data_holder IS NOT NULL)
SELECT ARRAY[h.data_holder, 'copd_adults'] AS path, 'count' AS kind,
  (SELECT count(DISTINCT p.patient_id)::text FROM public.eligible_patients p
   WHERE p.data_holder = h.data_holder AND 2025 - EXTRACT(YEAR FROM p.birth_date) >= 18 AND EXISTS (SELECT 1 FROM public.conditions c WHERE c.patient_id = p.patient_id AND c.icd10 LIKE 'J44%')) AS n
FROM hospitals h ORDER BY path;
