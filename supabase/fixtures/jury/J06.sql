-- Independent reference, authored from the request definitions, never from a parsed plan.
-- path is the complete answer path, including the metric label; raw n is not for release.
WITH universe AS (SELECT b.label, b.lo, b.hi, r.region FROM (VALUES ('18-49',18,49),('50-64',50,64),('65+',65,200)) b(label,lo,hi) CROSS JOIN (SELECT DISTINCT region FROM public.eligible_patients WHERE region IS NOT NULL) r)
SELECT ARRAY[u.label,u.region,'adults_with_breast_cancer'] AS path, 'count' AS kind,
 (SELECT count(DISTINCT p.patient_id)::text FROM public.eligible_patients p WHERE p.region=u.region AND 2025-EXTRACT(YEAR FROM p.birth_date) BETWEEN u.lo AND u.hi AND (2025-EXTRACT(YEAR FROM p.birth_date)>=18 AND EXISTS (SELECT 1 FROM public.conditions c WHERE c.patient_id=p.patient_id AND c.icd10 LIKE 'C50%'))) AS n
FROM universe u ORDER BY path;
