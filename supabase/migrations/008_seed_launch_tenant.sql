-- ============================================================================
-- TeamPro 008 — 開辦：種一個可登入的「示範學校」真實租戶
-- 讓治理平台在 Supabase 上有一個完整、可登入、可操作的營運租戶：
--   組織→學校→教練帳號(可登入)→user/角色→隊伍→選手→評鑑範本→缺漏→佐證
-- 登入帳號：demo@teampro.tw / TeamPro2026（legacy 5000 輪雜湊，與 Edge login 相容）
-- 全部標示 is_demo，學生用虛構代號（不含真實個資）。
-- 冪等：以 organization_id='org_demo_launch' 是否存在為守衛。
-- ============================================================================

do $$
begin
  if exists (select 1 from public.organizations where organization_id = 'org_demo_launch') then
    return;
  end if;

  -- 組織 + 學校
  insert into public.organizations(organization_id, name, org_type, city, plan, status, is_demo, created_by)
    values ('org_demo_launch', 'TeamPro 示範學校', 'school', '新北市', 'school', 'active', true, 'coach_demo_launch');
  insert into public.schools(school_id, organization_id, name, city, school_level, academic_year, is_demo, status, created_by)
    values ('sch_demo_launch', 'org_demo_launch', 'TeamPro 示範學校', '新北市', 'junior_high', '114', true, 'active', 'coach_demo_launch');

  -- 教練帳號（可登入；legacy 雜湊 = sha256 5000 輪，salt::pw）
  insert into public.coaches(coach_id, email, name, plan, status, legacy_password_hash, legacy_password_salt, settings, last_login_at)
    values ('coach_demo_launch', 'demo@teampro.tw', '示範教練', 'team', 'active',
            'db4d2c1cdfcbfdc6d38e6ec0d8113a55535881c740b4d2919b71a96bc9dc094c', 'launch2026salt',
            '{"school":"TeamPro 示範學校"}'::jsonb, now());

  -- 身分 user + 角色（school_admin 才能用治理後台，另給 coach）
  insert into public.users(user_id, legacy_coach_id, email, name, status)
    values ('u_demo_launch', 'coach_demo_launch', 'demo@teampro.tw', '示範教練', 'active');
  insert into public.user_roles(user_role_id, user_id, role, organization_id, school_id) values
    ('ur_demo_admin', 'u_demo_launch', 'school_admin', 'org_demo_launch', 'sch_demo_launch'),
    ('ur_demo_coach', 'u_demo_launch', 'coach',        'org_demo_launch', 'sch_demo_launch');

  -- 隊伍 + 指派 + 選手（虛構代號）
  insert into public.teams(team_id, coach_id, team_name, sport, status, organization_id, school_id, academic_year, created_by)
    values ('team_demo_launch', 'coach_demo_launch', '跆拳道隊', '跆拳道', 'active', 'org_demo_launch', 'sch_demo_launch', '114', 'coach_demo_launch');
  insert into public.team_memberships(membership_id, user_id, team_id, role)
    values ('tm_demo_launch', 'u_demo_launch', 'team_demo_launch', 'coach');
  insert into public.athletes(athlete_id, coach_id, team_id, name, grade_class, active, organization_id, school_id, created_by) values
    ('a_demo_1', 'coach_demo_launch', 'team_demo_launch', '示範選手 A', '八年一班', true, 'org_demo_launch', 'sch_demo_launch', 'coach_demo_launch'),
    ('a_demo_2', 'coach_demo_launch', 'team_demo_launch', '示範選手 B', '八年二班', true, 'org_demo_launch', 'sch_demo_launch', 'coach_demo_launch'),
    ('a_demo_3', 'coach_demo_launch', 'team_demo_launch', '示範選手 C', '九年一班', true, 'org_demo_launch', 'sch_demo_launch', 'coach_demo_launch');

  -- 評鑑範本 + 面向 + 指標
  insert into public.evaluation_templates(template_id, organization_id, name, academic_year, city, school_level, is_active, is_demo, created_by)
    values ('et_demo_launch', 'org_demo_launch', '114 學年度 國中體育班評鑑', '114', '新北市', 'junior_high', true, true, 'coach_demo_launch');
  insert into public.evaluation_dimensions(dimension_id, template_id, name, sort_order, weight) values
    ('ed_base', 'et_demo_launch', '基礎資料', 1, 1),
    ('ed_ops',  'et_demo_launch', '運作情形', 2, 1),
    ('ed_perf', 'et_demo_launch', '訓練績效', 3, 1);
  insert into public.evaluation_items(item_id, template_id, dimension_id, name, weight, responsible_role, completion_mode, requires_review, sort_order, is_required) values
    ('ei_roster',   'et_demo_launch', 'ed_base', '學生名冊完整度',        2, 'school_admin', 'fields',   true,  1, true),
    ('ei_attend',   'et_demo_launch', 'ed_base', '出席與公假統計',        1, 'coach',        'fields',   false, 2, true),
    ('ei_log',      'et_demo_launch', 'ed_ops',  '訓練日誌',              2, 'coach',        'evidence', false, 3, true),
    ('ei_care',     'et_demo_launch', 'ed_ops',  '學生輔導與家長聯繫紀錄', 1, 'coach',        'evidence', true,  4, true),
    ('ei_award',    'et_demo_launch', 'ed_perf', '競賽成果與獎狀',        3, 'coach',        'evidence', true,  5, true),
    ('ei_graduate', 'et_demo_launch', 'ed_perf', '畢業銜續訓練統計',      1, 'director',     'fields',   true,  6, true);

  -- 評鑑進度（完成率來源）
  insert into public.evaluation_progress(progress_id, organization_id, school_id, template_id, item_id, academic_year, state) values
    ('ep_1','org_demo_launch','sch_demo_launch','et_demo_launch','ei_attend','114','completed'),
    ('ep_2','org_demo_launch','sch_demo_launch','et_demo_launch','ei_roster','114','in_progress'),
    ('ep_3','org_demo_launch','sch_demo_launch','et_demo_launch','ei_log','114','returned'),
    ('ep_4','org_demo_launch','sch_demo_launch','et_demo_launch','ei_award','114','overdue'),
    ('ep_5','org_demo_launch','sch_demo_launch','et_demo_launch','ei_graduate','114','pending_review'),
    ('ep_6','org_demo_launch','sch_demo_launch','et_demo_launch','ei_care','114','not_started');

  -- 缺漏中心 tasks（涵蓋各狀態）
  insert into public.evaluation_tasks(task_id, organization_id, school_id, template_id, item_id, team_id, title, evaluation_item_label, assignee_user_id, due_date, priority, state, completion_note) values
    ('task_d1','org_demo_launch','sch_demo_launch','et_demo_launch','ei_award','team_demo_launch','縣市賽獎狀照片未上傳','訓練績效 / 競賽成果','u_demo_launch', current_date - 2, 'urgent','overdue', ''),
    ('task_d2','org_demo_launch','sch_demo_launch','et_demo_launch','ei_log','team_demo_launch','6 月訓練日誌缺 3 天','運作情形 / 訓練日誌','u_demo_launch', current_date + 3, 'high','returned','請補齊 6/12、6/18、6/25'),
    ('task_d3','org_demo_launch','sch_demo_launch','et_demo_launch','ei_care','team_demo_launch','傷病追蹤缺家長通知紀錄','運作情形 / 學生輔導','u_demo_launch', current_date + 5, 'high','not_started',''),
    ('task_d4','org_demo_launch','sch_demo_launch','et_demo_launch','ei_roster','team_demo_launch','學生基本資料 1 人缺身分證號','基礎資料 / 學生名冊','u_demo_launch', current_date + 7, 'normal','in_progress',''),
    ('task_d5','org_demo_launch','sch_demo_launch','et_demo_launch','ei_graduate','team_demo_launch','畢業銜續訓練統計待審核','訓練績效 / 銜續統計','u_demo_launch', current_date + 4, 'normal','pending_review',''),
    ('task_d6','org_demo_launch','sch_demo_launch','et_demo_launch','ei_attend','team_demo_launch','公假出席統計已彙整完成','基礎資料 / 出席統計','u_demo_launch', current_date - 5, 'normal','completed','已完成並確認');

  -- 佐證庫
  insert into public.evidence_files(evidence_id, organization_id, school_id, team_id, academic_year, athlete_id, evaluation_item_id, task_id, evidence_type, generated_filename, uploaded_by, review_status, validity_status) values
    ('ev_d1','org_demo_launch','sch_demo_launch','team_demo_launch','114','a_demo_1','ei_award','task_d1','比賽獎狀','114_TeamPro示範學校_跆拳道隊_示範選手A_全國中等學校運動會_男子52kg_第1名','u_demo_launch','confirmed','valid'),
    ('ev_d2','org_demo_launch','sch_demo_launch','team_demo_launch','114',null,'ei_log','task_d2','訓練日誌','114_TeamPro示範學校_跆拳道隊_訓練日誌_6月','u_demo_launch','need_more','unknown'),
    ('ev_d3','org_demo_launch','sch_demo_launch','team_demo_launch','114','a_demo_2','ei_award',null,'秩序冊','114_TeamPro示範學校_跆拳道隊_邀請賽_秩序冊','u_demo_launch','not_recommended','invalid');

  -- 訂閱（年度授權）
  insert into public.subscriptions(subscription_id, organization_id, plan, status, started_at, expires_at, max_teams, max_coaches, storage_mb, export_quota)
    values ('sub_demo_launch', 'org_demo_launch', 'school', 'active', current_date, current_date + 300, 20, 15, 5000, 500);

  -- 新手導引（部分完成）
  insert into public.onboarding_progress(onboarding_id, school_id, step_key, done, done_at) values
    ('ob_1','sch_demo_launch','create_school',true, now()),
    ('ob_2','sch_demo_launch','first_team',true, now()),
    ('ob_3','sch_demo_launch','invite_coach',true, now()),
    ('ob_4','sch_demo_launch','import_athletes',true, now()),
    ('ob_5','sch_demo_launch','first_attendance',true, now());
end $$;
