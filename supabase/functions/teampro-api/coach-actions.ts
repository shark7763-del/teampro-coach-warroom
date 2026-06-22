import { audit, coachFromToken, createSession, effectivePlan, legacyPasswordHash, PLANS, publicCoach, sha256Hex, uid, type Data, type Db } from "./lib.ts";

export async function coachAction(db: Db, action: string, d: Data): Promise<Data | null> {
  if (action === "register") {
    const email = String(d.email || "").trim().toLowerCase();
    const password = String(d.password || "");
    const name = String(d.name || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "請輸入有效 email" };
    if (password.length < 6) return { ok: false, error: "密碼至少 6 碼" };
    if (!name) return { ok: false, error: "請輸入教練姓名" };
    const { data: existing } = await db.from("coaches").select("coach_id").eq("email", email).maybeSingle();
    if (existing) return { ok: false, error: "此 email 已註冊" };
    const salt = uid("s_");
    const coachId = uid("c_");
    const passwordHash = await legacyPasswordHash(password, salt);
    const { data: coach, error } = await db.from("coaches").insert({ coach_id: coachId, email, name, plan: "free", status: "active", legacy_password_hash: passwordHash, legacy_password_salt: salt, last_login_at: new Date().toISOString() }).select("*").single();
    if (error) return { ok: false, error: error.code === "23505" ? "此 email 已註冊" : "註冊失敗" };
    const token = await createSession(db, coachId);
    await audit(db, coach, "register", coachId);
    return { ok: true, token, coach: await publicCoach(db, coach) };
  }

  if (action === "login") {
    const email = String(d.email || "").trim().toLowerCase();
    const password = String(d.password || "");
    const { data: coach } = await db.from("coaches").select("*").eq("email", email).maybeSingle();
    if (!coach || !coach.legacy_password_hash || !coach.legacy_password_salt) return { ok: false, error: "email 或密碼錯誤" };
    if (coach.status === "disabled") return { ok: false, error: "帳號已停用，請聯絡客服" };
    if (await legacyPasswordHash(password, coach.legacy_password_salt) !== coach.legacy_password_hash) return { ok: false, error: "email 或密碼錯誤" };
    await db.from("coaches").update({ last_login_at: new Date().toISOString() }).eq("coach_id", coach.coach_id);
    const token = await createSession(db, coach.coach_id);
    await audit(db, coach, "login", coach.coach_id);
    return { ok: true, token, coach: await publicCoach(db, coach) };
  }

  if (action === "logout") {
    if (d.token) await db.from("coach_sessions").delete().eq("token_hash", await sha256Hex(String(d.token)));
    return { ok: true };
  }

  const coach = await coachFromToken(db, d.token);
  if (!coach) return ["me", "updateProfile", "changePassword", "saveSettings"].includes(action) ? { ok: false, error: "unauthorized", needLogin: true } : null;

  if (action === "me") return { ok: true, coach: await publicCoach(db, coach) };
  if (action === "updateProfile") {
    const name = String(d.name || "").trim();
    if (!name) return { ok: false, error: "請輸入姓名" };
    const { data: updated, error } = await db.from("coaches").update({ name, updated_at: new Date().toISOString() }).eq("coach_id", coach.coach_id).select("*").single();
    if (error) return { ok: false, error: "更新失敗" };
    await audit(db, coach, "updateProfile", String(coach.coach_id), name);
    return { ok: true, coach: await publicCoach(db, updated) };
  }
  if (action === "changePassword") {
    const current = String(d.currentPassword || "");
    const next = String(d.newPassword || "");
    if (await legacyPasswordHash(current, String(coach.legacy_password_salt || "")) !== coach.legacy_password_hash) return { ok: false, error: "目前密碼不正確" };
    if (next.length < 6) return { ok: false, error: "新密碼至少 6 碼" };
    if (next === current) return { ok: false, error: "新密碼不可與目前密碼相同" };
    const salt = uid("s_");
    const hash = await legacyPasswordHash(next, salt);
    const { error } = await db.from("coaches").update({ legacy_password_hash: hash, legacy_password_salt: salt, updated_at: new Date().toISOString() }).eq("coach_id", coach.coach_id);
    return error ? { ok: false, error: "更新密碼失敗" } : { ok: true };
  }
  if (action === "saveSettings") {
    const settings = { ...((coach.settings as Record<string, unknown>) || {}), ...((d.settings as Record<string, unknown>) || {}) };
    const { error } = await db.from("coaches").update({ settings, updated_at: new Date().toISOString() }).eq("coach_id", coach.coach_id);
    return error ? { ok: false, error: "儲存失敗" } : { ok: true, settings };
  }
  if (action === "trialSummary") {
    const created = new Date(String(coach.created_at)).getTime();
    const accountDay = created ? Math.floor((Date.now() - created) / 86400000) + 1 : 1;
    const { count: athleteCount } = await db.from("athletes").select("athlete_id", { count: "exact", head: true }).eq("coach_id", coach.coach_id).eq("active", true);
    const { data: records, count: reportCount } = await db.from("daily_records").select("athlete_id,status", { count: "exact" }).eq("coach_id", coach.coach_id);
    const red = new Set((records || []).filter((r) => r.status === "red").map((r) => r.athlete_id));
    return { ok: true, visible: accountDay >= 3, accountDay, athleteCount: athleteCount || 0, reportCount: reportCount || 0, redAthleteCount: red.size, estimatedMinutes: Math.max(10, (reportCount || 0) * 2), upgradeMessage: "升級教練版，每月 299 元，持續使用家長通知、歷史趨勢與成果報告。" };
  }
  if (["adminStats", "adminListCoaches", "adminUpdatePlan", "adminSetStatus"].includes(action)) return null;
  return null;
}

export async function requireCoach(db: Db, d: Data): Promise<{ coach: Record<string, unknown> } | { error: Data }> {
  const coach = await coachFromToken(db, d.token);
  return coach ? { coach } : { error: { ok: false, error: "unauthorized", needLogin: true } };
}

export function planConfig(coach: Record<string, unknown>): Record<string, unknown> {
  return PLANS[effectivePlan(coach)] || PLANS.free;
}
