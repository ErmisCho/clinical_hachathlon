-- Independent reference authored from applicant definitions and the data model.
-- Raw cells are for verification only; disclosure controls apply before release.
SELECT ARRAY['cohort_size'] AS path, 'count' AS kind, count(DISTINCT p.patient_id)::text AS n
FROM public.eligible_patients p WHERE 2025 - EXTRACT(YEAR FROM p.birth_date) >= 18 AND EXISTS (SELECT 1 FROM public.conditions c WHERE c.patient_id = p.patient_id AND c.icd10 LIKE 'I10%') AND EXISTS (SELECT 1 FROM public.observations o WHERE o.patient_id = p.patient_id AND o.loinc = '8480-6');
