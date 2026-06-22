import { addDays, athleteOut, effectivePlan, legacyPasswordHash, PLANS, today, uid, weekStart, type Data, type Db } from "./lib.ts";

const KPI_ITEMS = [
  "tech_accuracy", "tech_stability", "tech_speed", "tech_power", "tech_completion",
  "tac_distance", "tac_timing", "tac_transition", "tac_read", "tac_execution",
  "phy_explosive", "phy_strength", "phy_endurance", "phy_cardio", "phy_agility",
  "men_focus", "men_stress", "men_confidence", "men_resilience", "men_motivation",
  "att_discipline", "att_engagement", "att_initiative", "att_coachability", "att_teamwork",
  "pio_sleep", "pio_spirit", "pio_soreness", "pio_injury", "pio_recovery",
];
const DIMENSIONS = ["technical", "tactical", "physical", "mental", "attitude", "physiological"];

async function teamFromToken(db: Db, token: unknown): Promise<Record<string, unknown> | null> {
  if (!token) return null;
  const { data: team } = await db.from("teams").select("*").eq("share_token", String(token)).eq("status", "active").maybeSingle();
  if (!team) return null;
  const { data: coach } = await db.from("coaches").select("status").eq("coach_id", team.coach_id).maybeSingle();
  return coach?.status === "active" ? team : null;
}

async function athleteInTeam(db: Db, teamId: unknown, athleteId: unknown): Promise<Record<string, unknown> | null> {
  const { data } = await db.from("athletes").select("*").eq("team_id", teamId).eq("athlete_id", athleteId).maybeSingle();
  return data || null;
}

function weeklyOut(row: Record<string, unknown>): Data {
  const out: Data = {
    weeklyKpiId: row.weekly_kpi_id, coachId: row.coach_id, teamId: row.team_id, athleteId: row.athlete_id,
    name: row.name || "", weekStart: row.week_start, weekEnd: row.week_end, submittedAt: row.submitted_at,
    updatedAt: row.updated_at, technicalAvg: row.technical_avg, tacticalAvg: row.tactical_avg,
    physicalAvg: row.physical_avg, mentalAvg: row.mental_avg, attitudeAvg: row.attitude_avg,
    physiologicalAvg: row.physiological_avg, totalScore: row.total_score, status: row.status,
    qualityScore: row.quality_score, qualityLabel: row.quality_label, qualityReasons: row.quality_reasons,
    rawJson: JSON.stringify(row.raw_json || {}), date: row.week_start,
  };
  KPI_ITEMS.forEach((key) => out[key] = row[key]);
  return out;
}

function dailyOut(row: Record<string, unknown>): Data {
  return {
    recordId: row.record_id, coachId: row.coach_id, teamId: row.team_id, athleteId: row.athlete_id,
    date: row.record_date, timestamp: row.submitted_at, sessionType: row.session_type, status: row.status,
    heightCm: row.height_cm, weightKg: row.weight_kg, targetWeightKg: row.target_weight_kg, bmi: row.bmi,
    breakfast: row.breakfast, lunch: row.lunch, dinner: row.dinner, snacksDrinks: row.snacks_drinks,
    lateNightSnack: row.late_night_snack, breakfastNutri: row.breakfast_nutri, lunchNutri: row.lunch_nutri,
    dinnerNutri: row.dinner_nutri, trainingAM: row.training_am, trainingPM: row.training_pm,
    trainingEve: row.training_eve, trainingNotes: row.training_notes, moodIndex: row.mood_index,
    moodReason: row.mood_reason, gratitude: row.gratitude, reflection: row.reflection, fatigue: row.fatigue,
    sleepBedTime: row.sleep_bed_time, wakeTime: row.wake_time, sleepQuality: row.sleep_quality,
    sleepDurationMinutes: row.sleep_duration_minutes, sleepDurationText: row.sleep_duration_text, sleepRisk: row.sleep_risk,
    painStatus: row.pain_status, painAreas: row.pain_areas, painScore: row.pain_score, painImpact: row.pain_impact,
    painNote: row.pain_note, painRisk: row.pain_risk, waterAmount: row.water_amount, sweatAmount: row.sweat_amount,
    urineColor: row.urine_color, hydrationRisk: row.hydration_risk, hydrationAdvice: row.hydration_advice,
    hydrationFlags: row.hydration_flags, reportQualityScore: row.report_quality_score,
    reportQualityLabel: row.report_quality_label, reportQualityReasons: row.report_quality_reasons,
    coachSuggestion: row.coach_suggestion, encourageName: row.encourage_name, encourageMsg: row.encourage_msg,
    coachComment: row.coach_comment, coachFeedbackAt: row.coach_feedback_at, nutritionAdvice: row.nutrition_advice,
    studentLineText: row.student_line_text, parentLineText: row.parent_line_text, coachLineText: row.coach_line_text,
    compName: row.competition_name, compDate: row.competition_date, compLocation: row.competition_location,
    compResult: row.competition_result, compDetail: row.competition_detail, compReflection: row.competition_reflection,
    compAward: row.competition_award, compAwardLink: row.competition_award_path,
    rawJson: JSON.stringify(row.raw_json || {}),
  };
}

