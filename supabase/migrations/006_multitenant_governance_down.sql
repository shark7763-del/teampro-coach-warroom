-- ============================================================================
-- TeamPro 006 回滾（rollback）
-- 還原 006_multitenant_governance.sql：移除新表、函式、政策與新增欄位。
-- 注意：這會刪除 006 建立的所有租戶/評鑑/佐證資料。執行前請先備份。
--   建議：supabase db dump 或 pg_dump 後再跑此腳本。
-- 既有 001~005 的表（coaches/teams/athletes/daily_records...）保留，只移除
-- 006 對它們新增的欄位。
-- ============================================================================

begin;

-- 1. 移除新表（相依順序：子表先）
drop table if exists public.onboarding_progress cascade;
drop table if exists public.trial_requests cascade;
drop table if exists public.exports cascade;
drop table if exists public.subscriptions cascade;
drop table if exists public.evidence_files cascade;
drop table if exists public.evaluation_tasks cascade;
drop table if exists public.evaluation_progress cascade;
drop table if exists public.evaluation_evidence_rules cascade;
drop table if exists public.evaluation_requirements cascade;
drop table if exists public.evaluation_items cascade;
drop table if exists public.evaluation_dimensions cascade;
drop table if exists public.evaluation_templates cascade;
drop table if exists public.attendance_records cascade;
drop table if exists public.attendance_sessions cascade;
drop table if exists public.athlete_guardians cascade;
drop table if exists public.competition_results cascade;
drop table if exists public.injury_records cascade;
drop table if exists public.athlete_incidents cascade;
drop table if exists public.training_logs cascade;
drop table if exists public.team_memberships cascade;
drop table if exists public.user_roles cascade;
drop table if exists public.users cascade;
drop table if exists public.schools cascade;
drop table if exists public.organizations cascade;

-- 2. 移除函式
drop function if exists public.school_completion_rate(text, text, text);
drop function if exists public.state_completion_factor(text);
drop function if exists public.build_evidence_filename(text, text, text, text, text, text, text);
drop function if exists public.user_team_ids();
drop function if exists public.user_school_ids();
drop function if exists public.is_platform_admin();
drop function if exists public.app_user_id();

-- 3. 移除對既有表新增的欄位
alter table public.teams        drop column if exists organization_id;
alter table public.teams        drop column if exists school_id;
alter table public.teams        drop column if exists academic_year;
alter table public.teams        drop column if exists created_by;
alter table public.teams        drop column if exists deleted_at;

alter table public.athletes     drop column if exists organization_id;
alter table public.athletes     drop column if exists school_id;
alter table public.athletes     drop column if exists created_by;
alter table public.athletes     drop column if exists status;
alter table public.athletes     drop column if exists deleted_at;

alter table public.daily_records drop column if exists organization_id;
alter table public.daily_records drop column if exists school_id;
alter table public.daily_records drop column if exists created_by;
alter table public.daily_records drop column if exists deleted_at;

alter table public.attendance   drop column if exists organization_id;
alter table public.attendance   drop column if exists school_id;
alter table public.attendance   drop column if exists created_by;
alter table public.attendance   drop column if exists deleted_at;

alter table public.competitions drop column if exists organization_id;
alter table public.competitions drop column if exists school_id;
alter table public.competitions drop column if exists created_by;
alter table public.competitions drop column if exists deleted_at;

alter table public.audit_logs   drop column if exists organization_id;
alter table public.audit_logs   drop column if exists school_id;
alter table public.audit_logs   drop column if exists user_id;

-- 4. 移除私有儲存桶（若無檔案）
delete from storage.buckets where id = 'evidence';

commit;
