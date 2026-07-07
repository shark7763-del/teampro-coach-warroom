-- ============================================================================
-- TeamPro 007 backfill 回滾
-- 移除 007 建立的 backfill 資料，並清空既有表被回填的 organization_id/school_id。
-- 僅刪除「由 backfill 產生」的 org/school/user（以 users.legacy_coach_id 與
-- created_by = coach_id 辨識），不影響手動建立的租戶。
-- 執行前請先備份（supabase db dump）。
-- ============================================================================

begin;

-- 1. 清空既有表被回填的租戶欄位（只清由 backfill 寫入的 coach 隸屬資料）
update public.teams        set organization_id = null, school_id = null
  where coach_id in (select coach_id from public.coaches);
update public.athletes     set organization_id = null, school_id = null
  where coach_id in (select coach_id from public.coaches);
update public.daily_records set organization_id = null, school_id = null
  where coach_id in (select coach_id from public.coaches);
update public.attendance   set organization_id = null, school_id = null
  where coach_id in (select coach_id from public.coaches);
update public.competitions set organization_id = null, school_id = null
  where coach_id in (select coach_id from public.coaches);

-- 2. 刪除 backfill 的 subscription（org 由 coach backfill 建立者）
delete from public.subscriptions s
  using public.organizations o
  where s.organization_id = o.organization_id
    and o.created_by in (select coach_id from public.coaches);

-- 3. 刪除 backfill 的 users（cascade 移除 user_roles / team_memberships）
delete from public.users where legacy_coach_id is not null;

-- 4. 刪除 backfill 的 schools 與 organizations（created_by = coach_id）
delete from public.schools      where created_by in (select coach_id from public.coaches);
delete from public.organizations where created_by in (select coach_id from public.coaches);

commit;

-- 註：若 backfill 之後又在這些 org/school 下新增了正式治理資料
--     （evaluation_tasks / evidence_files 等），cascade 會一併刪除，
--     故回滾前務必確認尚未於 backfill 租戶內建立正式資料。
