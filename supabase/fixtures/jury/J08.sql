-- Independent reference, authored from the request definitions, never from a parsed plan.
-- path is the complete answer path, including the metric label; raw n is not for release.
WITH universe AS (SELECT DISTINCT region FROM public.eligible_patients WHERE region IS NOT NULL)
SELECT ARRAY[u.region,'adults_with_obstructive_lung_disease'] AS path, 'count' AS kind,
 (SELECT count(DISTINCT p.patient_id)::text FROM public.eligible_patients p WHERE p.region=u.region AND (2025-EXTRACT(YEAR FROM p.birth_date)>=18 AND EXISTS (SELECT 1 FROM public.conditions c WHERE c.patient_id=p.patient_id AND c.icd10 LIKE 'J44%'))) AS n
FROM universe u ORDER BY path;
