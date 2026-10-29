create table public.patients (
  patient_id text primary key,
  sex text,
  birth_date date,
  region text,
  data_holder text,
  opted_out boolean not null
);

create table public.conditions (
  patient_id text not null references public.patients (patient_id),
  icd10 text,
  description text,
  onset_date date
);

create table public.medications (
  patient_id text not null references public.patients (patient_id),
  atc text,
  name text,
  start_date date,
  end_date date
);

create table public.observations (
  patient_id text not null references public.patients (patient_id),
  loinc text,
  name text,
  value numeric,
  unit text,
  date date
);

create table public.encounters (
  encounter_id text primary key,
  patient_id text not null references public.patients (patient_id),
  data_holder text,
  type text,
  start_date date,
  end_date date,
  primary_icd10 text
);

create index conditions_patient_id_idx on public.conditions (patient_id);
create index conditions_icd10_idx on public.conditions (icd10);
create index medications_patient_id_idx on public.medications (patient_id);
create index medications_atc_idx on public.medications (atc);
create index observations_patient_id_idx on public.observations (patient_id);
create index observations_loinc_idx on public.observations (loinc);
create index encounters_patient_id_idx on public.encounters (patient_id);
create index encounters_primary_icd10_idx on public.encounters (primary_icd10);

-- All patient cohort queries must start here and join child tables by patient_id.
create view public.eligible_patients
with (security_invoker = true)
as select * from public.patients where opted_out = false;

alter table public.patients enable row level security;
alter table public.conditions enable row level security;
alter table public.medications enable row level security;
alter table public.observations enable row level security;
alter table public.encounters enable row level security;

-- No browser policies. Also revoke PUBLIC to prevent inherited access.
revoke all privileges on table
  public.patients, public.conditions, public.medications,
  public.observations, public.encounters, public.eligible_patients
from public, anon, authenticated;

-- Trusted backend only; security_invoker requires access to the base table too.
grant select on table
  public.patients, public.conditions, public.medications,
  public.observations, public.encounters, public.eligible_patients
to service_role;
