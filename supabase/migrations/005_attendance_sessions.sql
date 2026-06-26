-- A session is the unit of attendance.  Multiple sessions may exist on one team/date.
alter table public.attendance
  add column if not exists session_id text,
  add column if not exists session_name text,
  add column if not exists start_time time,
  add column if not exists end_time time,
  add column if not exists created_at timestamptz not null default now();

update public.attendance
set session_id = coalesce(session_id, attendance_id),
    session_name = coalesce(session_name, nullif(course, ''), '未命名時段'),
    start_time = coalesce(start_time, '00:00'::time),
    end_time = coalesce(end_time, '00:00'::time)
where session_id is null or session_name is null or start_time is null or end_time is null;

alter table public.attendance
  alter column session_id set not null,
  alter column session_name set not null,
  alter column start_time set not null,
  alter column end_time set not null;

drop index if exists public.attendance_team_date_unique;
alter table public.attendance drop constraint if exists attendance_team_id_attendance_date_course_key;
create unique index if not exists attendance_team_date_session_unique
  on public.attendance (team_id, attendance_date, session_name, start_time, end_time);
