create table if not exists public.coach_sessions (
  token_hash text primary key,
  coach_id text not null references public.coaches(coach_id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists coach_sessions_coach_idx on public.coach_sessions (coach_id);
create index if not exists coach_sessions_expiry_idx on public.coach_sessions (expires_at);

alter table public.coach_sessions enable row level security;
grant select, insert, update, delete on public.coach_sessions to service_role;
revoke all on public.coach_sessions from anon, authenticated;

