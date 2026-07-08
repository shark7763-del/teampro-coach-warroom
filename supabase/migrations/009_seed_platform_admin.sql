-- ============================================================================
-- TeamPro 009 — 種平台管理員帳號（platform_admin）
-- 可登入、可看跨租戶：試用申請 / 使用量與續約 / 所有組織。
-- 登入：admin@teampro.tw / TeamProAdmin2026（legacy 5000 輪雜湊）
-- platform_admin 角色 organization_id/school_id 皆 NULL＝跨租戶。
-- 冪等：以 coach_id='coach_platform_admin' 是否存在為守衛。
-- ============================================================================

do $$
begin
  if exists (select 1 from public.coaches where coach_id = 'coach_platform_admin') then
    return;
  end if;

  insert into public.coaches(coach_id, email, name, plan, status, legacy_password_hash, legacy_password_salt, last_login_at)
    values ('coach_platform_admin', 'admin@teampro.tw', 'TeamPro 平台管理員', 'pro', 'active',
            '4c233f03fe407bd31a1330603d8afb47f8358f06abc439e7878b780807b31776', 'admin2026salt', now());

  insert into public.users(user_id, legacy_coach_id, email, name, status)
    values ('u_platform_admin', 'coach_platform_admin', 'admin@teampro.tw', 'TeamPro 平台管理員', 'active');

  -- platform_admin：org/school 皆 NULL＝跨所有租戶
  insert into public.user_roles(user_role_id, user_id, role, organization_id, school_id)
    values ('ur_platform_admin', 'u_platform_admin', 'platform_admin', null, null);
end $$;
