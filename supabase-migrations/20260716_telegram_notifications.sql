create table if not exists telegram_notifications (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null,
  team text not null,
  event_types text[] not null default '{goal,card,fulltime}',
  created_at timestamptz not null default now(),
  unique (chat_id, team)
);

create index if not exists telegram_notifications_team_idx on telegram_notifications (team);