-- Independent reference, authored from the request definitions, never from a parsed plan.
-- path is the complete answer path, including the metric label; raw n is not for release.
WITH universe AS (SELECT DISTINCT data_holder FROM public.eligible_patients WHERE data_holder IS NOT NULL)
SELECT ARRAY[u.data_holder,'adults_with_heart_failure'] AS path, 'count' AS kind,
 (SELECT count(DISTINCT p.patient_id)::text FROM public.eligible_patients p WHERE p.data_holder=u.data_holder AND (2025-EXTRACT(YEAR FROM p.birth_date)>=18 AND EXISTS (SELECT 1 FROM public.conditions c WHERE c.patient_id=p.patient_id AND c.icd10 LIKE 'I50%'))) AS n
FROM universe u ORDER BY path;
