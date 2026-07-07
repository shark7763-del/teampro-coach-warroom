// ============================================================================
// TeamPro 治理 Edge Function — 缺漏中心 / 佐證庫 / 評鑑完成率
// 契約與前端 gov.js 一致（camelCase 進出）。
// 授權橋接：以既有 coach token 認證；coach 需經 users.legacy_coach_id 對應到
// user_roles 具該 school 權限（或 platform_admin）。backfill 後即完整生效。
// 每個 handler 回傳結果物件；非本模組 action 回傳 null 讓 index.ts 繼續串接。
// ============================================================================
import { type Db, type Data, coachFromToken, uid, audit } from "./lib.ts";

const STATE_FACTOR: Record<string, number> = {
  completed: 1, pending_review: 0.7, returned: 0.5, in_progress: 0.3, overdue: 0, not_started: 0,
};
const TASK_STATES = ["not_started", "in_progress", "pending_review", "returned", "completed", "overdue"];
const REVIEW_STATES = ["not_checked", "insufficient", "need_more", "acceptable", "not_recommended", "confirmed"];
const GOV_ACTIONS = new Set([
  "govOverview", "govListTasks", "govCreateTask", "govUpdateTaskState",
  "govRemindTask", "govListEvidence", "govReviewEvidence",
  "govListTemplates", "govSaveTemplate", "govDeleteTemplate", "govSaveItem", "govDeleteItem",
  "govOnboarding", "govCompleteStep",
  "govSubmitTrial", "govListTrials", "govUpdateTrial",
  "govExportPackage", "govUsage",
]);
const ONBOARD_STEPS: [string, string][] = [
  ["create_school", "建立學校"], ["first_team", "建立第一支隊伍"], ["invite_coach", "邀請教練"],
  ["import_athletes", "匯入選手"], ["first_attendance", "完成第一次點名"], ["first_training", "完成第一次訓練紀錄"],
  ["first_evidence", "上傳第一份佐證"], ["view_gaps", "查看評鑑缺漏"], ["first_report", "產生第一份報告"],
];

interface GovCtx { userId: string | null; isAdmin: boolean; schoolIds: string[]; schoolId: string; coach: Data; }

async function govContext(db: Db, body: Data): Promise<GovCtx | { error: string }> {
  const coach = await coachFromToken(db, body.token);
  if (!coach) return { error: "unauthorized" };

  const { data: user } = await db.from("users").select("user_id")
    .eq("legacy_coach_id", coach.coach_id).maybeSingle();

  let isAdmin = false;
  const schoolIds: string[] = [];
  if (user) {
    const { data: roles } = await db.from("user_roles")
      .select("role, organization_id, school_id").eq("user_id", user.user_id).eq("status", "active");
    for (const r of roles || []) {
      if (r.role === "platform_admin") isAdmin = true;
      if (r.school_id) schoolIds.push(String(r.school_id));
      else if (r.organization_id) {
        const { data: schools } = await db.from("schools").select("school_id")
          .eq("organization_id", r.organization_id);
        for (const s of schools || []) schoolIds.push(String(s.school_id));
      }
    }
  }

  let schoolId = String(body.schoolId || "");
  if (!schoolId && schoolIds.length === 1) schoolId = schoolIds[0];
  if (!isAdmin && schoolId && !schoolIds.includes(schoolId)) return { error: "forbidden_school" };
  if (!isAdmin && !schoolId) return { error: "no_school_scope" };

  return { userId: user?.user_id || null, isAdmin, schoolIds, schoolId, coach };
}

