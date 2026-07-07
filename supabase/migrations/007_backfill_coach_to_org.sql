-- ============================================================================
-- TeamPro 007 — backfill：既有 coach 世界 → 多租戶治理世界
-- 為每位既有 coach 建立 organization + school + user(+school_admin/coach 角色)，
-- 並回填 teams/athletes/daily_records/attendance/competitions 的 organization_id
-- 與 school_id、建立 team_memberships、依 plan 建 subscription。
--
-- 特性：
--   * 冪等：以 users.legacy_coach_id 是否存在為守衛，可重複執行不重建。
--   * 授權橋接：006 的 governance Edge Function 靠 users.legacy_coach_id 找 coach，
--     本腳本跑完後既有 coach 即以 school_admin 身分能用缺漏中心/佐證庫。
--   * 回滾：007_backfill_coach_to_org_down.sql
--
-- 前置：需先套用 006_multitenant_governance.sql。
-- ============================================================================

do $$
declare
  c record;
  v_org text;
  v_school text;
  v_user text;
  v_org_name text;
  v_org_plan text;
begin
  for c in select * from public.coaches loop
    -- 已 backfill 過 → 跳過（冪等）
    if exists (select 1 from public.users where legacy_coach_id = c.coach_id) then
      continue;
    end if;

    v_org_name := coalesce(nullif(trim(c.settings->>'school'), ''), c.name || ' 團隊');
    v_org_plan := case c.plan
                    when 'team' then 'school'
                    when 'pro'  then 'government'
                    when 'coach' then 'coach'
                    else 'trial' end;

    -- organization
    v_org := 'org_' || replace(gen_random_uuid()::text, '-', '');
    insert into public.organizations(organization_id, name, org_type, plan, status, is_demo, created_by)
      values (v_org, v_org_name, 'school', v_org_plan,
              case when c.status = 'disabled' then 'disabled' else 'active' end,
              false, c.coach_id);

    -- school（solo coach → 單一預設學校）
    v_school := 'sch_' || replace(gen_random_uuid()::text, '-', '');
    insert into public.schools(school_id, organization_id, name, academic_year, is_demo, created_by)
      values (v_school, v_org, v_org_name, '114', false, c.coach_id);

    -- user（對應既有 coach）
    v_user := 'u_' || replace(gen_random_uuid()::text, '-', '');
    insert into public.users(user_id, auth_user_id, legacy_coach_id, email, name, status)
      values (v_user, c.auth_user_id, c.coach_id, c.email, c.name,
              case when c.status = 'disabled' then 'disabled' else 'active' end);

    -- 角色：同時給 school_admin（能用治理後台）與 coach（教練端）
    insert into public.user_roles(user_id, role, organization_id, school_id) values
      (v_user, 'school_admin', v_org, v_school),
      (v_user, 'coach',        v_org, v_school);

    -- 回填 teams
    update public.teams
      set organization_id = v_org, school_id = v_school,
          created_by = coalesce(created_by, c.coach_id)
      where coach_id = c.coach_id;

    -- team_memberships（教練 ↔ 其隊伍）
    insert into public.team_memberships(user_id, team_id, role)
      select v_user, t.team_id, 'coach'
      from public.teams t
      where t.coach_id = c.coach_id
        and not exists (
          select 1 from public.team_memberships m
          where m.user_id = v_user and m.team_id = t.team_id);

    -- 回填 athletes / daily_records / attendance / competitions
    update public.athletes
      set organization_id = v_org, school_id = v_school,
          created_by = coalesce(created_by, c.coach_id)
      where coach_id = c.coach_id;
    update public.daily_records set organization_id = v_org, school_id = v_school where coach_id = c.coach_id;
    update public.attendance    set organization_id = v_org, school_id = v_school where coach_id = c.coach_id;
    update public.competitions  set organization_id = v_org, school_id = v_school where coach_id = c.coach_id;

    -- subscription（依 coach.plan / plan_expiry）
    insert into public.subscriptions(organization_id, plan, status, started_at, expires_at, payment_note)
      values (v_org, v_org_plan,
              case
                when c.plan = 'free' then 'trial'
                when c.plan_expiry is not null and c.plan_expiry < current_date then 'expired'
                else 'active' end,
              c.created_at::date, c.plan_expiry, c.payment_note);
  end loop;
end $$;

-- ============================================================================
-- 驗證查詢（手動執行，非遷移一部分）：
--   -- 每位 coach 都應有對應 user：
--   select count(*) as coaches, (select count(*) from public.users where legacy_coach_id is not null) as backfilled_users
--   from public.coaches;
--   -- 仍未歸戶的 team（應為 0）：
--   select count(*) from public.teams where school_id is null;
--   -- 某 coach 的完整鏈：
--   select o.name org, s.name school, u.email, array_agg(r.role) roles
--   from public.users u
--   join public.user_roles r on r.user_id = u.user_id
--   join public.organizations o on o.organization_id = r.organization_id
--   join public.schools s on s.school_id = r.school_id
--   group by 1,2,3 limit 5;
-- ============================================================================
