import { requireCoach } from "./coach-actions.ts";
import { effectivePlan, expired, PLANS, type Data, type Db } from "./lib.ts";

export async function reportAction(db: Db, action: string, d: Data): Promise<Data | null> {
  if (!["teamReport", "visitSummary"].includes(action)) return null;
  const auth = await requireCoach(db, d);
  if ("error" in auth) return auth.error;
  const coach = auth.coach, teamId = String(d.teamId || ""), from = String(d.from || ""), to = String(d.to || "");
  let athleteQuery = db.from("athletes").select("*").eq("coach_id", coach.coach_id).eq("active", true);
  if (teamId) athleteQuery = athleteQuery.eq("team_id", teamId);
  const { data: athletes } = await athleteQuery;
  const athleteIds = new Set((athletes || []).map((a) => String(a.athlete_id)));
  let recordQuery = db.from("daily_records").select("*").eq("coach_id", coach.coach_id);
  if (teamId) recordQuery = recordQuery.eq("team_id", teamId);
  if (from) recordQuery = recordQuery.gte("record_date", from);
  if (to) recordQuery = recordQuery.lte("record_date", to);
  const { data: records } = await recordQuery;
  let weeklyQuery = db.from("weekly_kpi").select("*").eq("coach_id", coach.coach_id);
  if (teamId) weeklyQuery = weeklyQuery.eq("team_id", teamId);
  if (from) weeklyQuery = weeklyQuery.gte("week_start", from);
  if (to) weeklyQuery = weeklyQuery.lte("week_start", to);
  const { data: weeklyRows } = await weeklyQuery.order("week_start");
  const weekly = (weeklyRows || []).filter((r) => athleteIds.has(String(r.athlete_id)));

  if (action === "teamReport") {
    const days = Number(d.days) || 1;
    if (effectivePlan(coach) === "free" && days > 7) return { ok: false, error: "plan_limit_reached", message: "免費版僅支援 7 日報告，升級後可看 30 日報告。" };
    const dimensionKeys = ["technical_avg", "tactical_avg", "physical_avg", "mental_avg", "attitude_avg", "physiological_avg"];
    const outputKeys = ["technicalAvg", "tacticalAvg", "physicalAvg", "mentalAvg", "attitudeAvg", "physiologicalAvg"];
    const sums = dimensionKeys.map(() => 0), counts = dimensionKeys.map(() => 0), lights: Record<string, number> = { green: 0, yellow: 0, red: 0 };
    let totalSum = 0, totalCount = 0; const byDate = new Map<string, { sum: number; count: number }>(), perAthlete = new Map<string, Record<string, unknown>[]>();
    weekly.forEach((row) => {
      const total = Number(row.total_score) || 0;
      if (total) { totalSum += total; totalCount++; }
      lights[String(row.status || "green")]++;
      dimensionKeys.forEach((key, index) => { const value = Number(row[key]) || 0; if (value) { sums[index] += value; counts[index]++; } });
      const date = String(row.week_start), point = byDate.get(date) || { sum: 0, count: 0 };
      if (total) { point.sum += total; point.count++; }
      byDate.set(date, point);
      const list = perAthlete.get(String(row.athlete_id)) || []; list.push(row); perAthlete.set(String(row.athlete_id), list);
    });
    const dimAvg: Data = {}; outputKeys.forEach((key, index) => dimAvg[key] = counts[index] ? Number((sums[index] / counts[index]).toFixed(2)) : 0);
    const athleteRows = (athletes || []).map((athlete) => {
      const rows = perAthlete.get(String(athlete.athlete_id)) || [], totals = rows.map((r) => Number(r.total_score) || 0).filter(Boolean);
      const avg = totals.length ? Number((totals.reduce((sum, value) => sum + value, 0) / totals.length).toFixed(2)) : 0;
      const delta = rows.length >= 2 ? Number(((Number(rows.at(-1)?.total_score) || 0) - (Number(rows[0].total_score) || 0)).toFixed(2)) : 0;
      return { name: athlete.name, gradeClass: athlete.grade_class || "", filledDays: rows.length, avgTotal: avg, delta, lastStatus: rows.at(-1)?.status || "" };
    });
    const trend = Array.from(byDate.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([date, point]) => ({ date, avg: point.count ? Number((point.sum / point.count).toFixed(2)) : 0, count: point.count }));
    const expected = (athletes || []).length * days;
    return { ok: true, from, to, days, athleteCount: (athletes || []).length, teamAvg: totalCount ? Number((totalSum / totalCount).toFixed(2)) : 0, dimAvg, lights, totalReports: (records || []).length, expectedReports: expected, completionRate: expected ? Math.round((records || []).length / expected * 100) : 0, weeklyKpiReports: weekly.length, weeklyKpiExpected: (athletes || []).filter((a) => a.kpi_enabled).length * Math.max(1, byDate.size), trend, athletes: athleteRows };
  }

  let attendanceQuery = db.from("attendance").select("*").eq("coach_id", coach.coach_id);
  if (teamId) attendanceQuery = attendanceQuery.eq("team_id", teamId);
  if (from) attendanceQuery = attendanceQuery.gte("attendance_date", from);
  if (to) attendanceQuery = attendanceQuery.lte("attendance_date", to);
  const { data: attendance } = await attendanceQuery;
  let present = 0, slots = 0; const courses = new Set<string>();
  (attendance || []).forEach((row) => {
    if (row.course) courses.add(row.course);
    const marks = (row.marks || {}) as Record<string, { s?: string }>;
    (athletes || []).forEach((athlete) => { const mark = marks[String(athlete.athlete_id)]; if (mark) { slots++; if (!["absent", "leave"].includes(String(mark.s))) present++; } });
  });
  const injury = new Set<string>(), painParts = new Set<string>(); let maxPain = 0, sleepShort = 0, hydrationFlag = 0, notesFilled = 0, feedbackCount = 0, compParticipants = 0;
  const lights: Record<string, number> = { green: 0, yellow: 0, red: 0 }, medals = { gold: 0, silver: 0, bronze: 0 }, competitions = new Map<string, Data>(), awardPhotos: Data[] = [];
  for (const row of records || []) {
    const pain = Number(row.pain_score) || 0;
    if (pain >= 4) { injury.add(String(row.athlete_id)); maxPain = Math.max(maxPain, pain); String(row.pain_areas || "").split(",").filter(Boolean).forEach((part) => painParts.add(part)); }
    if (Number(row.sleep_duration_minutes) > 0 && Number(row.sleep_duration_minutes) < 300) sleepShort++;
    if (row.hydration_risk === "red") hydrationFlag++;
    if (String(row.training_notes || "").replace(/\s/g, "").length >= 4) notesFilled++;
    if (String(row.coach_comment || "").trim()) feedbackCount++;
    lights[String(row.status || "green")]++;
    if (row.competition_name) {
      const key = `${row.competition_date}|${row.competition_name}`, item = competitions.get(key) || { name: row.competition_name, date: row.competition_date, location: row.competition_location || "", parts: [] };
      (item.parts as Data[]).push({ name: (athletes || []).find((a) => a.athlete_id === row.athlete_id)?.name || "", result: row.competition_result }); competitions.set(key, item); compParticipants++;
      if (["gold", "silver", "bronze"].includes(String(row.competition_result))) medals[String(row.competition_result) as keyof typeof medals]++;
      if (row.competition_award_path) {
        let url = String(row.competition_award_path);
        if (!/^https?:/.test(url)) { const { data: signed } = await db.storage.from("award-photos").createSignedUrl(url, 3600); url = signed?.signedUrl || ""; }
        if (url) awardPhotos.push({ name: (athletes || []).find((a) => a.athlete_id === row.athlete_id)?.name || "", comp: row.competition_name, url });
      }
    }
  }
  const days = from && to ? Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1) : 1;
  return { ok: true, athleteCount: (athletes || []).length, days, trainingDays: (attendance || []).length, courses: Array.from(courses), attendanceRate: slots ? Math.round(present / slots * 100) : 0, reportCount: (records || []).length, weeklyKpiCount: weekly.length, reportRate: athletes?.length ? Math.min(100, Math.round((records || []).length / (athletes.length * days) * 100)) : 0, notesFilled, feedbackCount, injuryAthletes: injury.size, maxPain, painParts: Array.from(painParts), sleepShort, hydrationFlag, lights, competitions: Array.from(competitions.values()).sort((a, b) => String(b.date).localeCompare(String(a.date))), compCount: competitions.size, compParticipants, medals, awardPhotos };
}

