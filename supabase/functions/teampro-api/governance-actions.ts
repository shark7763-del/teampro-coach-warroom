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
const TASK_ACTIONS = new Set([
  "govOverview", "govListTasks", "govCreateTask", "govUpdateTaskState",
  "govRemindTask", "govListEvidence", "govReviewEvidence",
]);

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
  if (!TASK_ACTIONS.has(action)) return null;

  const ctx = await govContext(db, body);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const scopeSchools = ctx.isAdmin && !ctx.schoolId ? ctx.schoolIds : [ctx.schoolId];

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

  return null;
}
