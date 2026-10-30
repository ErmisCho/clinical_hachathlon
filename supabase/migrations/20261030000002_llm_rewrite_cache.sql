-- Migration: llm_rewrite_cache — Issue #15
-- Stores watsonx rewrite results keyed by a hash of request text so that
-- repeated submissions produce identical results (three-run consistency).
-- Only definition strings + the question are ever stored; no patient data.

CREATE TABLE IF NOT EXISTS public.llm_rewrite_cache (
  request_hash text PRIMARY KEY,          -- SHA-256 hex of question + failing defs
  rewrites     jsonb     NOT NULL,         -- [{original, rewritten}]
  model        text      NOT NULL,         -- e.g. "ibm/granite-13b-instruct-v2"
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Only the edge function service role may read/write this table.
ALTER TABLE public.llm_rewrite_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.llm_rewrite_cache FROM anon, authenticated;
