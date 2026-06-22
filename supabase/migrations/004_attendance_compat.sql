alter table public.attendance
  drop constraint if exists attendance_team_id_attendance_date_course_key;

create unique index if not exists attendance_team_date_unique
  on public.attendance (team_id, attendance_date);

