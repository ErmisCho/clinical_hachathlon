-- Staff decisions belong to the exact submission reviewed, even for repeated ids.
CREATE TABLE public.staff_action (
  id bigserial PRIMARY KEY,
  request_id text NOT NULL,
  request_log_id bigint NOT NULL REFERENCES public.request_log(id),
  action text NOT NULL CHECK (action IN ('approve', 'override')),
  decision text NOT NULL CHECK (decision IN ('REJECT', 'APPROVE_STATISTICAL', 'APPROVE_SPE')),
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  staff_name text NOT NULL CHECK (length(trim(staff_name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_action_latest ON public.staff_action
  (request_log_id, created_at DESC, id DESC);
ALTER TABLE public.staff_action ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.staff_action FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.staff_action_id_seq FROM PUBLIC, anon, authenticated;
GRANT INSERT, SELECT ON TABLE public.staff_action TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.staff_action_id_seq TO service_role;
GRANT UPDATE (response) ON TABLE public.request_log TO service_role;
