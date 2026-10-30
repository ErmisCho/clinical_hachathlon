-- Lifecycle event log: one row per status transition per submission.
CREATE TABLE public.request_event (
  id bigserial PRIMARY KEY,
  request_log_id bigint NOT NULL REFERENCES public.request_log(id),
  request_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('submitted','assessed','staff_review','decided','fulfilled')),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX request_event_log ON public.request_event
  (request_log_id, at ASC, id ASC);
ALTER TABLE public.request_event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.request_event FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.request_event_id_seq FROM PUBLIC, anon, authenticated;
GRANT INSERT, SELECT ON TABLE public.request_event TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.request_event_id_seq TO service_role;
