-- Independent reference authored from applicant definitions and the data model.
-- Raw cells are for verification only; disclosure controls apply before release.
SELECT ARRAY['pneumonia_stays_2023'] AS path, 'count' AS kind, count(DISTINCT e.encounter_id)::text AS n
FROM public.eligible_patients p JOIN public.encounters e ON e.patient_id = p.patient_id
WHERE e.type = 'inpatient' AND e.primary_icd10 LIKE 'J18%' AND e.start_date >= DATE '2023-01-01' AND e.start_date < DATE '2024-01-01';
