-- ============================================================================
-- TeamPro 006 — 多租戶治理平台 schema（organizations → schools → teams）
-- 評鑑規則引擎、缺漏中心(evaluation_tasks)、佐證庫(evidence_files)、
-- users/user_roles/team_memberships、exports、subscriptions、軟刪除、RLS。
--
-- 設計原則：
--   1. 全部 additive（新表 + 對既有表 ADD COLUMN nullable），不破壞 001~005 既有資料。
--   2. 既有 coaches/teams/athletes 保留；本遷移新增 users 身分層與 org/school 層。
--      舊資料的 organization_id / school_id 先為 NULL，之後由 backfill 腳本補。
--   3. 回滾腳本：006_multitenant_governance_down.sql
-- ============================================================================

create extension if not exists citext;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. 租戶層：organizations → schools
-- ---------------------------------------------------------------------------
create table if not exists public.organizations (
  organization_id text primary key default ('org_' || replace(gen_random_uuid()::text, '-', '')),
  name text not null,
  org_type text not null default 'school' check (org_type in ('school', 'government', 'organization')),
  city text,
  plan text not null default 'trial' check (plan in ('trial', 'coach', 'school', 'government')),
  status text not null default 'active' check (status in ('active', 'disabled', 'trial', 'expired')),
  is_demo boolean not null default false,
  settings jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.schools (
  school_id text primary key default ('sch_' || replace(gen_random_uuid()::text, '-', '')),
  organization_id text not null references public.organizations(organization_id) on delete cascade,
  name text not null,
  city text,
  school_level text check (school_level in ('elementary', 'junior_high', 'senior_high', 'vocational', 'university', 'other')),
  academic_year text,                       -- 現行學年度，例如 '114'
  is_demo boolean not null default false,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists schools_org_idx on public.schools (organization_id);

-- ---------------------------------------------------------------------------
-- 2. 身分與角色：users / user_roles / team_memberships
--    users 為新身分層，可對應 auth.users 或既有 coaches（legacy_coach_id）。
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  user_id text primary key default ('u_' || replace(gen_random_uuid()::text, '-', '')),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  legacy_coach_id text references public.coaches(coach_id) on delete set null,
  email citext unique,
  name text not null,
  phone text,
  status text not null default 'active' check (status in ('active', 'disabled', 'invited')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- 角色綁在「組織/學校」範圍上（platform_admin 兩者皆 NULL 代表跨租戶）
create table if not exists public.user_roles (
  user_role_id text primary key default ('ur_' || replace(gen_random_uuid()::text, '-', '')),
  user_id text not null references public.users(user_id) on delete cascade,
  role text not null check (role in
    ('coach', 'assistant_coach', 'school_admin', 'director', 'guardian', 'athlete', 'platform_admin')),
  organization_id text references public.organizations(organization_id) on delete cascade,
  school_id text references public.schools(school_id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  unique (user_id, role, organization_id, school_id)
);
create index if not exists user_roles_user_idx on public.user_roles (user_id);
create index if not exists user_roles_scope_idx on public.user_roles (organization_id, school_id);

-- 教練/助教 ↔ 隊伍 指派（決定「只能看負責隊伍」）
create table if not exists public.team_memberships (
  membership_id text primary key default ('tm_' || replace(gen_random_uuid()::text, '-', '')),
  user_id text not null references public.users(user_id) on delete cascade,
  team_id text not null references public.teams(team_id) on delete cascade,
  role text not null default 'coach' check (role in ('coach', 'assistant_coach')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  unique (user_id, team_id)
);
create index if not exists team_memberships_team_idx on public.team_memberships (team_id);
create index if not exists team_memberships_user_idx on public.team_memberships (user_id);

-- ---------------------------------------------------------------------------
-- 3. 既有核心表補上租戶欄位與軟刪除（nullable，向後相容）
-- ---------------------------------------------------------------------------
alter table public.teams        add column if not exists organization_id text references public.organizations(organization_id) on delete set null;
alter table public.teams        add column if not exists school_id text references public.schools(school_id) on delete set null;
alter table public.teams        add column if not exists academic_year text;
alter table public.teams        add column if not exists created_by text;
alter table public.teams        add column if not exists deleted_at timestamptz;

alter table public.athletes     add column if not exists organization_id text references public.organizations(organization_id) on delete set null;
alter table public.athletes     add column if not exists school_id text references public.schools(school_id) on delete set null;
alter table public.athletes     add column if not exists created_by text;
alter table public.athletes     add column if not exists status text not null default 'active';
alter table public.athletes     add column if not exists deleted_at timestamptz;

alter table public.daily_records add column if not exists organization_id text;
alter table public.daily_records add column if not exists school_id text;
alter table public.daily_records add column if not exists created_by text;
alter table public.daily_records add column if not exists deleted_at timestamptz;

alter table public.attendance   add column if not exists organization_id text;
alter table public.attendance   add column if not exists school_id text;
alter table public.attendance   add column if not exists created_by text;
alter table public.attendance   add column if not exists deleted_at timestamptz;

alter table public.competitions add column if not exists organization_id text;
alter table public.competitions add column if not exists school_id text;
alter table public.competitions add column if not exists created_by text;
alter table public.competitions add column if not exists deleted_at timestamptz;

alter table public.audit_logs   add column if not exists organization_id text;
alter table public.audit_logs   add column if not exists school_id text;
alter table public.audit_logs   add column if not exists user_id text;

-- ---------------------------------------------------------------------------
-- 4. 日常紀錄補強表（訓練日誌 / 異常 / 傷病 / 比賽成績 / 家長 / 點名場次）
-- ---------------------------------------------------------------------------
create table if not exists public.training_logs (
  training_log_id text primary key default ('tl_' || replace(gen_random_uuid()::text, '-', '')),
  organization_id text, school_id text,
  team_id text not null references public.teams(team_id) on delete cascade,
  log_date date not null,
  session_type text not null default 'training',
  topic text,
  content text,
  load_rpe smallint check (load_rpe between 0 and 10),
  notes text,
  created_by text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists training_logs_team_date_idx on public.training_logs (team_id, log_date desc);

create table if not exists public.athlete_incidents (
  incident_id text primary key default ('inc_' || replace(gen_random_uuid()::text, '-', '')),
  organization_id text, school_id text,
  team_id text not null references public.teams(team_id) on delete cascade,
  athlete_id text not null references public.athletes(athlete_id) on delete cascade,
  incident_date date not null default current_date,
  incident_type text not null default 'other'
    check (incident_type in ('absence', 'pain_up', 'mood', 'no_report', 'load', 'other')),
  severity text not null default 'yellow' check (severity in ('green', 'yellow', 'orange', 'red')),
  note text,
  resolved boolean not null default false,
  resolved_at timestamptz,
  created_by text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists incidents_team_date_idx on public.athlete_incidents (team_id, incident_date desc);

create table if not exists public.injury_records (
  injury_id text primary key default ('inj_' || replace(gen_random_uuid()::text, '-', '')),
  organization_id text, school_id text,
  team_id text not null references public.teams(team_id) on delete cascade,
  athlete_id text not null references public.athletes(athlete_id) on delete cascade,
  onset_date date not null default current_date,
  body_part text,
  description text,
  pain_score smallint check (pain_score between 0 and 10),
  status text not null default 'active' check (status in ('active', 'recovering', 'recovered', 'closed')),
  recovered_at date,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists injuries_athlete_idx on public.injury_records (athlete_id, onset_date desc);

create table if not exists public.competition_results (
  result_id text primary key default ('cr_' || replace(gen_random_uuid()::text, '-', '')),
  organization_id text, school_id text,
  team_id text not null references public.teams(team_id) on delete cascade,
  competition_id text references public.competitions(competition_id) on delete set null,
  athlete_id text references public.athletes(athlete_id) on delete set null,
  academic_year text,
  competition_name text not null,
  competition_date date,
  event_group text,                          -- 組別 / 量級
  rank text,                                 -- 名次
  score text,
  award boolean not null default false,
  award_path text,
  note text,
  created_by text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists comp_results_team_idx on public.competition_results (team_id, competition_date desc);

create table if not exists public.athlete_guardians (
  guardian_id text primary key default ('g_' || replace(gen_random_uuid()::text, '-', '')),
  athlete_id text not null references public.athletes(athlete_id) on delete cascade,
  user_id text references public.users(user_id) on delete set null,
  name text,
  relation text,
  phone text,
  email citext,
  can_view boolean not null default true,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (athlete_id, user_id)
);

create table if not exists public.attendance_sessions (
  session_id text primary key default ('as_' || replace(gen_random_uuid()::text, '-', '')),
  organization_id text, school_id text,
  team_id text not null references public.teams(team_id) on delete cascade,
  session_date date not null,
  slot text,                                  -- 晨操 / 下午 / 晚自習
  created_by text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (team_id, session_date, slot)
);
create table if not exists public.attendance_records (
  attendance_record_id text primary key default ('ar_' || replace(gen_random_uuid()::text, '-', '')),
  session_id text not null references public.attendance_sessions(session_id) on delete cascade,
  athlete_id text not null references public.athletes(athlete_id) on delete cascade,
  mark text not null default 'present'
    check (mark in ('present', 'late', 'leave', 'official_leave', 'sick', 'absent', 'other')),
  note text,
  created_at timestamptz not null default now(),
  unique (session_id, athlete_id)
);

-- ---------------------------------------------------------------------------
-- 5. 評鑑規則引擎（可由管理員設定，不寫死）
--    templates → dimensions → items → requirements / evidence_rules
--    evaluation_progress = 每個 (school, item) 的完成狀態
-- ---------------------------------------------------------------------------
create table if not exists public.evaluation_templates (
  template_id text primary key default ('et_' || replace(gen_random_uuid()::text, '-', '')),
  organization_id text references public.organizations(organization_id) on delete cascade,
  name text not null,
  academic_year text,
  city text,
  school_level text,
  description text,
  is_active boolean not null default true,
  is_demo boolean not null default false,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.evaluation_dimensions (
  dimension_id text primary key default ('ed_' || replace(gen_random_uuid()::text, '-', '')),
  template_id text not null references public.evaluation_templates(template_id) on delete cascade,
  name text not null,
  description text,
  sort_order integer not null default 0,
  weight numeric(6,2) not null default 1
);
create index if not exists eval_dims_tpl_idx on public.evaluation_dimensions (template_id, sort_order);

create table if not exists public.evaluation_items (
  item_id text primary key default ('ei_' || replace(gen_random_uuid()::text, '-', '')),
  template_id text not null references public.evaluation_templates(template_id) on delete cascade,
  dimension_id text references public.evaluation_dimensions(dimension_id) on delete set null,
  name text not null,
  description text,
  weight numeric(6,2) not null default 1,
  due_date date,
  responsible_role text check (responsible_role in
    ('coach', 'assistant_coach', 'school_admin', 'director')),
  requires_review boolean not null default false,
  -- 完成判定方式：manual=人工勾選 / evidence=有可採計佐證 / fields=必填欄位齊全
  completion_mode text not null default 'evidence'
    check (completion_mode in ('manual', 'evidence', 'fields')),
  sort_order integer not null default 0,
  is_required boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists eval_items_tpl_idx on public.evaluation_items (template_id, sort_order);

-- 必填欄位定義（completion_mode='fields' 用）
create table if not exists public.evaluation_requirements (
  requirement_id text primary key default ('erq_' || replace(gen_random_uuid()::text, '-', '')),
  item_id text not null references public.evaluation_items(item_id) on delete cascade,
  field_key text not null,
  field_label text,
  field_type text not null default 'text',
  is_required boolean not null default true
);

-- 必要佐證規則（completion_mode='evidence' 用）
create table if not exists public.evaluation_evidence_rules (
  evidence_rule_id text primary key default ('erv_' || replace(gen_random_uuid()::text, '-', '')),
  item_id text not null references public.evaluation_items(item_id) on delete cascade,
  evidence_type text not null,
  min_count integer not null default 1,
  note text
);

-- 每校每項的進度（真實完成率的來源）
create table if not exists public.evaluation_progress (
  progress_id text primary key default ('ep_' || replace(gen_random_uuid()::text, '-', '')),
  organization_id text, school_id text not null references public.schools(school_id) on delete cascade,
  template_id text not null references public.evaluation_templates(template_id) on delete cascade,
  item_id text not null references public.evaluation_items(item_id) on delete cascade,
  team_id text references public.teams(team_id) on delete set null,
  academic_year text,
  -- 狀態機：未開始/處理中/待審核/退回補件/已完成/已逾期
  state text not null default 'not_started' check (state in
    ('not_started', 'in_progress', 'pending_review', 'returned', 'completed', 'overdue')),
  completion_note text,
  updated_by text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (school_id, item_id, academic_year)
);
create index if not exists eval_progress_school_idx on public.evaluation_progress (school_id, template_id);

-- ---------------------------------------------------------------------------
-- 6. 缺漏中心：evaluation_tasks（指派負責人 + 截止日 + 催繳 + 6 狀態）
-- ---------------------------------------------------------------------------
create table if not exists public.evaluation_tasks (
  task_id text primary key default ('task_' || replace(gen_random_uuid()::text, '-', '')),
  organization_id text, school_id text not null references public.schools(school_id) on delete cascade,
  template_id text references public.evaluation_templates(template_id) on delete set null,
  item_id text references public.evaluation_items(item_id) on delete set null,
  team_id text references public.teams(team_id) on delete set null,
  title text not null,                         -- 缺漏項目
  evaluation_item_label text,                  -- 對應評鑑指標（快照）
  assignee_user_id text references public.users(user_id) on delete set null,
  due_date date,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  state text not null default 'not_started' check (state in
    ('not_started', 'in_progress', 'pending_review', 'returned', 'completed', 'overdue')),
  reminder_log jsonb not null default '[]'::jsonb,   -- 催繳紀錄 [{at,by,channel}]
  completion_note text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists eval_tasks_school_state_idx on public.evaluation_tasks (school_id, state);
create index if not exists eval_tasks_assignee_idx on public.evaluation_tasks (assignee_user_id, state);
create index if not exists eval_tasks_due_idx on public.evaluation_tasks (due_date);

-- ---------------------------------------------------------------------------
-- 7. 佐證資料庫：evidence_files（完整欄位 + 審核 + 效度）
-- ---------------------------------------------------------------------------
create table if not exists public.evidence_files (
  evidence_id text primary key default ('ev_' || replace(gen_random_uuid()::text, '-', '')),
  organization_id text references public.organizations(organization_id) on delete cascade,
  school_id text references public.schools(school_id) on delete cascade,
  team_id text references public.teams(team_id) on delete set null,
  academic_year text,
  athlete_id text references public.athletes(athlete_id) on delete set null,
  competition_id text references public.competitions(competition_id) on delete set null,
  evaluation_item_id text references public.evaluation_items(item_id) on delete set null,
  task_id text references public.evaluation_tasks(task_id) on delete set null,
  evidence_type text,
  file_url text,
  storage_path text,                           -- 私有 bucket 路徑（走簽名網址）
  original_filename text,
  generated_filename text,                     -- 學年_學校_隊伍_學生_賽事_組別_名次
  uploaded_by text,
  uploaded_at timestamptz not null default now(),
  review_status text not null default 'not_checked' check (review_status in
    ('not_checked', 'insufficient', 'need_more', 'acceptable', 'not_recommended', 'confirmed')),
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  validity_status text not null default 'unknown' check (validity_status in
    ('unknown', 'valid', 'expired', 'invalid')),
  status text not null default 'active',
  deleted_at timestamptz
);
create index if not exists evidence_school_item_idx on public.evidence_files (school_id, evaluation_item_id);
create index if not exists evidence_task_idx on public.evidence_files (task_id);
create index if not exists evidence_review_idx on public.evidence_files (school_id, review_status);

-- 佐證自動命名：學年_學校_隊伍_學生_賽事或活動_組別_名次
create or replace function public.build_evidence_filename(
  p_academic_year text, p_school text, p_team text, p_athlete text,
  p_event text, p_group text, p_rank text
) returns text language sql immutable as $$
  select array_to_string(array_remove(array[
    nullif(trim(coalesce(p_academic_year,'')),''),
    nullif(trim(coalesce(p_school,'')),''),
    nullif(trim(coalesce(p_team,'')),''),
    nullif(trim(coalesce(p_athlete,'')),''),
    nullif(trim(coalesce(p_event,'')),''),
    nullif(trim(coalesce(p_group,'')),''),
    nullif(trim(coalesce(p_rank,'')),'')
  ], NULL), '_')
$$;

-- ---------------------------------------------------------------------------
-- 8. 商業化：subscriptions（授權/配額）+ exports（匯出紀錄）+ 試用申請
-- ---------------------------------------------------------------------------
create table if not exists public.subscriptions (
  subscription_id text primary key default ('sub_' || replace(gen_random_uuid()::text, '-', '')),
  organization_id text not null references public.organizations(organization_id) on delete cascade,
  plan text not null default 'trial' check (plan in ('trial', 'coach', 'school', 'government')),
  status text not null default 'trial' check (status in ('trial', 'active', 'expired', 'canceled')),
  started_at date,
  expires_at date,
  max_teams integer,
  max_coaches integer,
  storage_mb integer,
  ai_quota integer,
  export_quota integer,
  features jsonb not null default '{}'::jsonb,
  trial_converted boolean not null default false,
  payment_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists subs_org_idx on public.subscriptions (organization_id);

create table if not exists public.exports (
  export_id text primary key default ('exp_' || replace(gen_random_uuid()::text, '-', '')),
  organization_id text, school_id text references public.schools(school_id) on delete cascade,
  academic_year text,
  export_type text not null default 'official_package',
  file_url text,
  storage_path text,
  item_count integer,
  created_by text,
  created_at timestamptz not null default now()
);

create table if not exists public.trial_requests (
  trial_request_id text primary key default ('trq_' || replace(gen_random_uuid()::text, '-', '')),
  school_name text not null,
  city text,
  contact_name text,
  contact_email citext,
  contact_phone text,
  role text,
  team_count text,
  message text,
  status text not null default 'new' check (status in ('new', 'contacted', 'onboarding', 'converted', 'rejected')),
  organization_id text references public.organizations(organization_id) on delete set null,
  created_at timestamptz not null default now(),
  handled_at timestamptz
);

-- 新手導引進度（每校）
create table if not exists public.onboarding_progress (
  onboarding_id text primary key default ('ob_' || replace(gen_random_uuid()::text, '-', '')),
  school_id text not null references public.schools(school_id) on delete cascade,
  step_key text not null,      -- create_school / first_team / invite_coach / import_athletes / first_attendance / first_training / first_evidence / view_gaps / first_report
  done boolean not null default false,
  done_at timestamptz,
  unique (school_id, step_key)
);

-- ---------------------------------------------------------------------------
-- 9. 真實完成率函式（權重法）
--    未開始 0% / 已填未完整 30% / 待審核 70% / 退回補件 50% / 已完成 100% / 已逾期 0%
--    完成率 = Σ(item.weight × state係數) ÷ Σ(item.weight) × 100（僅計 is_required）
-- ---------------------------------------------------------------------------
create or replace function public.state_completion_factor(p_state text)
returns numeric language sql immutable as $$
  select case p_state
    when 'completed'      then 1.00
    when 'pending_review' then 0.70
    when 'returned'       then 0.50
    when 'in_progress'    then 0.30
    when 'overdue'        then 0.00
    else 0.00                                  -- not_started
  end
$$;

create or replace function public.school_completion_rate(p_school_id text, p_template_id text, p_academic_year text)
returns numeric language sql stable as $$
  with items as (
    select i.item_id, i.weight
    from public.evaluation_items i
    where i.template_id = p_template_id and i.is_required = true
  ),
  prog as (
    select p.item_id, p.state
    from public.evaluation_progress p
    where p.school_id = p_school_id
      and p.template_id = p_template_id
      and (p_academic_year is null or p.academic_year = p_academic_year)
  )
  select case when coalesce(sum(items.weight),0) = 0 then 0
    else round(
      sum(items.weight * public.state_completion_factor(coalesce(prog.state,'not_started')))
      / sum(items.weight) * 100, 1)
  end
  from items left join prog on prog.item_id = items.item_id
$$;

-- ---------------------------------------------------------------------------
-- 10. RLS 權限：以 users/memberships 為基礎的多租戶隔離
-- ---------------------------------------------------------------------------
-- 目前登入者對應的 users.user_id
create or replace function public.app_user_id()
returns text language sql stable security definer set search_path = public as $$
  select user_id from public.users where auth_user_id = auth.uid() limit 1
$$;

create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles r
    where r.user_id = public.app_user_id() and r.role = 'platform_admin' and r.status = 'active'
  )
$$;

-- 使用者可存取的學校（school_admin/director 看該校；platform_admin 全部）
create or replace function public.user_school_ids()
returns setof text language sql stable security definer set search_path = public as $$
  select s.school_id from public.schools s
  where public.is_platform_admin()
     or exists (
        select 1 from public.user_roles r
        where r.user_id = public.app_user_id() and r.status = 'active'
          and (r.school_id = s.school_id or (r.organization_id = s.organization_id and r.school_id is null))
     )
$$;

-- 使用者負責的隊伍（教練/助教看指派隊伍；school_admin/director 看全校隊伍）
create or replace function public.user_team_ids()
returns setof text language sql stable security definer set search_path = public as $$
  select t.team_id from public.teams t
  where public.is_platform_admin()
     or t.school_id in (select public.user_school_ids())
     or exists (
        select 1 from public.team_memberships m
        where m.user_id = public.app_user_id() and m.team_id = t.team_id and m.status = 'active'
     )
$$;

grant execute on function public.app_user_id() to authenticated;
grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.user_school_ids() to authenticated;
grant execute on function public.user_team_ids() to authenticated;
grant execute on function public.school_completion_rate(text,text,text) to authenticated;
grant execute on function public.build_evidence_filename(text,text,text,text,text,text,text) to authenticated;

-- 啟用 RLS
alter table public.organizations enable row level security;
alter table public.schools enable row level security;
alter table public.users enable row level security;
alter table public.user_roles enable row level security;
alter table public.team_memberships enable row level security;
alter table public.training_logs enable row level security;
alter table public.athlete_incidents enable row level security;
alter table public.injury_records enable row level security;
alter table public.competition_results enable row level security;
alter table public.athlete_guardians enable row level security;
alter table public.attendance_sessions enable row level security;
alter table public.attendance_records enable row level security;
alter table public.evaluation_templates enable row level security;
alter table public.evaluation_dimensions enable row level security;
alter table public.evaluation_items enable row level security;
alter table public.evaluation_requirements enable row level security;
alter table public.evaluation_evidence_rules enable row level security;
alter table public.evaluation_progress enable row level security;
alter table public.evaluation_tasks enable row level security;
alter table public.evidence_files enable row level security;
alter table public.subscriptions enable row level security;
alter table public.exports enable row level security;
alter table public.trial_requests enable row level security;
alter table public.onboarding_progress enable row level security;

-- 學校範圍表：可見自己有權限的學校
-- 直接查 user_roles（不經 user_school_ids，避免 schools 政策自我遞迴）
drop policy if exists schools_scope on public.schools;
create policy schools_scope on public.schools for select to authenticated
  using (
    public.is_platform_admin()
    or exists (
      select 1 from public.user_roles r
      where r.user_id = public.app_user_id() and r.status = 'active'
        and (r.school_id = schools.school_id
             or (r.organization_id = schools.organization_id and r.school_id is null))
    )
  );

drop policy if exists orgs_scope on public.organizations;
create policy orgs_scope on public.organizations for select to authenticated
  using (public.is_platform_admin()
    or organization_id in (select s.organization_id from public.schools s where s.school_id in (select public.user_school_ids())));

-- 使用者只看自己
drop policy if exists users_self on public.users;
create policy users_self on public.users for select to authenticated
  using (public.is_platform_admin() or auth_user_id = auth.uid());
drop policy if exists user_roles_self on public.user_roles;
create policy user_roles_self on public.user_roles for select to authenticated
  using (public.is_platform_admin() or user_id = public.app_user_id());

-- 隊伍範圍表（訓練/異常/傷病/成績/點名場次）：限負責隊伍
do $$
declare tbl text;
begin
  foreach tbl in array array[
    'training_logs','athlete_incidents','injury_records','competition_results','attendance_sessions'
  ] loop
    execute format('drop policy if exists %I_team_scope on public.%I', tbl, tbl);
    execute format(
      'create policy %I_team_scope on public.%I for all to authenticated
         using (public.is_platform_admin() or team_id in (select public.user_team_ids()))
         with check (public.is_platform_admin() or team_id in (select public.user_team_ids()))',
      tbl, tbl);
  end loop;
end $$;

-- 學校範圍表（評鑑進度/任務/佐證/匯出/導引）：限有權限的學校
do $$
declare tbl text;
begin
  foreach tbl in array array[
    'evaluation_progress','evaluation_tasks','evidence_files','exports','onboarding_progress'
  ] loop
    execute format('drop policy if exists %I_school_scope on public.%I', tbl, tbl);
    execute format(
      'create policy %I_school_scope on public.%I for all to authenticated
         using (public.is_platform_admin() or school_id in (select public.user_school_ids()))
         with check (public.is_platform_admin() or school_id in (select public.user_school_ids()))',
      tbl, tbl);
  end loop;
end $$;

-- 評鑑範本（org 內共用 + 平台）：讀取放寬給已認證者所屬 org，寫入限 platform/school_admin（由 Edge Function service-role 控管）
drop policy if exists eval_templates_read on public.evaluation_templates;
create policy eval_templates_read on public.evaluation_templates for select to authenticated
  using (public.is_platform_admin()
    or organization_id in (select s.organization_id from public.schools s where s.school_id in (select public.user_school_ids())));

-- 範本子表：跟隨 template 可讀
do $$
declare tbl text;
begin
  foreach tbl in array array[
    'evaluation_dimensions','evaluation_items','evaluation_requirements','evaluation_evidence_rules'
  ] loop
    execute format('drop policy if exists %I_read on public.%I', tbl, tbl);
    execute format(
      'create policy %I_read on public.%I for select to authenticated
         using (public.is_platform_admin() or template_id in (select template_id from public.evaluation_templates))',
      tbl, tbl);
  end loop;
end $$;

-- 訂閱：所屬 org 可讀
drop policy if exists subs_scope on public.subscriptions;
create policy subs_scope on public.subscriptions for select to authenticated
  using (public.is_platform_admin()
    or organization_id in (select s.organization_id from public.schools s where s.school_id in (select public.user_school_ids())));

-- 家長/選手內容授權（家長只看自己孩子被授權內容）
drop policy if exists guardians_scope on public.athlete_guardians;
create policy guardians_scope on public.athlete_guardians for select to authenticated
  using (public.is_platform_admin()
    or user_id = public.app_user_id()
    or athlete_id in (select a.athlete_id from public.athletes a where a.team_id in (select public.user_team_ids())));

-- 點名明細：跟隨場次
drop policy if exists attendance_records_scope on public.attendance_records;
create policy attendance_records_scope on public.attendance_records for all to authenticated
  using (public.is_platform_admin()
    or session_id in (select session_id from public.attendance_sessions where team_id in (select public.user_team_ids())))
  with check (public.is_platform_admin()
    or session_id in (select session_id from public.attendance_sessions where team_id in (select public.user_team_ids())));

-- trial_requests：僅 platform_admin 可讀（公開表單走 Edge Function service-role 寫入，無 anon policy）
drop policy if exists trial_requests_admin on public.trial_requests;
create policy trial_requests_admin on public.trial_requests for select to authenticated
  using (public.is_platform_admin());

-- ---------------------------------------------------------------------------
-- 11. 私有儲存桶：佐證檔案（走簽名網址，不公開）
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('evidence', 'evidence', false, 20971520,
        array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update set public = excluded.public,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ============================================================================
-- 完成。既有 001~005 資料不受影響；新表 organization_id/school_id 需由
-- 後續 backfill 腳本（把既有 coach → users/organization）填入。
-- ============================================================================
