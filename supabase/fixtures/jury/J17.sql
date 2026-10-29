-- Independent reference, authored from the request definitions, never from a parsed plan.
-- path is the complete answer path, including the metric label; raw n is not for release.
WITH universe AS (SELECT DISTINCT data_holder FROM public.eligible_patients WHERE data_holder IS NOT NULL),
matched AS (SELECT p.data_holder AS grp, o.value FROM public.eligible_patients p
 JOIN LATERAL (SELECT value FROM public.observations o WHERE o.patient_id=p.patient_id AND o.loinc='62238-1' ORDER BY o.date DESC NULLS LAST LIMIT 1) o ON TRUE
 WHERE 2025-EXTRACT(YEAR FROM p.birth_date)>=18 AND EXISTS (SELECT 1 FROM public.conditions c WHERE c.patient_id=p.patient_id AND c.icd10 LIKE 'N18%')),
raw AS (SELECT u.data_holder AS grp, count(m.value)::text AS n, sum(m.value)::text AS total FROM universe u LEFT JOIN matched m ON m.grp=u.data_holder GROUP BY u.data_holder)
SELECT ARRAY[grp,'patients_with_egfr'] AS path, 'count' AS kind,n,NULL::text AS total FROM raw
UNION ALL SELECT ARRAY[grp,'mean_egfr'], 'mean',n,total FROM raw;