export async function adminAction(db: Db, action: string, d: Data): Promise<Data | null> {
  if (!["adminListCoaches", "adminUpdatePlan", "adminSetStatus", "adminStats"].includes(action)) return null;
  const expected = Deno.env.get("ADMIN_PASSWORD") || "";
  if (!expected || String(d.adminPassword || "") !== expected) return { ok: false, error: "管理者密碼錯誤或未設定" };
  if (action === "adminUpdatePlan") {
    if (d.plan && !PLANS[String(d.plan)]) return { ok: false, error: "未知方案" };
    const patch: Data = { updated_at: new Date().toISOString() };
    if (d.plan) patch.plan = d.plan;
    if (d.planExpiry !== undefined) patch.plan_expiry = d.planExpiry || null;
    if (d.paymentNote !== undefined) patch.payment_note = String(d.paymentNote || "").trim();
    const { data, error } = await db.from("coaches").update(patch).eq("coach_id", d.coachId).select("coach_id").maybeSingle();
    return !data || error ? { ok: false, error: "找不到教練" } : { ok: true };
  }
  if (action === "adminSetStatus") {
    const status = d.status === "disabled" ? "disabled" : "active";
    const { data, error } = await db.from("coaches").update({ status, updated_at: new Date().toISOString() }).eq("coach_id", d.coachId).select("coach_id").maybeSingle();
    return !data || error ? { ok: false, error: "找不到教練" } : { ok: true, status };
  }
  const { data: coaches } = await db.from("coaches").select("*").order("created_at", { ascending: false });
  const { data: counts } = await db.from("athletes").select("coach_id").eq("active", true);
  const countByCoach = new Map<string, number>(); (counts || []).forEach((a) => countByCoach.set(a.coach_id, (countByCoach.get(a.coach_id) || 0) + 1));
  if (action === "adminListCoaches") {
    const q = String(d.q || "").trim().toLowerCase();
    const rows = (coaches || []).filter((c) => !q || String(c.email).toLowerCase().includes(q) || String(c.name).toLowerCase().includes(q)).map((c) => ({ coachId: c.coach_id, email: c.email, name: c.name, plan: c.plan, planName: PLANS[c.plan]?.name || c.plan, planExpiry: c.plan_expiry || "", expired: expired(c), status: c.status, createdAt: c.created_at, lastLogin: c.last_login_at, paymentNote: c.payment_note || "", activeAthletes: countByCoach.get(c.coach_id) || 0, max: PLANS[effectivePlan(c)]?.maxAthletes || 10 }));
    return { ok: true, coaches: rows, plans: PLANS };
  }
  const byPlan: Record<string, number> = { free: 0, coach: 0, team: 0, pro: 0 }; let mrr = 0, active = 0; const expiringSoon: Data[] = [], soon = Date.now() + 7 * 86400000;
  (coaches || []).forEach((c) => { byPlan[c.plan] = (byPlan[c.plan] || 0) + 1; if (c.status === "active") active++; if (!expired(c)) mrr += Number(PLANS[c.plan]?.price || 0); if (c.plan !== "free" && c.plan_expiry) { const expires = new Date(c.plan_expiry).getTime(); if (expires > Date.now() && expires < soon) expiringSoon.push({ email: c.email, name: c.name, plan: c.plan, planName: PLANS[c.plan]?.name || c.plan, planExpiry: c.plan_expiry, daysLeft: Math.ceil((expires - Date.now()) / 86400000), paymentNote: c.payment_note || "" }); } });
  return { ok: true, totalCoaches: (coaches || []).length, activeCoaches: active, byPlan, mrr, expiringSoon };
}
