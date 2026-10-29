-- Migration: create spe_download_log
-- Records every download attempt against a secure processing environment.
-- These attempts are ALWAYS blocked (EHDS Art. 73); the log is for auditing.

CREATE TABLE public.spe_download_log (
  id            bigserial PRIMARY KEY,
  request_id    text        NOT NULL,
  schema        text        NOT NULL,
  attempted_at  timestamptz NOT NULL DEFAULT now(),
  user_agent    text
);

ALTER TABLE public.spe_download_log ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated access; only service_role may insert/select.
REVOKE ALL ON TABLE public.spe_download_log FROM PUBLIC, anon, authenticated;
GRANT INSERT, SELECT ON TABLE public.spe_download_log TO service_role;
-- Allow service_role to use the sequence for the serial PK.
GRANT USAGE, SELECT ON SEQUENCE public.spe_download_log_id_seq TO service_role;
