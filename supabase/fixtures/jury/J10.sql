-- Independent reference, authored from the request definitions, never from a parsed plan.
-- path is the complete answer path, including the metric label; raw n is not for release.
WITH universe AS (SELECT DISTINCT region FROM public.eligible_patients WHERE region IS NOT NULL)
SELECT ARRAY[u.region,'patients_with_antidepressant'] AS path, 'count' AS kind,
 (SELECT count(DISTINCT p.patient_id)::text FROM public.eligible_patients p WHERE p.region=u.region AND (EXISTS (SELECT 1 FROM public.medications m WHERE m.patient_id=p.patient_id AND m.atc LIKE 'N06AB%' AND m.start_date<=DATE '2025-12-31' AND (m.end_date IS NULL OR m.end_date>=DATE '2025-12-31')))) AS n
FROM universe u ORDER BY path;