function sleepMetrics(bedValue: unknown, wakeValue: unknown): { minutes: number | null; text: string; risk: string } {
  const bed = String(bedValue || "").slice(0, 5), wake = String(wakeValue || "").slice(0, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(bed) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(wake)) return { minutes: null, text: "", risk: "" };
  const [bh, bm] = bed.split(":").map(Number), [wh, wm] = wake.split(":").map(Number);
  let minutes = wh * 60 + wm - bh * 60 - bm;
  if (minutes <= 0) minutes += 1440;
  const risk = minutes >= 420 && minutes <= 1080 ? "green" : minutes > 300 && minutes < 420 ? "yellow" : "red";
  return { minutes, text: `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分`, risk };
}

function painMetrics(statusValue: unknown, scoreValue: unknown, impactValue: unknown) {
  const statuses = ["none", "old", "new", "acute"], impacts = ["none", "high_intensity", "power_down", "cannot_sport", "daily_affected"];
  const status = statuses.includes(String(statusValue)) ? String(statusValue) : "none";
  const impact = impacts.includes(String(impactValue)) ? String(impactValue) : "none";
  const score = status === "none" ? 0 : Math.max(0, Math.min(10, Number(scoreValue) || 0));
  let risk = score >= 7 ? "red" : score >= 4 ? "yellow" : "green";
  if (["cannot_sport", "daily_affected"].includes(impact)) risk = "red";
  return { status, impact, score, risk };
}

function hydrationMetrics(d: Data, previous: Record<string, unknown> | null, sleep: { minutes: number | null }) {
  const water = ["very_little", "normal", "enough", "a_lot"].includes(String(d.waterAmount)) ? String(d.waterAmount) : "normal";
  const sweat = ["low", "normal", "high", "very_high"].includes(String(d.sweatAmount)) ? String(d.sweatAmount) : "normal";
  const urine = ["clear", "pale_yellow", "yellow", "dark", "abnormal"].includes(String(d.urineColor)) ? String(d.urineColor) : "pale_yellow";
  let risk = "green"; const flags: string[] = [];
  const highSweatLowWater = ["high", "very_high"].includes(sweat) && ["very_little", "normal"].includes(water);
  const consecutiveDark = urine === "dark" && previous?.record_date === addDays(String(d.date), -1) && previous?.urine_color === "dark";
  if (urine === "yellow") { risk = "yellow"; flags.push("urine_yellow"); }
  if (water === "very_little") { risk = "yellow"; flags.push("low_water"); }
  if (highSweatLowWater) { risk = "yellow"; flags.push("high_sweat_low_water"); }
  if (urine === "dark") { risk = "yellow"; flags.push("dark_urine"); }
  if (sweat === "very_high" && water === "very_little") flags.push("severe_dehydration_risk");
  if (urine === "abnormal" || consecutiveDark || (urine === "dark" && Number(d.fatigue) >= 7 && sleep.minutes !== null && sleep.minutes < 420)) risk = "red";
  if (urine === "abnormal") flags.push("abnormal_urine");
  if (consecutiveDark) flags.push("consecutive_dark");
  const advice = risk === "red" ? "水分狀態需立即確認；若尿液呈茶色、紅色或異常混濁，請通知家長並視情況尋求醫療協助。" : risk === "yellow" ? "今日訓練前後加強補水，流汗多時分次補充水分與電解質。" : urine === "clear" ? "水分充足，維持適量補水，避免短時間過量飲水。" : "水分狀況良好，維持規律補水。";
  return { water, sweat, urine, risk, flags, advice };
}

