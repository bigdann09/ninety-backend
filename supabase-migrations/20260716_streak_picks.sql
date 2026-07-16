create table if not exists streak_picks (
  id uuid primary key default gen_random_uuid(),
  wallet text not null,
  match_id text not null references matches(id),
  pick text not null check (pick in ('home', 'draw', 'away')),
  created_at timestamptz not null default now(),
  settled boolean not null default false,
  correct boolean,
  -- One pick per wallet per fixture
  unique (wallet, match_id)
);

create index if not exists streak_picks_wallet_idx on streak_picks (wallet, created_at);
create index if not exists streak_picks_unsettled_idx on streak_picks (match_id) where not settled;

alter table streak_picks enable row level security;
