-- Independent reference, authored from the request definitions, never from a parsed plan.
-- path is the complete answer path, including the metric label; raw n is not for release.
SELECT ARRAY['cohort_size'] AS path, 'count' AS kind, count(DISTINCT p.patient_id)::text AS n FROM public.eligible_patients p WHERE 2025-EXTRACT(YEAR FROM p.birth_date)>=18 AND EXISTS (SELECT 1 FROM public.conditions c WHERE c.patient_id=p.patient_id AND c.icd10 LIKE 'J45%') AND EXISTS (SELECT 1 FROM public.observations o WHERE o.patient_id=p.patient_id AND o.loinc='39156-5');
