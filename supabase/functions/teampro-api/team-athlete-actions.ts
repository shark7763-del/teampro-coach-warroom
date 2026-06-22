import { requireCoach, planConfig } from "./coach-actions.ts";
import { addDays, athleteOut, audit, normalizeVisibility, teamOut, today, uid, weekStart, type Data, type Db } from "./lib.ts";

async function coachRows(db: Db, coachId: unknown): Promise<Record<string, unknown>[]> {
  const { data } = await db.from("athletes").select("*").eq("coach_id", coachId);
  return data || [];
}

function effectiveKpiIds(rows: Record<string, unknown>[], limit: number): Set<string> {
  return new Set(rows.filter((a) => a.active && a.kpi_enabled).sort((a, b) => String(a.kpi_enabled_at || a.created_at).localeCompare(String(b.kpi_enabled_at || b.created_at))).slice(0, limit).map((a) => String(a.athlete_id)));
}

export async function teamAthleteAction(db: Db, action: string, d: Data): Promise<Data | null> {
  const supported = ["listTeams", "createTeam", "resetShareToken", "deleteTeam", "listAthletes", "addAthlete", "setAthleteActive", "updateAthlete", "setKpiTracking", "setKpiTrackingBulk", "deleteAthlete"];
  if (!supported.includes(action)) return null;
  const auth = await requireCoach(db, d);
  if ("error" in auth) return auth.error;
  const coach = auth.coach;
  const cfg = planConfig(coach);

  if (action === "listTeams") {
    const { data } = await db.from("teams").select("*").eq("coach_id", coach.coach_id).order("created_at");
    return { ok: true, teams: (data || []).map(teamOut) };
  }
  if (action === "createTeam") {
    const teamName = String(d.teamName || "").trim();
    if (!teamName) return { ok: false, error: "請輸入團隊名稱" };
    const { data: teams } = await db.from("teams").select("team_id,team_name,status").eq("coach_id", coach.coach_id);
    const activeCount = (teams || []).filter((t) => t.status !== "disabled").length;
    if (activeCount >= Number(cfg.maxTeams)) return { ok: false, error: "multi_team_locked", message: `目前方案最多可建立 ${cfg.maxTeams} 個隊伍，升級後可管理更多隊伍。` };
    if ((teams || []).some((t) => String(t.team_name).trim() === teamName)) return { ok: false, error: `已有同名團隊「${teamName}」，請換個名稱` };
    const row = { team_id: uid("tm_"), coach_id: coach.coach_id, team_name: teamName, sport: String(d.sport || "跆拳道"), share_token: uid("sh_"), status: "active", competition_system: String(d.competitionSystem || ""), sport_category: String(d.sportCategory || ""), member_term: String(d.memberTerm || "選手") };
    const { data: team, error } = await db.from("teams").insert(row).select("*").single();
    if (error) return { ok: false, error: "建立團隊失敗" };
    await audit(db, coach, "createTeam", row.team_id, teamName);
    return { ok: true, team: teamOut(team) };
  }
  if (action === "resetShareToken") {
    const shareToken = uid("sh_");
    const { data, error } = await db.from("teams").update({ share_token: shareToken, updated_at: new Date().toISOString() }).eq("team_id", d.teamId).eq("coach_id", coach.coach_id).select("team_id").maybeSingle();
    return !data || error ? { ok: false, error: "找不到團隊或無權限" } : { ok: true, shareToken };
  }
  if (action === "deleteTeam") {
    const { data, error } = await db.from("teams").delete().eq("team_id", d.teamId).eq("coach_id", coach.coach_id).select("team_id").maybeSingle();
    return !data || error ? { ok: false, error: "找不到團隊或無權限" } : { ok: true };
  }

  const rows = await coachRows(db, coach.coach_id);
  if (action === "listAthletes") {
    const reviewWeek = addDays(weekStart(today()), -7);
    const limit = Number(cfg.kpiAthletes);
    const effective = effectiveKpiIds(rows, limit);
    const { data: completedRows } = await db.from("weekly_kpi").select("athlete_id").eq("coach_id", coach.coach_id).eq("week_start", reviewWeek);
    const completed = new Set((completedRows || []).map((x) => String(x.athlete_id)));
    const filtered = rows.filter((a) => !d.teamId || a.team_id === d.teamId).map((a) => ({ ...athleteOut(a), kpiEffective: effective.has(String(a.athlete_id)), kpiWeekStatus: !a.kpi_enabled ? "disabled" : effective.has(String(a.athlete_id)) ? completed.has(String(a.athlete_id)) ? "completed" : "due" : "suspended" }));
    return { ok: true, athletes: filtered, activeCount: rows.filter((a) => a.active).length, max: cfg.maxAthletes, kpiUsed: effective.size, kpiEnabledCount: rows.filter((a) => a.active && a.kpi_enabled).length, kpiLimit: limit, kpiReviewWeekStart: reviewWeek, kpiReviewWeekEnd: addDays(reviewWeek, 6) };
  }
  if (action === "addAthlete") {
    const name = String(d.name || "").trim();
    const teamId = String(d.teamId || "");
    if (!name) return { ok: false, error: "請輸入選手姓名" };
    const { data: team } = await db.from("teams").select("team_id").eq("team_id", teamId).eq("coach_id", coach.coach_id).maybeSingle();
    if (!team) return { ok: false, error: "團隊不存在或無權限" };
    if (rows.some((a) => a.team_id === teamId && String(a.name).trim() === name && a.active)) return { ok: false, error: `此團隊已有同名選手「${name}」` };
    const activeCount = rows.filter((a) => a.active).length;
    if (activeCount >= Number(cfg.maxAthletes)) return { ok: false, error: "plan_limit_reached", limit: cfg.maxAthletes, plan: coach.plan, message: `已達${cfg.name}上限（${cfg.maxAthletes} 人），請升級方案` };
    const row = { athlete_id: uid("a_"), coach_id: coach.coach_id, team_id: teamId, name, grade_class: String(d.gradeClass || ""), athlete_group: String(d.grp || ""), active: true, last_performance_visibility: normalizeVisibility(d.lastPerformanceVisibility), kpi_enabled: false };
    const { data: athlete, error } = await db.from("athletes").insert(row).select("*").single();
    if (error) return { ok: false, error: "新增選手失敗" };
    await audit(db, coach, "addAthlete", row.athlete_id, name);
    return { ok: true, athlete: athleteOut(athlete), activeCount: activeCount + 1, max: cfg.maxAthletes };
  }

  const athleteId = String(d.athleteId || "");
  const athlete = rows.find((a) => a.athlete_id === athleteId);
  if ((action !== "setKpiTrackingBulk") && !athlete) return { ok: false, error: "找不到選手" };
  if (action === "setAthleteActive") {
    const want = !!d.active;
    if (want && !athlete!.active && rows.filter((a) => a.active).length >= Number(cfg.maxAthletes)) return { ok: false, error: "plan_limit_reached", limit: cfg.maxAthletes, message: "已達上限，無法恢復" };
    await db.from("athletes").update({ active: want, updated_at: new Date().toISOString() }).eq("athlete_id", athleteId).eq("coach_id", coach.coach_id);
    return { ok: true, activeCount: rows.filter((a) => a.active).length + (want && !athlete!.active ? 1 : !want && athlete!.active ? -1 : 0) };
  }
  if (action === "updateAthlete") {
    const name = String(d.name == null ? athlete!.name : d.name).trim();
    const teamId = String(d.teamId == null ? athlete!.team_id : d.teamId).trim();
    if (!name) return { ok: false, error: "請輸入選手姓名" };
    const { data: team } = await db.from("teams").select("team_id").eq("team_id", teamId).eq("coach_id", coach.coach_id).maybeSingle();
    if (!team) return { ok: false, error: "找不到團隊或無權限" };
    if (rows.some((a) => a.athlete_id !== athleteId && a.team_id === teamId && String(a.name).trim() === name && a.active)) return { ok: false, error: `此團隊已有同名選手「${name}」` };
    const patch: Record<string, unknown> = { name, team_id: teamId, grade_class: String(d.gradeClass == null ? athlete!.grade_class || "" : d.gradeClass), updated_at: new Date().toISOString() };
    if (d.lastPerformanceVisibility != null) patch.last_performance_visibility = normalizeVisibility(d.lastPerformanceVisibility);
    if (d.resetPerfPin) { patch.perf_pin_hash = null; patch.perf_pin_salt = null; }
    const { error } = await db.from("athletes").update(patch).eq("athlete_id", athleteId).eq("coach_id", coach.coach_id);
    return error ? { ok: false, error: "更新失敗" } : { ok: true };
  }
  if (action === "setKpiTracking") {
    const want = !!d.enabled;
    if (want && !athlete!.active) return { ok: false, error: "停用中的選手不能開啟 KPI 追蹤" };
    const used = rows.filter((a) => a.active && a.kpi_enabled && a.athlete_id !== athleteId).length;
    if (want && used >= Number(cfg.kpiAthletes)) return { ok: false, error: "kpi_limit_reached", limit: cfg.kpiAthletes, plan: coach.plan, message: `${cfg.name}最多可追蹤 ${cfg.kpiAthletes} 位選手 KPI。` };
    await db.from("athletes").update({ kpi_enabled: want, kpi_enabled_at: want ? athlete!.kpi_enabled_at || new Date().toISOString() : null, updated_at: new Date().toISOString() }).eq("athlete_id", athleteId).eq("coach_id", coach.coach_id);
    return { ok: true, enabled: want, kpiUsed: used + (want ? 1 : 0), kpiLimit: cfg.kpiAthletes };
  }
  if (action === "setKpiTrackingBulk") {
    const ids = Array.from(new Set(Array.isArray(d.athleteIds) ? d.athleteIds.map(String) : [])).slice(0, 200);
    if (!ids.length) return { ok: false, error: "請先勾選選手" };
    const targets = rows.filter((a) => ids.includes(String(a.athlete_id)));
    if (targets.length !== ids.length) return { ok: false, error: "部分選手不存在或無權限" };
    const want = !!d.enabled;
    if (want && targets.some((a) => !a.active)) return { ok: false, error: "停用中的選手不能開啟 KPI 追蹤" };
    const resulting = rows.filter((a) => a.active && (a.kpi_enabled || (want && ids.includes(String(a.athlete_id)))) && !(!want && ids.includes(String(a.athlete_id)))).length;
    if (resulting > Number(cfg.kpiAthletes)) return { ok: false, error: "kpi_limit_reached", limit: cfg.kpiAthletes, plan: coach.plan, message: `這次會變成 ${resulting} 位，超過${cfg.name} ${cfg.kpiAthletes} 位 KPI 上限。請減少勾選人數。` };
    const changed = targets.filter((a) => !!a.kpi_enabled !== want).length;
    const patch = { kpi_enabled: want, kpi_enabled_at: want ? new Date().toISOString() : null, updated_at: new Date().toISOString() };
    await db.from("athletes").update(patch).in("athlete_id", ids).eq("coach_id", coach.coach_id);
    return { ok: true, enabled: want, changed, selected: ids.length, kpiUsed: resulting, kpiLimit: cfg.kpiAthletes };
  }
  if (action === "deleteAthlete") {
    const { count: daily } = await db.from("daily_records").select("record_id", { count: "exact", head: true }).eq("athlete_id", athleteId);
    const { count: weekly } = await db.from("weekly_kpi").select("weekly_kpi_id", { count: "exact", head: true }).eq("athlete_id", athleteId);
    const { error } = await db.from("athletes").delete().eq("athlete_id", athleteId).eq("coach_id", coach.coach_id);
    return error ? { ok: false, error: "刪除失敗" } : { ok: true, deletedRecords: daily || 0, deletedWeeklyKpis: weekly || 0, activeCount: rows.filter((a) => a.active).length - (athlete!.active ? 1 : 0) };
  }
  return null;
}
