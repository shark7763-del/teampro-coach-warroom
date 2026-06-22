-- TeamPro initial Supabase schema.
-- Safe to run on a new project. Existing GAS/Google Sheet data is untouched.

create extension if not exists citext;
create extension if not exists pgcrypto;

create table if not exists public.coaches (
  coach_id text primary key default ('c_' || replace(gen_random_uuid()::text, '-', '')),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  email citext not null unique,
  name text not null,
  plan text not null default 'free' check (plan in ('free', 'coach', 'team', 'pro')),
  plan_expiry date,
  status text not null default 'active' check (status in ('active', 'disabled')),
  payment_note text,
  settings jsonb not null default '{}'::jsonb,
  legacy_password_hash text,
  legacy_password_salt text,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.teams (
  team_id text primary key default ('t_' || replace(gen_random_uuid()::text, '-', '')),
  coach_id text not null references public.coaches(coach_id) on delete cascade,
  team_name text not null,
  sport text,
  share_token text not null unique default encode(gen_random_bytes(24), 'hex'),
  status text not null default 'active' check (status in ('active', 'disabled')),
  competition_system text,
  sport_category text,
  member_term text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.athletes (
  athlete_id text primary key default ('a_' || replace(gen_random_uuid()::text, '-', '')),
  coach_id text not null references public.coaches(coach_id) on delete cascade,
  team_id text not null references public.teams(team_id) on delete cascade,
  name text not null,
  grade_class text,
  athlete_group text,
  active boolean not null default true,
  last_performance_visibility text not null default 'self_coach_only'
    check (last_performance_visibility in ('self_coach_only', 'coach_assistant', 'parent_summary_only', 'anonymous_stats')),
  perf_pin_hash text,
  perf_pin_salt text,
  kpi_enabled boolean not null default false,
  kpi_enabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, athlete_id)
);

create table if not exists public.daily_records (
  record_id text primary key default ('r_' || replace(gen_random_uuid()::text, '-', '')),
  coach_id text not null references public.coaches(coach_id) on delete cascade,
  team_id text not null references public.teams(team_id) on delete cascade,
  athlete_id text not null references public.athletes(athlete_id) on delete cascade,
  record_date date not null,
  submitted_at timestamptz not null default now(),
  session_type text not null default 'training',
  status text not null default 'green' check (status in ('green', 'yellow', 'red')),
  height_cm numeric(6,2),
  weight_kg numeric(6,2),
  target_weight_kg numeric(6,2),
  bmi numeric(5,2),
  breakfast text,
  lunch text,
  dinner text,
  snacks_drinks text,
  late_night_snack text,
  breakfast_nutri text,
  lunch_nutri text,
  dinner_nutri text,
  training_am text,
  training_pm text,
  training_eve text,
  training_notes text,
  mood_index smallint check (mood_index between 1 and 5),
  mood_reason text,
  gratitude text,
  reflection text,
  fatigue smallint check (fatigue between 1 and 10),
  sleep_bed_time time,
  wake_time time,
  sleep_quality text,
  sleep_duration_minutes integer,
  sleep_duration_text text,
  sleep_risk text check (sleep_risk in ('green', 'yellow', 'red')),
  pain_status text,
  pain_areas text,
  pain_score smallint check (pain_score between 0 and 10),
  pain_impact text,
  pain_note text,
  pain_risk text check (pain_risk in ('green', 'yellow', 'red')),
  water_amount text check (water_amount in ('very_little', 'normal', 'enough', 'a_lot')),
  sweat_amount text check (sweat_amount in ('low', 'normal', 'high', 'very_high')),
  urine_color text check (urine_color in ('clear', 'pale_yellow', 'yellow', 'dark', 'abnormal')),
  hydration_risk text check (hydration_risk in ('green', 'yellow', 'red')),
  hydration_advice text,
  hydration_flags text,
  report_quality_score smallint check (report_quality_score between 0 and 100),
  report_quality_label text,
  report_quality_reasons text,
  coach_suggestion text,
  encourage_name text,
  encourage_msg text,
  coach_comment text,
  coach_feedback_at timestamptz,
  nutrition_advice text,
  student_line_text text,
  parent_line_text text,
  coach_line_text text,
  consent_privacy boolean not null default false,
  guardian_consent boolean not null default false,
  consent_at timestamptz,
  privacy_version text,
  consent_text text,
  device_info text,
  competition_name text,
  competition_date date,
  competition_location text,
  competition_result text,
  competition_detail text,
  competition_reflection text,
  competition_award boolean not null default false,
  competition_award_path text,
  raw_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (team_id, athlete_id, record_date)
);

create table if not exists public.weekly_kpi (
  weekly_kpi_id text primary key default ('wk_' || replace(gen_random_uuid()::text, '-', '')),
  coach_id text not null references public.coaches(coach_id) on delete cascade,
  team_id text not null references public.teams(team_id) on delete cascade,
  athlete_id text not null references public.athletes(athlete_id) on delete cascade,
  week_start date not null,
  week_end date not null,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  tech_accuracy smallint, tech_stability smallint, tech_speed smallint, tech_power smallint, tech_completion smallint,
  tac_distance smallint, tac_timing smallint, tac_transition smallint, tac_read smallint, tac_execution smallint,
  phy_explosive smallint, phy_strength smallint, phy_endurance smallint, phy_cardio smallint, phy_agility smallint,
  men_focus smallint, men_stress smallint, men_confidence smallint, men_resilience smallint, men_motivation smallint,
  att_discipline smallint, att_engagement smallint, att_initiative smallint, att_coachability smallint, att_teamwork smallint,
  pio_sleep smallint, pio_spirit smallint, pio_soreness smallint, pio_injury smallint, pio_recovery smallint,
  technical_avg numeric(4,2),
  tactical_avg numeric(4,2),
  physical_avg numeric(4,2),
  mental_avg numeric(4,2),
  attitude_avg numeric(4,2),
  physiological_avg numeric(4,2),
  total_score numeric(4,2),
  status text check (status in ('green', 'yellow', 'red')),
  quality_score smallint check (quality_score between 0 and 100),
  quality_label text,
  quality_reasons text,
  raw_json jsonb not null default '{}'::jsonb,
  unique (athlete_id, week_start),
  constraint weekly_kpi_scores check (
    tech_accuracy between 1 and 5 and tech_stability between 1 and 5 and tech_speed between 1 and 5 and
    tech_power between 1 and 5 and tech_completion between 1 and 5 and tac_distance between 1 and 5 and
    tac_timing between 1 and 5 and tac_transition between 1 and 5 and tac_read between 1 and 5 and
    tac_execution between 1 and 5 and phy_explosive between 1 and 5 and phy_strength between 1 and 5 and
    phy_endurance between 1 and 5 and phy_cardio between 1 and 5 and phy_agility between 1 and 5 and
    men_focus between 1 and 5 and men_stress between 1 and 5 and men_confidence between 1 and 5 and
    men_resilience between 1 and 5 and men_motivation between 1 and 5 and att_discipline between 1 and 5 and
    att_engagement between 1 and 5 and att_initiative between 1 and 5 and att_coachability between 1 and 5 and
    att_teamwork between 1 and 5 and pio_sleep between 1 and 5 and pio_spirit between 1 and 5 and
    pio_soreness between 1 and 5 and pio_injury between 1 and 5 and pio_recovery between 1 and 5
  )
);

create table if not exists public.attendance (
  attendance_id text primary key default ('att_' || replace(gen_random_uuid()::text, '-', '')),
  coach_id text not null references public.coaches(coach_id) on delete cascade,
  team_id text not null references public.teams(team_id) on delete cascade,
  attendance_date date not null,
  course text,
  marks jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (team_id, attendance_date, course)
);

create table if not exists public.competitions (
  competition_id text primary key default ('cp_' || replace(gen_random_uuid()::text, '-', '')),
  coach_id text not null references public.coaches(coach_id) on delete cascade,
  team_id text not null references public.teams(team_id) on delete cascade,
  competition_date date not null,
  name text not null,
  location text,
  created_at timestamptz not null default now(),
  unique (team_id, competition_date, name)
);

create table if not exists public.privacy_requests (
  request_id text primary key default ('pr_' || replace(gen_random_uuid()::text, '-', '')),
  coach_id text not null references public.coaches(coach_id) on delete cascade,
  athlete_id text references public.athletes(athlete_id) on delete set null,
  athlete_name text,
  request_type text not null check (request_type in ('hide_record', 'delete_record', 'correct_data', 'stop_use')),
  scope text,
  note text,
  status text not null default 'pending' check (status in ('pending', 'handled', 'rejected')),
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  resolution_note text
);

create table if not exists public.audit_logs (
  audit_id bigint generated always as identity primary key,
  coach_id text references public.coaches(coach_id) on delete set null,
  actor text,
  action text not null,
  target text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.contacts (
  contact_id bigint generated always as identity primary key,
  topic text,
  name text,
  email citext,
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists teams_coach_idx on public.teams (coach_id);
create index if not exists athletes_coach_team_idx on public.athletes (coach_id, team_id);
create index if not exists records_team_date_idx on public.daily_records (team_id, record_date desc);
create index if not exists records_athlete_date_idx on public.daily_records (athlete_id, record_date desc);
create index if not exists weekly_kpi_team_week_idx on public.weekly_kpi (team_id, week_start desc);
create index if not exists weekly_kpi_athlete_week_idx on public.weekly_kpi (athlete_id, week_start desc);
create index if not exists attendance_team_date_idx on public.attendance (team_id, attendance_date desc);
create index if not exists competitions_team_date_idx on public.competitions (team_id, competition_date desc);
create index if not exists privacy_requests_coach_status_idx on public.privacy_requests (coach_id, status);
create index if not exists audit_logs_coach_created_idx on public.audit_logs (coach_id, created_at desc);

create or replace function public.current_coach_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coach_id from public.coaches where auth_user_id = auth.uid() limit 1
$$;

revoke all on function public.current_coach_id() from public;
grant execute on function public.current_coach_id() to authenticated;

alter table public.coaches enable row level security;
alter table public.teams enable row level security;
alter table public.athletes enable row level security;
alter table public.daily_records enable row level security;
alter table public.weekly_kpi enable row level security;
alter table public.attendance enable row level security;
alter table public.competitions enable row level security;
alter table public.privacy_requests enable row level security;
alter table public.audit_logs enable row level security;
alter table public.contacts enable row level security;

drop policy if exists coaches_own_select on public.coaches;
create policy coaches_own_select on public.coaches for select to authenticated
  using (auth_user_id = auth.uid());
drop policy if exists coaches_own_update on public.coaches;
create policy coaches_own_update on public.coaches for update to authenticated
  using (auth_user_id = auth.uid()) with check (auth_user_id = auth.uid());

drop policy if exists teams_coach_all on public.teams;
create policy teams_coach_all on public.teams for all to authenticated
  using (coach_id = public.current_coach_id()) with check (coach_id = public.current_coach_id());
drop policy if exists athletes_coach_all on public.athletes;
create policy athletes_coach_all on public.athletes for all to authenticated
  using (coach_id = public.current_coach_id()) with check (coach_id = public.current_coach_id());
drop policy if exists daily_records_coach_all on public.daily_records;
create policy daily_records_coach_all on public.daily_records for all to authenticated
  using (coach_id = public.current_coach_id()) with check (coach_id = public.current_coach_id());
drop policy if exists weekly_kpi_coach_all on public.weekly_kpi;
create policy weekly_kpi_coach_all on public.weekly_kpi for all to authenticated
  using (coach_id = public.current_coach_id()) with check (coach_id = public.current_coach_id());
drop policy if exists attendance_coach_all on public.attendance;
create policy attendance_coach_all on public.attendance for all to authenticated
  using (coach_id = public.current_coach_id()) with check (coach_id = public.current_coach_id());
drop policy if exists competitions_coach_all on public.competitions;
create policy competitions_coach_all on public.competitions for all to authenticated
  using (coach_id = public.current_coach_id()) with check (coach_id = public.current_coach_id());
drop policy if exists privacy_requests_coach_all on public.privacy_requests;
create policy privacy_requests_coach_all on public.privacy_requests for all to authenticated
  using (coach_id = public.current_coach_id()) with check (coach_id = public.current_coach_id());
drop policy if exists audit_logs_coach_select on public.audit_logs;
create policy audit_logs_coach_select on public.audit_logs for select to authenticated
  using (coach_id = public.current_coach_id());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('award-photos', 'award-photos', false, 4194304, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- No anon policies are created intentionally. Public athlete flows must use an
-- Edge Function that validates share_token and PIN with the service-role key.
