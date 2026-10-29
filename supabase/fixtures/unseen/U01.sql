-- Independent reference: count stays, not people, by the patient's region.
-- LEFT JOIN preserves regions with no matching stay; opted-out people are absent.
-- J18.9 is present in the supplied encounters.csv, including 2025 inpatients.
SELECT p.region AS group_key, count(e.encounter_id)::text AS n
FROM public.eligible_patients AS p
LEFT JOIN public.encounters AS e
  ON e.patient_id = p.patient_id
  AND e.type = 'inpatient'
  AND e.start_date >= DATE '2025-01-01'
  AND e.start_date < DATE '2026-01-01'
  AND e.primary_icd10 LIKE 'J18%'
WHERE p.region IS NOT NULL
GROUP BY p.region
ORDER BY p.region;
