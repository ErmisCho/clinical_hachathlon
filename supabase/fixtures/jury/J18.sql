-- Independent reference, authored from the request definitions, never from a parsed plan.
-- path is the complete answer path, including the metric label; raw n is not for release.
WITH universe AS (SELECT DISTINCT region FROM public.eligible_patients WHERE region IS NOT NULL),
matched AS (SELECT p.region AS grp, o.value FROM public.eligible_patients p
 JOIN LATERAL (SELECT value FROM public.observations o WHERE o.patient_id=p.patient_id AND o.loinc='39156-5' ORDER BY o.date DESC NULLS LAST LIMIT 1) o ON TRUE
 WHERE 2025-EXTRACT(YEAR FROM p.birth_date)>=18 AND EXISTS (SELECT 1 FROM public.conditions c WHERE c.patient_id=p.patient_id AND c.icd10 LIKE 'E66%')),
raw AS (SELECT u.region AS grp, count(m.value)::text AS n, sum(m.value)::text AS total FROM universe u LEFT JOIN matched m ON m.grp=u.region GROUP BY u.region)
SELECT ARRAY[grp,'patients_with_bmi'] AS path, 'count' AS kind,n,NULL::text AS total FROM raw
UNION ALL SELECT ARRAY[grp,'mean_bmi'], 'mean',n,total FROM raw;
