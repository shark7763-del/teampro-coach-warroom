import { requireCoach, planConfig } from "./coach-actions.ts";
import { dailyOut, weeklyOut } from "./public-actions.ts";
import { addDays, audit, today, uid, weekStart, type Data, type Db } from "./lib.ts";

async function ownedAthlete(db: Db, coachId: unknown, athleteId: unknown): Promise<Record<string, unknown> | null> {
  const { data } = await db.from("athletes").select("*").eq("coach_id", coachId).eq("athlete_id", athleteId).maybeSingle();
  return data || null;
}

export async function coachDataAction(db: Db, action: string, d: Data): Promise<Data | null> {
  const supported = ["saveAttendance", "getAttendance", "attendanceRange", "warroom", "athleteRecords", "athleteWeeklyKpis", "coachFeedback", "listPrivacyRequests", "createPrivacyRequest", "resolvePrivacyRequest"];
  if (!supported.includes(action)) return null;
  const auth = await requireCoach(db, d);
  if ("error" in auth) return auth.error;
  const coach = auth.coach;

  if (action === "saveAttendance") {
    const teamId = String(d.teamId || ""), date = String(d.date || today());
    if (!teamId) return { ok: false, error: "請選擇隊伍" };
    const { data: team } = await db.from("teams").select("team_id").eq("coach_id", coach.coach_id).eq("team_id", teamId).maybeSingle();
    if (!team) return { ok: false, error: "找不到團隊或無權限" };
    const input = (d.marks as Record<string, Record<string, unknown>>) || {}, marks: Record<string, unknown> = {};
    const allowed = ["present", "late", "leave", "absent", "injured"];
    Object.keys(input).forEach((athleteId) => {
      const item = input[athleteId] || {}, status = String(item.s || item.status || "present");
      marks[athleteId] = { s: allowed.includes(status) ? status : "present", n: String(item.n || item.note || "").slice(0, 200) };
    });
    const row = { attendance_id: uid("at_"), coach_id: coach.coach_id, team_id: teamId, attendance_date: date, course: String(d.course || "").slice(0, 60), marks, updated_at: new Date().toISOString() };
    const { data: existing } = await db.from("attendance").select("attendance_id").eq("team_id", teamId).eq("attendance_date", date).maybeSingle();
    if (existing) row.attendance_id = existing.attendance_id;
    const { error } = await db.from("attendance").upsert(row, { onConflict: "team_id,attendance_date" });
    if (error) return { ok: false, error: "點名儲存失敗" };
    await audit(db, coach, "saveAttendance", teamId, `${date} ${row.course}`);
    return { ok: true };
  }
  if (action === "getAttendance") {
    const { data: row } = await db.from("attendance").select("course,marks").eq("coach_id", coach.coach_id).eq("team_id", d.teamId).eq("attendance_date", d.date || today()).maybeSingle();
    return row ? { ok: true, found: true, course: row.course || "", marks: row.marks || {} } : { ok: true, found: false, course: "", marks: {} };
  }
  if (action === "attendanceRange") {
    let query = db.from("attendance").select("team_id,attendance_date,course,marks").eq("coach_id", coach.coach_id);
    if (d.teamId) query = query.eq("team_id", d.teamId);
    if (d.from) query = query.gte("attendance_date", d.from);
    if (d.to) query = query.lte("attendance_date", d.to);
    const { data: rows } = await query.order("attendance_date");
    return { ok: true, records: (rows || []).map((row) => ({ date: row.attendance_date, teamId: row.team_id, course: row.course || "", marks: row.marks || {} })) };
  }
  if (action === "athleteRecords") {
    const athlete = await ownedAthlete(db, coach.coach_id, d.athleteId);
    if (!athlete) return { ok: false, error: "forbidden" };
    const { data: rows } = await db.from("daily_records").select("*").eq("coach_id", coach.coach_id).eq("athlete_id", athlete.athlete_id).order("record_date", { ascending: false }).limit(Number(d.limit || 30));
    return { ok: true, records: (rows || []).map(dailyOut) };
  }
  if (action === "athleteWeeklyKpis") {
    const athlete = await ownedAthlete(db, coach.coach_id, d.athleteId);
    if (!athlete) return { ok: false, error: "forbidden" };
    const { data: rows } = await db.from("weekly_kpi").select("*").eq("coach_id", coach.coach_id).eq("athlete_id", athlete.athlete_id).order("week_start", { ascending: false }).limit(Number(d.limit || 30));
    return { ok: true, records: (rows || []).map(weeklyOut) };
  }
  if (action === "coachFeedback") {
    const { data, error } = await db.from("daily_records").update({ coach_comment: String(d.feedback || ""), coach_feedback_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("record_id", d.recordId).eq("coach_id", coach.coach_id).select("record_id").maybeSingle();
    return !data || error ? { ok: false, error: "找不到紀錄（可能是舊資料）" } : { ok: true };
  }
  if (action === "warroom") {
    const date = String(d.date || today()), teamId = String(d.teamId || "");
    let athleteQuery = db.from("athletes").select("*").eq("coach_id", coach.coach_id).eq("active", true);
    if (teamId) athleteQuery = athleteQuery.eq("team_id", teamId);
    const { data: athletes } = await athleteQuery;
    let recordQuery = db.from("daily_records").select("*").eq("coach_id", coach.coach_id).eq("record_date", date);
    if (teamId) recordQuery = recordQuery.eq("team_id", teamId);
    const { data: records } = await recordQuery;
    let weeklyQuery = db.from("weekly_kpi").select("*").eq("coach_id", coach.coach_id).order("week_start", { ascending: false });
    if (teamId) weeklyQuery = weeklyQuery.eq("team_id", teamId);
    const { data: weekly } = await weeklyQuery;
    const byAthlete = new Map((records || []).map((r) => [String(r.athlete_id), r]));
    const weeklyByAthlete = new Map<string, Record<string, unknown>[]>();
    (weekly || []).forEach((row) => { const key = String(row.athlete_id); const list = weeklyByAthlete.get(key) || []; list.push(row); weeklyByAthlete.set(key, list); });
    const cfg = planConfig(coach), enabled = (athletes || []).filter((a) => a.kpi_enabled).sort((a, b) => String(a.kpi_enabled_at || a.created_at).localeCompare(String(b.kpi_enabled_at || b.created_at))).slice(0, Number(cfg.kpiAthletes));
    const effective = new Set(enabled.map((a) => String(a.athlete_id))), reviewWeek = addDays(weekStart(date), -7);
    const submitted: Data[] = [], missing: Data[] = [], encourages: Data[] = [], declining: Data[] = [], encouraging: Data[] = [];
    const lights: Record<string, number> = { green: 0, yellow: 0, red: 0 }; let weeklyCompleted = 0;
    (athletes || []).forEach((athlete) => {
      const rec = byAthlete.get(String(athlete.athlete_id)), wk = weeklyByAthlete.get(String(athlete.athlete_id)) || [];
      if (effective.has(String(athlete.athlete_id)) && wk.some((x) => x.week_start === reviewWeek)) weeklyCompleted++;
      if (!rec) { missing.push({ athleteId: athlete.athlete_id, name: athlete.name }); return; }
      const latest = wk[0], isDeclining = wk.length >= 3 && Number(wk[0].total_score) < Number(wk[1].total_score) && Number(wk[1].total_score) < Number(wk[2].total_score);
      lights[String(rec.status || "green")]++;
      const item: Data = { athleteId: athlete.athlete_id, name: athlete.name, totalScore: latest?.total_score || "", status: rec.status, kpiWeekStart: latest?.week_start || "", moodIndex: rec.mood_index, recordId: rec.record_id, declining: isDeclining, sleepDurationMinutes: rec.sleep_duration_minutes, sleepDurationText: rec.sleep_duration_text, sleepRisk: rec.sleep_risk, painStatus: rec.pain_status, painAreas: rec.pain_areas, painScore: rec.pain_score, painImpact: rec.pain_impact, painRisk: rec.pain_risk, waterAmount: rec.water_amount, sweatAmount: rec.sweat_amount, urineColor: rec.urine_color, hydrationRisk: rec.hydration_risk, hydrationAdvice: rec.hydration_advice, hydrationFlags: rec.hydration_flags, reportQualityScore: rec.report_quality_score, reportQualityLabel: rec.report_quality_label, reportQualityReasons: rec.report_quality_reasons, coachSuggestion: rec.coach_suggestion };
      submitted.push(item);
      if (isDeclining) declining.push({ athleteId: athlete.athlete_id, name: athlete.name });
      if (rec.status === "green" && latest && Number(latest.total_score) >= 4.3) encouraging.push({ athleteId: athlete.athlete_id, name: athlete.name, totalScore: latest.total_score });
      if (rec.encourage_msg) encourages.push({ from: athlete.name, to: rec.encourage_name || "", msg: rec.encourage_msg });
    });
    const weeklyTotal = effective.size;
    return { ok: true, date, total: (athletes || []).length, submittedCount: submitted.length, missingCount: missing.length, completionRate: athletes?.length ? Math.round(submitted.length / athletes.length * 100) : 0, weeklyKpi: { weekStart: reviewWeek, weekEnd: addDays(reviewWeek, 6), total: weeklyTotal, completed: weeklyCompleted, missing: Math.max(0, weeklyTotal - weeklyCompleted), completionRate: weeklyTotal ? Math.round(weeklyCompleted / weeklyTotal * 100) : 0 }, lights, submitted, missing, encourages, priority: { red: submitted.filter((item) => item.status === "red"), missing, declining, encouraging } };
  }
  if (action === "listPrivacyRequests") {
    const { data: rows } = await db.from("privacy_requests").select("*").eq("coach_id", coach.coach_id).order("created_at", { ascending: false });
    return { ok: true, requests: (rows || []).map((r) => ({ requestId: r.request_id, coachId: r.coach_id, athleteId: r.athlete_id, athleteName: r.athlete_name, requestType: r.request_type, scope: r.scope, note: r.note, status: r.status, createdAt: r.created_at, handledAt: r.handled_at, resolutionNote: r.resolution_note })) };
  }
  if (action === "createPrivacyRequest") {
    const athlete = await ownedAthlete(db, coach.coach_id, d.athleteId);
    if (!athlete) return { ok: false, error: "找不到選手或無權限" };
    const type = String(d.requestType || ""), allowed = ["hide_record", "delete_record", "correct_data", "stop_use"];
    if (!allowed.includes(type)) return { ok: false, error: "未知請求類型" };
    const row = { request_id: uid("pr_"), coach_id: coach.coach_id, athlete_id: athlete.athlete_id, athlete_name: athlete.name, request_type: type, scope: String(d.scope || ""), note: String(d.note || ""), status: "pending" };
    const { error } = await db.from("privacy_requests").insert(row);
    return error ? { ok: false, error: "建立請求失敗" } : { ok: true, request: { requestId: row.request_id, ...row } };
  }
  if (action === "resolvePrivacyRequest") {
    const status = String(d.status || ""), note = String(d.resolutionNote || "").trim();
    if (!["handled", "rejected"].includes(status)) return { ok: false, error: "結案狀態只能是已處理或已駁回" };
    if (!note) return { ok: false, error: "請填寫處理說明" };
    const { data, error } = await db.from("privacy_requests").update({ status, resolution_note: note, handled_at: new Date().toISOString() }).eq("request_id", d.requestId).eq("coach_id", coach.coach_id).eq("status", "pending").select("*").maybeSingle();
    return !data || error ? { ok: false, error: "找不到待處理的個資請求" } : { ok: true, request: data };
  }
  return null;
}

export async function contactAction(db: Db, action: string, d: Data): Promise<Data | null> {
  if (action !== "contact") return null;
  if (d.website) return { ok: true };
  const message = String(d.message || "").trim().slice(0, 5000);
  if (message.length < 2) return { ok: false, error: "請填寫訊息內容" };
  const { error } = await db.from("contacts").insert({ topic: String(d.topic || "網站來訊").slice(0, 80), name: String(d.name || "").slice(0, 100), email: String(d.email || "").slice(0, 150) || null, message });
  return error ? { ok: false, error: "送出失敗" } : { ok: true };
}
