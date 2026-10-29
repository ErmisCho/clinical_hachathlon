-- Independent reference: count each adult once, irrespective of duplicate
-- condition records. Hospital means patients.data_holder, not encounter holder.
-- The conditional count preserves hospitals with zero matching adults.
SELECT p.data_holder AS group_key,
  count(CASE
    WHEN p.birth_date <= DATE '2007-12-31'
      AND EXISTS (
        SELECT 1 FROM public.conditions AS c
        WHERE c.patient_id = p.patient_id AND c.icd10 LIKE 'E11%'
      )
    THEN 1
  END)::text AS n
FROM public.eligible_patients AS p
WHERE p.data_holder IS NOT NULL
GROUP BY p.data_holder
ORDER BY p.data_holder;