function riskStatus(...values: string[]): string {
  const rank: Record<string, number> = { green: 0, yellow: 1, red: 2 };
  return values.reduce((best, value) => (rank[value] || 0) > (rank[best] || 0) ? value : best, "green");
}

function weeklyScore(scores: Record<string, unknown>) {
  const dimAvg: Record<string, number> = {}; let valid = true;
  DIMENSIONS.forEach((dim, index) => {
    const values = KPI_ITEMS.slice(index * 5, index * 5 + 5).map((key) => Number(scores[key]));
    if (values.some((v) => !Number.isInteger(v) || v < 1 || v > 5)) valid = false;
    dimAvg[dim] = Number((values.reduce((sum, value) => sum + value, 0) / 5).toFixed(2));
  });
  const total = Number((DIMENSIONS.reduce((sum, dim) => sum + dimAvg[dim], 0) / 6).toFixed(2));
  return { valid, dimAvg, total, status: total >= 4 ? "green" : total >= 3 ? "yellow" : "red" };
}

export async function publicAction(db: Db, action: string, d: Data): Promise<Data | null> {
  const supported = ["joinInfo", "perfPinStatus", "setPerfPin", "lastRecord", "myRecords", "kpiFormState", "submitWeeklyKpi", "teamCompetitions", "submitRecord", "uploadAwardPhoto"];
  if (!supported.includes(action)) return null;
  const team = await teamFromToken(db, d.t || d.shareToken);
  if (!team) return { ok: false, error: "連結無效或已被重設，請向教練索取新連結" };

  if (action === "joinInfo") {
    const { data: athletes } = await db.from("athletes").select("athlete_id,name").eq("team_id", team.team_id).eq("active", true).order("created_at");
    const { data: coach } = await db.from("coaches").select("*").eq("coach_id", team.coach_id).single();
    const plan = effectivePlan(coach || {});
    return { ok: true, team: { teamId: team.team_id, teamName: team.team_name, sport: team.sport }, athletes: (athletes || []).map((a) => ({ athleteId: a.athlete_id, name: a.name })), items: KPI_ITEMS, pro: plan === "pro", free: plan === "free" };
  }

  const athlete = await athleteInTeam(db, team.team_id, d.athleteId);
  if (["perfPinStatus", "setPerfPin", "lastRecord", "myRecords", "kpiFormState", "submitWeeklyKpi", "submitRecord", "uploadAwardPhoto"].includes(action) && !athlete) return { ok: false, error: "選手不屬於此團隊" };
  const hasPin = !!athlete?.perf_pin_hash;
  const pinOk = async () => hasPin && await legacyPasswordHash(String(d.pin || ""), String(athlete?.perf_pin_salt || "")) === athlete?.perf_pin_hash;

  if (action === "perfPinStatus") return { ok: true, hasPin };
  if (action === "setPerfPin") {
    const pin = String(d.pin || "");
    if (!/^\d{4}$/.test(pin)) return { ok: false, error: "PIN 需為 4 位數字" };
    if (hasPin) return { ok: false, error: "已設定 PIN，請直接輸入；忘記請找教練重設" };
    const salt = uid("p_");
    const { error } = await db.from("athletes").update({ perf_pin_salt: salt, perf_pin_hash: await legacyPasswordHash(pin, salt), updated_at: new Date().toISOString() }).eq("athlete_id", athlete!.athlete_id);
    return error ? { ok: false, error: "PIN 設定失敗" } : { ok: true };
  }
  if (action === "lastRecord") {
    if (hasPin && !await pinOk()) return { ok: true, record: null, pinRequired: true };
    const { data: row } = await db.from("daily_records").select("*").eq("team_id", team.team_id).eq("athlete_id", athlete!.athlete_id).order("submitted_at", { ascending: false }).limit(1).maybeSingle();
    return { ok: true, record: row ? dailyOut(row) : null };
  }
  if (action === "myRecords") {
    if (!hasPin) return { ok: false, noPin: true, error: "尚未設定 PIN" };
    if (!await pinOk()) return { ok: false, pinRequired: true, error: "PIN 不正確" };
    const { data: rows } = await db.from("weekly_kpi").select("*").eq("team_id", team.team_id).eq("athlete_id", athlete!.athlete_id).order("week_start", { ascending: false }).limit(Number(d.limit || 14));
    return { ok: true, records: (rows || []).map(weeklyOut) };
  }
  if (action === "teamCompetitions") {
    const since = addDays(today(), -60);
    const { data: rows } = await db.from("competitions").select("name,competition_date,location").eq("team_id", team.team_id).gte("competition_date", since).order("competition_date", { ascending: false });
    return { ok: true, competitions: (rows || []).map((x) => ({ name: x.name, date: x.competition_date, location: x.location || "" })) };
  }
  if (action === "kpiFormState") {
    const date = String(d.date || today()), reviewWeek = addDays(weekStart(date), -7);
    const { data: coach } = await db.from("coaches").select("*").eq("coach_id", team.coach_id).single();
    const limit = Number((PLANS[effectivePlan(coach || {})] || PLANS.free).kpiAthletes);
    const { data: enabled } = await db.from("athletes").select("athlete_id").eq("coach_id", team.coach_id).eq("active", true).eq("kpi_enabled", true).order("kpi_enabled_at");
    const effective = new Set((enabled || []).slice(0, limit).map((a) => a.athlete_id));
    const { data: completed } = await db.from("weekly_kpi").select("weekly_kpi_id").eq("athlete_id", athlete!.athlete_id).eq("week_start", reviewWeek).maybeSingle();
    return { ok: true, kpiEnabled: !!athlete!.kpi_enabled, kpiEffective: effective.has(athlete!.athlete_id), kpiDue: effective.has(athlete!.athlete_id) && !completed, weekStart: reviewWeek, weekEnd: addDays(reviewWeek, 6), completed: !!completed, hasPin, pinRequired: hasPin && !await pinOk() };
  }
  if (action === "submitWeeklyKpi") {
    if (!athlete!.kpi_enabled) return { ok: false, error: "kpi_not_enabled", message: "此選手未開啟 KPI 追蹤或已超過方案配額。" };
    if (!hasPin) return { ok: false, noPin: true, error: "請先設定 4 位數 PIN 保護每週 KPI" };
    if (!await pinOk()) return { ok: false, pinRequired: true, error: "PIN 不正確" };
    const expectedWeek = addDays(weekStart(today()), -7), requestedWeek = String(d.weekStart || expectedWeek);
    if (requestedWeek !== expectedWeek) return { ok: false, error: "只能填寫上週 KPI" };
    const scores = (d.scores as Record<string, unknown>) || {}, calc = weeklyScore(scores);
    if (!calc.valid) return { ok: false, error: "30 項 KPI 皆需填寫 1–5 分整數" };
    const values = KPI_ITEMS.map((key) => Number(scores[key]));
    const qualityScore = values.every((value) => value === values[0]) ? 60 : 100;
    const row: Record<string, unknown> = { weekly_kpi_id: uid("wk_"), coach_id: team.coach_id, team_id: team.team_id, athlete_id: athlete!.athlete_id, week_start: requestedWeek, week_end: addDays(requestedWeek, 6), technical_avg: calc.dimAvg.technical, tactical_avg: calc.dimAvg.tactical, physical_avg: calc.dimAvg.physical, mental_avg: calc.dimAvg.mental, attitude_avg: calc.dimAvg.attitude, physiological_avg: calc.dimAvg.physiological, total_score: calc.total, status: calc.status, quality_score: qualityScore, quality_label: qualityScore >= 80 ? "正常" : "需確認", quality_reasons: qualityScore < 80 ? "30 題全部同分" : "", raw_json: scores, updated_at: new Date().toISOString() };
    KPI_ITEMS.forEach((key) => row[key] = Number(scores[key]));
    const { data: existing } = await db.from("weekly_kpi").select("weekly_kpi_id,submitted_at").eq("athlete_id", athlete!.athlete_id).eq("week_start", requestedWeek).maybeSingle();
    if (existing) { row.weekly_kpi_id = existing.weekly_kpi_id; row.submitted_at = existing.submitted_at; }
    const { error } = await db.from("weekly_kpi").upsert(row, { onConflict: "athlete_id,week_start" });
    return error ? { ok: false, error: "KPI 儲存失敗" } : { ok: true, updated: !!existing, totalScore: calc.total, status: calc.status, dimAvg: calc.dimAvg, weekStart: requestedWeek, weekEnd: row.week_end, quality: { score: qualityScore, label: row.quality_label } };
  }
  if (action === "uploadAwardPhoto") {
    const match = String(d.dataUrl || "").match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
    if (!match) return { ok: false, error: "圖片格式不支援" };
    const bytes = Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0));
    if (bytes.length > 4 * 1024 * 1024) return { ok: false, error: "圖片過大，請重拍或再壓縮" };
    const ext = match[1].split("/")[1].replace("jpeg", "jpg");
    const path = `${team.team_id}/${athlete!.athlete_id}/${Date.now()}_${uid("").slice(0, 8)}.${ext}`;
    const { error } = await db.storage.from("award-photos").upload(path, bytes, { contentType: match[1], upsert: false });
    if (error) return { ok: false, error: "照片上傳失敗" };
    const { data: signed } = await db.storage.from("award-photos").createSignedUrl(path, 3600);
    return { ok: true, url: signed?.signedUrl || "", path };
  }
  if (action === "submitRecord") {
    const date = String(d.date || today());
    const { data: previous } = await db.from("daily_records").select("*").eq("athlete_id", athlete!.athlete_id).lt("record_date", date).order("record_date", { ascending: false }).limit(1).maybeSingle();
    const sleep = sleepMetrics(d.sleepBedTime, d.wakeTime), pain = painMetrics(d.painStatus, d.painScore, d.painImpact), hydration = hydrationMetrics({ ...d, date }, previous, sleep);
    const qualityReasons: string[] = []; let qualityScore = 100;
    if (String(d.trainingNotes || "").replace(/\s/g, "").length < 4) { qualityScore -= 15; qualityReasons.push("心得過短"); }
    if (pain.score >= 7 && ["none", "high_intensity"].includes(pain.impact)) { qualityScore -= 25; qualityReasons.push("高疼痛但回報影響輕微"); }
    if (sleep.minutes !== null && sleep.minutes < 240 && String(d.sleepQuality) === "good") { qualityScore -= 20; qualityReasons.push("睡眠過少但品質填良好"); }
    qualityScore = Math.max(0, qualityScore);
    const qualityLabel = qualityScore >= 80 ? "正常" : qualityScore >= 60 ? "需確認" : "疑似敷衍";
    const status = riskStatus("green", pain.risk, sleep.risk, hydration.risk);
    const suggestion = pain.risk === "red" ? "建議停止專項訓練，立即確認疼痛並通知教練／家長。" : hydration.risk === "red" ? hydration.advice : sleep.risk === "red" ? "今日降低訓練強度與反應負荷，優先安排恢復。" : pain.score >= 4 ? "今日降低高衝擊與疼痛部位負荷，訓練中持續觀察。" : hydration.risk === "yellow" ? hydration.advice : sleep.risk === "yellow" ? "睡眠偏少，今日控制高強度訓練量並留意疲勞。" : qualityLabel !== "正常" ? "先口頭確認今日狀態，再依實際情況安排訓練。" : "今日狀態穩定，可依原定計畫訓練並持續觀察。";
    const height = Number(d.heightCm) || null, weight = Number(d.weightKg) || null;
    const row: Record<string, unknown> = { record_id: uid("r_"), coach_id: team.coach_id, team_id: team.team_id, athlete_id: athlete!.athlete_id, record_date: date, session_type: String(d.sessionType || "training"), status, height_cm: height, weight_kg: weight, target_weight_kg: Number(d.targetWeightKg) || null, bmi: height && weight ? Number((weight / Math.pow(height / 100, 2)).toFixed(1)) : null, breakfast: d.breakfast || null, lunch: d.lunch || null, dinner: d.dinner || null, snacks_drinks: d.snacksDrinks || null, late_night_snack: d.lateNightSnack || null, breakfast_nutri: d.breakfastNutri || null, lunch_nutri: d.lunchNutri || null, dinner_nutri: d.dinnerNutri || null, training_am: d.trainingAM || null, training_pm: d.trainingPM || null, training_eve: d.trainingEve || null, training_notes: d.trainingNotes || null, mood_index: Number(d.moodIndex) || null, mood_reason: d.moodReason || null, gratitude: d.gratitude || null, reflection: d.reflection || null, fatigue: Number(d.fatigue) || null, sleep_bed_time: d.sleepBedTime || null, wake_time: d.wakeTime || null, sleep_quality: d.sleepQuality || null, sleep_duration_minutes: sleep.minutes, sleep_duration_text: sleep.text || null, sleep_risk: sleep.risk || null, pain_status: pain.status, pain_areas: pain.status === "none" ? null : d.painAreas || d.injuryAreas || null, pain_score: pain.score, pain_impact: pain.impact, pain_note: d.painNote || d.injuryNote || null, pain_risk: pain.risk, water_amount: hydration.water, sweat_amount: hydration.sweat, urine_color: hydration.urine, hydration_risk: hydration.risk, hydration_advice: hydration.advice, hydration_flags: hydration.flags.join(","), report_quality_score: qualityScore, report_quality_label: qualityLabel, report_quality_reasons: qualityReasons.join("、"), coach_suggestion: suggestion, encourage_name: d.encourageName || null, encourage_msg: d.encourageMsg || null, nutrition_advice: d.nutritionAdvice || null, student_line_text: d.studentLineText || null, parent_line_text: d.parentLineText || null, coach_line_text: d.coachLineText || null, consent_privacy: !!d.consentPrivacy, guardian_consent: !!d.guardianConsent, consent_at: d.consentAt || new Date().toISOString(), privacy_version: d.privacyVersion || null, consent_text: d.consentText || null, device_info: d.deviceInfo || null, competition_name: d.compName || null, competition_date: d.compName ? d.compDate || date : null, competition_location: d.compLocation || null, competition_result: d.compResult || null, competition_detail: d.compDetail || null, competition_reflection: d.compReflection || null, competition_award: !!d.compAward, competition_award_path: d.compAwardLink || null, raw_json: d, updated_at: new Date().toISOString() };
    const { data: existing } = await db.from("daily_records").select("record_id,submitted_at").eq("team_id", team.team_id).eq("athlete_id", athlete!.athlete_id).eq("record_date", date).maybeSingle();
    if (existing) { row.record_id = existing.record_id; row.submitted_at = existing.submitted_at; }
    const { error } = await db.from("daily_records").upsert(row, { onConflict: "team_id,athlete_id,record_date" });
    if (error) return { ok: false, error: "回報儲存失敗" };
    if (d.compName) await db.from("competitions").upsert({ competition_id: uid("cp_"), coach_id: team.coach_id, team_id: team.team_id, competition_date: d.compDate || date, name: String(d.compName), location: d.compLocation || null }, { onConflict: "team_id,competition_date,name", ignoreDuplicates: true });
    return { ok: true, updated: !!existing, totalScore: "", status, dimAvg: { technical: "", tactical: "", physical: "", mental: "", attitude: "", physiological: "" }, sleep, pain, hydration, quality: { score: qualityScore, label: qualityLabel, reasons: qualityReasons } };
  }
  return null;
}

export { dailyOut, weeklyOut };