function taskOut(row: Data): Data {
  const log = Array.isArray(row.reminder_log) ? row.reminder_log as Data[] : [];
  return {
    taskId: row.task_id, title: row.title, evaluationItemLabel: row.evaluation_item_label || "",
    teamName: row.team_name || "", assigneeName: row.assignee_name || "",
    dueDate: row.due_date || "", priority: row.priority, state: row.state,
    completionNote: row.completion_note || "",
    reminderCount: log.length, lastReminderAt: log.length ? log[log.length - 1].at : "",
  };
}
function evidenceOut(row: Data): Data {
  return {
    evidenceId: row.evidence_id, generatedFilename: row.generated_filename || row.original_filename || "",
    evidenceType: row.evidence_type || "", evaluationItemLabel: row.evaluation_item_label || "",
    teamName: row.team_name || "", athleteName: row.athlete_name || "",
    reviewStatus: row.review_status, reviewNote: row.review_note || "",
    validityStatus: row.validity_status || "unknown", uploadedAt: row.uploaded_at || "",
  };
}
function computeRate(tasks: Data[]): number {
  let tot = 0, got = 0;
  for (const t of tasks) {
    const w = 1;
    tot += w; got += w * (STATE_FACTOR[String(t.state)] ?? 0);
  }
  return tot ? Math.round((got / tot) * 1000) / 10 : 0;
}

// evaluation_tasks 沒有 team_name/assignee_name 欄位（用 team_id/assignee_user_id），
// 這裡用 join 視圖化：讀 team 名稱與 assignee 名稱。為求單檔可讀，逐筆補名稱。
async function decorateTasks(db: Db, rows: Data[]): Promise<Data[]> {
  const teamIds = [...new Set(rows.map((r) => r.team_id).filter(Boolean))] as string[];
  const userIds = [...new Set(rows.map((r) => r.assignee_user_id).filter(Boolean))] as string[];
  const teamMap = new Map<string, string>();
  const userMap = new Map<string, string>();
  if (teamIds.length) {
    const { data } = await db.from("teams").select("team_id, team_name").in("team_id", teamIds);
    for (const t of data || []) teamMap.set(String(t.team_id), String(t.team_name));
  }
  if (userIds.length) {
    const { data } = await db.from("users").select("user_id, name").in("user_id", userIds);
    for (const u of data || []) userMap.set(String(u.user_id), String(u.name));
  }
  return rows.map((r) => ({
    ...r,
    team_name: r.team_id ? teamMap.get(String(r.team_id)) || "" : "",
    assignee_name: r.assignee_user_id ? userMap.get(String(r.assignee_user_id)) || "" : "",
  }));
}

