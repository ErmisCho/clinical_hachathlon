-- Preserve every submission and its pipeline result, including repeated ids.
CREATE TABLE public.request_log (
  id bigserial PRIMARY KEY,
  request_id text NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  request jsonb NOT NULL,
  response jsonb NOT NULL
);

CREATE INDEX request_log_latest ON public.request_log
  (request_id, submitted_at DESC, id DESC);

ALTER TABLE public.request_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.request_log FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.request_log_id_seq FROM PUBLIC, anon, authenticated;
GRANT INSERT, SELECT ON TABLE public.request_log TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.request_log_id_seq TO service_role;
