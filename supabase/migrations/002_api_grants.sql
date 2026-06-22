-- Data API grants for authenticated coaches and server-side Edge Functions.
-- The anon role intentionally receives no table access.

grant usage on schema public to authenticated, service_role;

grant select, insert, update, delete on table
  public.coaches,
  public.teams,
  public.athletes,
  public.daily_records,
  public.weekly_kpi,
  public.attendance,
  public.competitions,
  public.privacy_requests,
  public.audit_logs,
  public.contacts
to authenticated, service_role;

grant usage, select on all sequences in schema public to authenticated, service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema public
  grant usage, select on sequences to authenticated, service_role;

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
