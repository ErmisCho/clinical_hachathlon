-- Add staff_user_id (uuid) to staff_action so the audit log records the signed-in
-- Supabase Auth user, not a typed name.  Nullable so existing rows are unaffected.
ALTER TABLE public.staff_action
  ADD COLUMN IF NOT EXISTS staff_user_id uuid;
