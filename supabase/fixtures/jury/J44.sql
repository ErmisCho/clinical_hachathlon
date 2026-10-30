-- Independent reference authored from applicant definitions and the data model.
-- Raw cells are for verification only; disclosure controls apply before release.
SELECT ARRAY['current_ace_users'] AS path, 'count' AS kind, count(DISTINCT p.patient_id)::text AS n
FROM public.eligible_patients p WHERE EXISTS (SELECT 1 FROM public.medications m WHERE m.patient_id = p.patient_id AND m.atc LIKE 'C09AA%' AND m.start_date <= DATE '2025-12-31' AND (m.end_date IS NULL OR m.end_date >= DATE '2025-12-31'));