export async function governanceAction(db: Db, action: string, body: Data): Promise<Data | null> {
  if (!GOV_ACTIONS.has(action)) return null;

  // 公開動作：學校試用申請（無需登入；service-role 寫入 trial_requests）
  if (action === "govSubmitTrial") {
    const f = (body.form || {}) as Data;
    if (!f.schoolName || !f.contactEmail) return { ok: false, error: "缺少學校名稱或聯絡 Email" };
    const row: Data = {
      trial_request_id: uid("trq_"), school_name: String(f.schoolName), city: f.city || null,
      contact_name: f.contactName || null, contact_email: f.contactEmail || null,
      contact_phone: f.contactPhone || null, role: f.role || null,
      team_count: f.teamCount || null, message: f.message || null, status: "new",
    };
    const { data, error } = await db.from("trial_requests").insert(row).select("*").single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, trial: { trialRequestId: data.trial_request_id, schoolName: data.school_name, status: data.status } };
  }

  const ctx = await govContext(db, body);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const scopeSchools = ctx.isAdmin && !ctx.schoolId ? ctx.schoolIds : [ctx.schoolId];

  // 該 school 所屬 org（範本/使用量用）
  async function orgOfSchool(): Promise<string | null> {
    if (!ctx.schoolId) return null;
    const { data } = await db.from("schools").select("organization_id").eq("school_id", ctx.schoolId).maybeSingle();
    return data?.organization_id || null;
  }

  // ---- 總覽 ----
  if (action === "govOverview") {
    const { data: rawTasks } = await db.from("evaluation_tasks")
      .select("*").in("school_id", scopeSchools).is("deleted_at", null);
    const tasks = await decorateTasks(db, rawTasks || []);
    const { data: teams } = await db.from("teams").select("team_id, team_name").eq("school_id", ctx.schoolId);
    const teamRates = (teams || []).map((tm) => {
      const sub = tasks.filter((t) => t.team_id === tm.team_id);
      return {
        teamName: tm.team_name, rate: computeRate(sub), total: sub.length,
        done: sub.filter((t) => t.state === "completed").length,
      };
    });
    const highRisk = tasks.filter((t) => t.state === "overdue" || t.state === "returned").map(taskOut);
    const today = new Date().toISOString().slice(0, 10);
    const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const dueSoon = tasks.filter((t) =>
      t.state !== "completed" && t.due_date && t.due_date >= today && t.due_date <= in7).map(taskOut);
    const { data: pendingEv } = await db.from("evidence_files").select("*")
      .in("school_id", scopeSchools).in("review_status", ["not_checked", "need_more"]).is("deleted_at", null);
    const { data: recentEv } = await db.from("evidence_files").select("*")
      .in("school_id", scopeSchools).is("deleted_at", null).order("uploaded_at", { ascending: false }).limit(5);
    return {
      ok: true, completionRate: computeRate(tasks), teams: teamRates,
      highRiskGaps: highRisk, dueSoon,
      pendingReview: (pendingEv || []).map(evidenceOut),
      recentEvidence: (recentEv || []).map(evidenceOut),
    };
  }

  // ---- 缺漏清單 ----
  if (action === "govListTasks") {
    const f = (body.filter || {}) as Data;
    let q = db.from("evaluation_tasks").select("*").in("school_id", scopeSchools).is("deleted_at", null);
    if (f.state) q = q.eq("state", String(f.state));
    if (f.priority) q = q.eq("priority", String(f.priority));
    if (f.teamId) q = q.eq("team_id", String(f.teamId));
    const { data } = await q;
    const tasks = await decorateTasks(db, data || []);
    tasks.sort((a, b) =>
      TASK_STATES.indexOf(String(a.state)) - TASK_STATES.indexOf(String(b.state)));
    return { ok: true, tasks: tasks.map(taskOut) };
  }

  // ---- 新增缺漏 ----
  if (action === "govCreateTask") {
    const t = (body.task || {}) as Data;
    if (!t.title) return { ok: false, error: "缺少缺漏項目" };
    const row: Data = {
      task_id: uid("task_"), school_id: ctx.schoolId, organization_id: body.organizationId || null,
      title: String(t.title), evaluation_item_label: t.evaluationItemLabel || null,
      team_id: t.teamId || null, assignee_user_id: t.assigneeUserId || null,
      due_date: t.dueDate || null, priority: TASK_STATES.includes(String(t.priority)) ? t.priority : (t.priority || "normal"),
      state: "not_started", created_by: ctx.userId,
    };
    const { data, error } = await db.from("evaluation_tasks").insert(row).select("*").single();
    if (error) return { ok: false, error: error.message };
    await audit(db, ctx.coach, "gov_create_task", String(data.task_id));
    const [dec] = await decorateTasks(db, [data]);
    return { ok: true, task: taskOut(dec) };
  }

  // ---- 更新狀態（送審 / 通過 / 退回 / 完成 / 重開）----
  if (action === "govUpdateTaskState") {
    const taskId = String(body.taskId || "");
    const state = String(body.state || "");
    if (!TASK_STATES.includes(state)) return { ok: false, error: "unknown_state" };
    const patch: Data = { state, updated_at: new Date().toISOString() };
    if (body.note != null) patch.completion_note = String(body.note);
    const { data, error } = await db.from("evaluation_tasks").update(patch)
      .eq("task_id", taskId).in("school_id", scopeSchools).select("*").single();
    if (error) return { ok: false, error: error.message };
    // 同步評鑑進度（若 task 綁定 item）
    if (data.item_id) {
      await db.from("evaluation_progress").update({ state, updated_at: new Date().toISOString() })
        .eq("school_id", data.school_id).eq("item_id", data.item_id);
    }
    await audit(db, ctx.coach, "gov_task_state", taskId, state);
    const [dec] = await decorateTasks(db, [data]);
    return { ok: true, task: taskOut(dec) };
  }

  // ---- 催繳 ----
  if (action === "govRemindTask") {
    const taskId = String(body.taskId || "");
    const { data: cur } = await db.from("evaluation_tasks").select("*")
      .eq("task_id", taskId).in("school_id", scopeSchools).maybeSingle();
    if (!cur) return { ok: false, error: "找不到任務" };
    const log = Array.isArray(cur.reminder_log) ? cur.reminder_log as Data[] : [];
    log.push({ at: new Date().toISOString(), by: ctx.coach.name || "school", channel: String(body.channel || "line") });
    const patch: Data = { reminder_log: log };
    if (cur.state === "not_started") patch.state = "in_progress";
    const { data } = await db.from("evaluation_tasks").update(patch).eq("task_id", taskId).select("*").single();
    await audit(db, ctx.coach, "gov_task_remind", taskId);
    const [dec] = await decorateTasks(db, [data]);
    const reminderText = `提醒「${dec.assignee_name || "負責人"}」於 ${cur.due_date || "近期"} 前補齊：${cur.title}`;
    return { ok: true, task: taskOut(dec), reminderText };
  }

  // ---- 佐證清單 ----
  if (action === "govListEvidence") {
    const f = (body.filter || {}) as Data;
    let q = db.from("evidence_files").select("*").in("school_id", scopeSchools).is("deleted_at", null);
    if (f.reviewStatus) q = q.eq("review_status", String(f.reviewStatus));
    if (f.teamId) q = q.eq("team_id", String(f.teamId));
    const { data } = await q.order("uploaded_at", { ascending: false });
    return { ok: true, evidence: (data || []).map(evidenceOut) };
  }

  // ---- 佐證審核 ----
  if (action === "govReviewEvidence") {
    const evidenceId = String(body.evidenceId || "");
    const reviewStatus = String(body.reviewStatus || "");
    if (!REVIEW_STATES.includes(reviewStatus)) return { ok: false, error: "unknown_review_status" };
    const patch: Data = {
      review_status: reviewStatus, reviewed_by: ctx.userId, reviewed_at: new Date().toISOString(),
    };
    if (body.note != null) patch.review_note = String(body.note);
    if (reviewStatus === "confirmed" || reviewStatus === "acceptable") patch.validity_status = "valid";
    if (reviewStatus === "not_recommended") patch.validity_status = "invalid";
    const { data, error } = await db.from("evidence_files").update(patch)
      .eq("evidence_id", evidenceId).in("school_id", scopeSchools).select("*").single();
    if (error) return { ok: false, error: error.message };
    await audit(db, ctx.coach, "gov_review_evidence", evidenceId, reviewStatus);
    return { ok: true, evidence: evidenceOut(data) };
  }

  // ---- 評鑑範本 ----
  if (action === "govListTemplates") {
    const orgId = await orgOfSchool();
    const { data: tpls } = await db.from("evaluation_templates").select("*")
      .eq("organization_id", orgId).is("deleted_at", null);
    const out: Data[] = [];
    for (const t of tpls || []) {
      const { data: items } = await db.from("evaluation_items")
        .select("*, evaluation_dimensions(name)").eq("template_id", t.template_id).order("sort_order");
      const mapped = (items || []).map((i: Data) => ({
        itemId: i.item_id, dimension: (i.evaluation_dimensions as Data)?.name || "",
        name: i.name, weight: Number(i.weight) || 1, dueDate: i.due_date || "",
        responsibleRole: i.responsible_role || "", completionMode: i.completion_mode,
        requiresReview: !!i.requires_review, isRequired: !!i.is_required,
      }));
      out.push({
        templateId: t.template_id, name: t.name, academicYear: t.academic_year || "",
        city: t.city || "", schoolLevel: t.school_level || "", isActive: !!t.is_active,
        items: mapped, itemCount: mapped.length,
        totalWeight: mapped.reduce((s, i) => s + (i.weight as number), 0),
      });
    }
    return { ok: true, templates: out };
  }

  if (action === "govSaveTemplate") {
    const t = (body.template || {}) as Data;
    if (!t.name) return { ok: false, error: "缺少範本名稱" };
    if (t.templateId) {
      const { error } = await db.from("evaluation_templates").update({
        name: t.name, academic_year: t.academicYear || null, city: t.city || null,
        school_level: t.schoolLevel || null, is_active: t.isActive !== false, updated_at: new Date().toISOString(),
      }).eq("template_id", String(t.templateId));
      if (error) return { ok: false, error: error.message };
      return { ok: true, template: { templateId: t.templateId } };
    }
    const row: Data = {
      template_id: uid("et_"), organization_id: await orgOfSchool(), name: t.name,
      academic_year: t.academicYear || null, city: t.city || null, school_level: t.schoolLevel || null,
      is_active: true, created_by: ctx.userId,
    };
    const { data, error } = await db.from("evaluation_templates").insert(row).select("*").single();
    if (error) return { ok: false, error: error.message };
    await audit(db, ctx.coach, "gov_save_template", String(data.template_id));
    return { ok: true, template: { templateId: data.template_id } };
  }

  if (action === "govDeleteTemplate") {
    const { error } = await db.from("evaluation_templates").update({ deleted_at: new Date().toISOString() })
      .eq("template_id", String(body.templateId));
    if (error) return { ok: false, error: error.message };
    await audit(db, ctx.coach, "gov_delete_template", String(body.templateId));
    return { ok: true };
  }

  if (action === "govSaveItem") {
    const templateId = String(body.templateId || "");
    const it = (body.item || {}) as Data;
    if (!it.name) return { ok: false, error: "缺少指標名稱" };
    // 找/建 dimension（以名稱）
    let dimensionId: string | null = null;
    if (it.dimension) {
      const { data: dim } = await db.from("evaluation_dimensions").select("dimension_id")
        .eq("template_id", templateId).eq("name", String(it.dimension)).maybeSingle();
      if (dim) dimensionId = dim.dimension_id;
      else {
        const { data: newDim } = await db.from("evaluation_dimensions")
          .insert({ dimension_id: uid("ed_"), template_id: templateId, name: String(it.dimension) })
          .select("dimension_id").single();
        dimensionId = newDim?.dimension_id || null;
      }
    }
    const patch: Data = {
      template_id: templateId, dimension_id: dimensionId, name: it.name,
      weight: Number(it.weight) || 1, due_date: it.dueDate || null,
      responsible_role: it.responsibleRole || null, completion_mode: it.completionMode || "evidence",
      requires_review: !!it.requiresReview, is_required: it.isRequired !== false,
    };
    if (it.itemId) {
      const { error } = await db.from("evaluation_items").update(patch).eq("item_id", String(it.itemId));
      if (error) return { ok: false, error: error.message };
      return { ok: true, item: { itemId: it.itemId } };
    }
    patch.item_id = uid("ei_");
    const { data, error } = await db.from("evaluation_items").insert(patch).select("item_id").single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, item: { itemId: data.item_id } };
  }

  if (action === "govDeleteItem") {
    const { error } = await db.from("evaluation_items").delete().eq("item_id", String(body.itemId));
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  // ---- 新手導引 ----
  if (action === "govOnboarding") {
    if (!ctx.schoolId) return { ok: false, error: "no_school_scope" };
    const { data: rows } = await db.from("onboarding_progress").select("*").eq("school_id", ctx.schoolId);
    const map = new Map((rows || []).map((r) => [r.step_key, r]));
    const steps = ONBOARD_STEPS.map(([key, label]) => ({
      stepKey: key, label, done: !!map.get(key)?.done, doneAt: map.get(key)?.done_at || "",
    }));
    const done = steps.filter((s) => s.done).length;
    return { ok: true, steps, done, total: steps.length, percent: Math.round((done / steps.length) * 100) };
  }

  if (action === "govCompleteStep") {
    if (!ctx.schoolId) return { ok: false, error: "no_school_scope" };
    const stepKey = String(body.stepKey || "");
    await db.from("onboarding_progress").upsert({
      onboarding_id: uid("ob_"), school_id: ctx.schoolId, step_key: stepKey,
      done: true, done_at: new Date().toISOString(),
    }, { onConflict: "school_id,step_key" });
    return governanceAction(db, "govOnboarding", body) as Promise<Data>;
  }

  // ---- 試用申請（platform_admin）----
  if (action === "govListTrials") {
    if (!ctx.isAdmin) return { ok: false, error: "forbidden" };
    const { data } = await db.from("trial_requests").select("*").order("created_at", { ascending: false });
    return {
      ok: true, trials: (data || []).map((t) => ({
        trialRequestId: t.trial_request_id, schoolName: t.school_name, city: t.city || "",
        contactName: t.contact_name || "", contactEmail: t.contact_email || "", role: t.role || "",
        teamCount: t.team_count || "", status: t.status, createdAt: t.created_at,
      })),
    };
  }
  if (action === "govUpdateTrial") {
    if (!ctx.isAdmin) return { ok: false, error: "forbidden" };
    const patch: Data = { status: String(body.status || "new") };
    if (String(body.status) !== "new") patch.handled_at = new Date().toISOString();
    const { data, error } = await db.from("trial_requests").update(patch)
      .eq("trial_request_id", String(body.trialRequestId)).select("*").single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, trial: { trialRequestId: data.trial_request_id, status: data.status } };
  }

  // ---- 官方填報前資料包 ----
  if (action === "govExportPackage") {
    const { data: rawTasks } = await db.from("evaluation_tasks").select("*")
      .in("school_id", scopeSchools).is("deleted_at", null);
    const tasks = await decorateTasks(db, rawTasks || []);
    const { data: school } = await db.from("schools").select("name, academic_year").eq("school_id", ctx.schoolId).maybeSingle();
    const { data: teams } = await db.from("teams").select("team_id, team_name").eq("school_id", ctx.schoolId);
    const teamRates = (teams || []).map((tm) => {
      const sub = tasks.filter((t) => t.team_id === tm.team_id);
      return { teamName: tm.team_name, rate: computeRate(sub), total: sub.length, done: sub.filter((t) => t.state === "completed").length };
    });
    const { data: usable } = await db.from("evidence_files").select("*")
      .in("school_id", scopeSchools).in("review_status", ["confirmed", "acceptable"]).is("deleted_at", null);
    const pending = tasks.filter((t) => t.state !== "completed").map(taskOut);
    await audit(db, ctx.coach, "gov_export_package", ctx.schoolId);
    return {
      ok: true, schoolName: school?.name || "", academicYear: school?.academic_year || "",
      completionRate: computeRate(tasks), teams: teamRates,
      usableEvidence: (usable || []).map(evidenceOut), pendingItems: pending,
      generatedAt: new Date().toISOString(),
    };
  }

  // ---- 平台使用量 / 續約（platform_admin）----
  if (action === "govUsage") {
    if (!ctx.isAdmin) return { ok: false, error: "forbidden" };
    const { data: orgs } = await db.from("organizations").select("*").is("deleted_at", null);
    const { data: subs } = await db.from("subscriptions").select("*");
    const subMap = new Map((subs || []).map((s) => [s.organization_id, s]));
    const today = new Date().toISOString().slice(0, 10);
    const in14 = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    const list = (orgs || []).map((o) => {
      const s = subMap.get(o.organization_id) as Data | undefined;
      return {
        organizationId: o.organization_id, name: o.name, plan: o.plan, status: o.status,
        expiresAt: s?.expires_at || "", teamCount: 0, coachCount: 0, activity: 0,
      };
    });
    const expiringSoon = list.filter((o) => o.expiresAt && o.expiresAt >= today && o.expiresAt <= in14);
    return {
      ok: true, orgs: list, totalOrgs: list.length,
      activeOrgs: list.filter((o) => o.status === "active").length,
      trialOrgs: list.filter((o) => o.plan === "trial").length, expiringSoon,
    };
  }

  return null;
}
