import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type Db = SupabaseClient;
export type Data = Record<string, unknown>;

export const PLANS: Record<string, Record<string, unknown>> = {
  free: { name: "免費版", price: 0, maxAthletes: 10, kpiAthletes: 5, maxTeams: 1, lineNotifyPerDay: 1, report7Days: true, report30Days: false, pdfExport: false, multiTeam: false, customKpi: false, assistantAccounts: false, upgradePlan: "coach" },
  coach: { name: "教練版", price: 299, maxAthletes: 30, kpiAthletes: 15, maxTeams: 2, lineNotifyPerDay: "unlimited", report7Days: true, report30Days: true, pdfExport: false, multiTeam: false, customKpi: false, assistantAccounts: false, upgradePlan: "team" },
  team: { name: "團隊版", price: 699, maxAthletes: 80, kpiAthletes: 40, maxTeams: 99, lineNotifyPerDay: "unlimited", report7Days: true, report30Days: true, pdfExport: true, multiTeam: true, customKpi: false, assistantAccounts: false, upgradePlan: "pro" },
  pro: { name: "專業版", price: 1299, maxAthletes: 200, kpiAthletes: 100, maxTeams: 99, lineNotifyPerDay: "unlimited", report7Days: true, report30Days: true, pdfExport: true, multiTeam: true, customKpi: true, assistantAccounts: true, upgradePlan: "pro" },
};

export function uid(prefix: string): string {
  return prefix + crypto.randomUUID().replaceAll("-", "");
}

export function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function weekStart(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
  return d.toISOString().slice(0, 10);
}

export function effectivePlan(coach: Record<string, unknown>): string {
  const plan = String(coach.plan || "free");
  const expiry = coach.plan_expiry ? new Date(String(coach.plan_expiry)).getTime() : 0;
  return plan !== "free" && expiry && expiry < Date.now() ? "free" : plan;
}

export function expired(coach: Record<string, unknown>): boolean {
  return effectivePlan(coach) !== String(coach.plan || "free");
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function legacyPasswordHash(password: string, salt: string): Promise<string> {
  let value = `${salt}::${password}`;
  for (let i = 0; i < 5000; i++) value = await sha256Hex(value + i);
  return value;
}

export async function createSession(db: Db, coachId: string): Promise<string> {
  const token = uid("t_") + uid("");
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
  const { error } = await db.from("coach_sessions").insert({ token_hash: tokenHash, coach_id: coachId, expires_at: expiresAt });
  if (error) throw error;
  return token;
}

export async function coachFromToken(db: Db, token: unknown): Promise<Record<string, unknown> | null> {
  if (!token) return null;
  const tokenHash = await sha256Hex(String(token));
  const { data: session } = await db.from("coach_sessions").select("coach_id, expires_at").eq("token_hash", tokenHash).maybeSingle();
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await db.from("coach_sessions").delete().eq("token_hash", tokenHash);
    return null;
  }
  const { data: coach } = await db.from("coaches").select("*").eq("coach_id", session.coach_id).maybeSingle();
  return coach && coach.status !== "disabled" ? coach : null;
}

export async function publicCoach(db: Db, coach: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { count } = await db.from("athletes").select("athlete_id", { count: "exact", head: true }).eq("coach_id", coach.coach_id).eq("active", true);
  const plan = effectivePlan(coach);
  const cfg = PLANS[plan] || PLANS.free;
  return {
    coachId: coach.coach_id,
    email: coach.email,
    name: coach.name,
    plan: coach.plan,
    effectivePlan: plan,
    planName: cfg.name,
    maxAthletes: cfg.maxAthletes,
    planExpiry: coach.plan_expiry || "",
    expired: expired(coach),
    activeAthletes: count || 0,
    createdAt: coach.created_at,
    settings: coach.settings || {},
  };
}

export async function audit(db: Db, coach: Record<string, unknown> | null, action: string, target = "", detail = ""): Promise<void> {
  await db.from("audit_logs").insert({
    coach_id: coach?.coach_id || null,
    actor: coach?.email || "system",
    action,
    target,
    detail: detail ? { message: detail } : {},
  });
}

export function teamOut(row: Record<string, unknown>): Record<string, unknown> {
  return { teamId: row.team_id, coachId: row.coach_id, teamName: row.team_name, sport: row.sport || "", shareToken: row.share_token, status: row.status, createdAt: row.created_at, competitionSystem: row.competition_system || "", sportCategory: row.sport_category || "", memberTerm: row.member_term || "選手" };
}

export function athleteOut(row: Record<string, unknown>): Record<string, unknown> {
  return { athleteId: row.athlete_id, coachId: row.coach_id, teamId: row.team_id, name: row.name, gradeClass: row.grade_class || "", grp: row.athlete_group || "", active: row.active, createdAt: row.created_at, lastPerformanceVisibility: row.last_performance_visibility || "self_coach_only", kpiEnabled: !!row.kpi_enabled, kpiEnabledAt: row.kpi_enabled_at || "", hasPerfPin: !!row.perf_pin_hash };
}

export function normalizeVisibility(value: unknown): string {
  const allowed = ["self_coach_only", "coach_assistant", "parent_summary_only", "anonymous_stats"];
  return allowed.includes(String(value)) ? String(value) : "self_coach_only";
}
