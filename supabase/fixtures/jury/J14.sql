-- Independent reference, authored from the request definitions, never from a parsed plan.
-- path is the complete answer path, including the metric label; raw n is not for release.
WITH universe AS (SELECT DISTINCT region FROM public.eligible_patients WHERE region IS NOT NULL)
SELECT ARRAY[u.region,'inpatient_stays'] AS path, 'count' AS kind,
 (SELECT count(DISTINCT e.encounter_id)::text FROM public.eligible_patients p JOIN public.encounters e ON e.patient_id=p.patient_id WHERE p.region=u.region AND (e.type='inpatient' AND e.start_date>=DATE '2024-01-01' AND e.start_date<DATE '2025-01-01' AND e.primary_icd10 LIKE 'K35%')) AS n
FROM universe u ORDER BY path;
