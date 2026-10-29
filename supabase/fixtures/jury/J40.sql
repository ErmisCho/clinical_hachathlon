-- Independent reference, authored from the request definitions, never from a parsed plan.
-- J40: review case – purpose disavows all allowed categories; question is too vague to parse.
-- The runner reads this file for all non-REJECT cases; scoring uses honestReview path, not these rows.
-- Returns a single sentinel row so referenceAnswer() does not throw "Empty reference".
SELECT ARRAY['review','cohort'] AS path, 'count' AS kind,
 (SELECT count(DISTINCT patient_id)::text FROM public.eligible_patients) AS n;
