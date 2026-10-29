-- Independent reference, authored from the request definitions, never from a parsed plan.
-- path is the complete answer path, including the metric label; raw n is not for release.
WITH universe AS (SELECT DISTINCT data_holder FROM public.eligible_patients WHERE data_holder IS NOT NULL),
raw AS (SELECT u.data_holder AS grp,
 (SELECT count(*) FROM public.eligible_patients p WHERE p.data_holder=u.data_holder AND 2025-EXTRACT(YEAR FROM p.birth_date)>=18 AND EXISTS (SELECT 1 FROM public.conditions c WHERE c.patient_id=p.patient_id AND c.icd10 LIKE 'I50%')) AS d,
 (SELECT count(*) FROM public.eligible_patients p WHERE p.data_holder=u.data_holder AND 2025-EXTRACT(YEAR FROM p.birth_date)>=18 AND EXISTS (SELECT 1 FROM public.conditions c WHERE c.patient_id=p.patient_id AND c.icd10 LIKE 'I50%') AND EXISTS (SELECT 1 FROM public.medications m WHERE m.patient_id=p.patient_id AND m.atc LIKE 'C03CA%' AND m.start_date<=DATE '2025-12-31' AND (m.end_date IS NULL OR m.end_date>=DATE '2025-12-31'))) AS n FROM universe u)
SELECT ARRAY[grp,'adults_with_heart_failure'] AS path, 'count' AS kind,d::text AS n,NULL::text AS denominator FROM raw
UNION ALL SELECT ARRAY[grp,'diuretic_pct'],'percentage',n::text,d::text FROM raw;
