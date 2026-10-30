-- Independent reference authored from applicant definitions and the data model.
-- Raw cells are for verification only; disclosure controls apply before release.
WITH hospitals AS (SELECT DISTINCT data_holder FROM public.eligible_patients WHERE data_holder IS NOT NULL)
SELECT ARRAY[h.data_holder, 'sglt2_users'] AS path, 'count' AS kind,
  (SELECT count(DISTINCT p.patient_id)::text FROM public.eligible_patients p
   WHERE p.data_holder = h.data_holder AND EXISTS (SELECT 1 FROM public.medications m WHERE m.patient_id = p.patient_id AND m.atc LIKE 'A10BK%' AND m.start_date <= DATE '2025-12-31' AND (m.end_date IS NULL OR m.end_date >= DATE '2025-12-31'))) AS n
FROM hospitals h ORDER BY path;
