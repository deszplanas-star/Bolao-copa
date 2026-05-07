-- ============================================================
-- Bolão 26 — Schema Inicial
-- 8 tabelas + RLS + view ranking + triggers
-- ============================================================

-- =========================================================
-- ENUMS
-- =========================================================
create type user_role as enum ('player', 'admin');
create type match_status as enum ('scheduled', 'locked', 'finished');
create type payment_status as enum ('pending', 'approved', 'denied');

-- =========================================================
-- USERS — espelho de auth.users
-- =========================================================
create table public.users (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text unique not null,
  name        text,
  avatar_url  text,
  role        user_role not null default 'player',
  created_at  timestamptz default now()
);

-- Trigger: cria registro em public.users quando auth.users insere
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.users (id, email, name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', new.email),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do update set
    email = excluded.email,
    name  = coalesce(excluded.name, public.users.name),
    avatar_url = coalesce(excluded.avatar_url, public.users.avatar_url);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =========================================================
-- GROUPS — 12 grupos (A a L)
-- =========================================================
create table public.groups (
  id    uuid primary key default gen_random_uuid(),
  code  char(1) unique not null,
  name  text not null,
  ord   int not null
);

-- =========================================================
-- TEAMS — 48 seleções
-- =========================================================
create table public.teams (
  id          uuid primary key default gen_random_uuid(),
  iso_code    text not null,         -- ex: 'br', 'gb-sct'
  name        text not null,
  group_id    uuid references public.groups(id) on delete restrict,
  created_at  timestamptz default now()
);
create index idx_teams_group on public.teams(group_id);

-- =========================================================
-- MATCHES — 72 jogos da fase de grupos
-- =========================================================
create table public.matches (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid not null references public.groups(id),
  home_team_id  uuid not null references public.teams(id),
  away_team_id  uuid not null references public.teams(id),
  kickoff_at    timestamptz not null,
  stadium       text,
  matchday      int not null check (matchday between 1 and 3),
  home_score    int check (home_score >= 0),
  away_score    int check (away_score >= 0),
  status        match_status not null default 'scheduled',
  finalized_at  timestamptz,
  finalized_by  uuid references public.users(id),
  created_at    timestamptz default now(),
  check (home_team_id <> away_team_id),
  check ((home_score is null) = (away_score is null))
);
create index idx_matches_group on public.matches(group_id);
create index idx_matches_kickoff on public.matches(kickoff_at);

-- =========================================================
-- PREDICTIONS — palpite de cada usuário em cada jogo
-- =========================================================
create table public.predictions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  match_id     uuid not null references public.matches(id) on delete cascade,
  home_score   int not null check (home_score between 0 and 99),
  away_score   int not null check (away_score between 0 and 99),
  points       int not null default 0,
  computed_at  timestamptz,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  unique (user_id, match_id)
);
create index idx_predictions_user on public.predictions(user_id);
create index idx_predictions_match on public.predictions(match_id);

-- Trigger: atualiza updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger predictions_updated_at
  before update on public.predictions
  for each row execute function public.set_updated_at();

-- =========================================================
-- PAYMENTS — Pix manual com aprovação humana
-- =========================================================
create table public.payments (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid unique not null references public.users(id) on delete cascade,
  amount_cents        int not null default 5000, -- R$50,00
  status              payment_status not null default 'pending',
  user_confirmed_at   timestamptz,
  approved_at         timestamptz,
  approved_by         uuid references public.users(id),
  denied_reason       text,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);
create trigger payments_updated_at
  before update on public.payments
  for each row execute function public.set_updated_at();

-- =========================================================
-- ADMIN_LOGS — auditoria append-only
-- =========================================================
create table public.admin_logs (
  id           uuid primary key default gen_random_uuid(),
  admin_id     uuid not null references public.users(id),
  action       text not null,
  target_type  text,
  target_id    uuid,
  payload      jsonb,
  ip           inet,
  created_at   timestamptz default now()
);
create index idx_admin_logs_created on public.admin_logs(created_at desc);

-- =========================================================
-- VIEW: rankings (computa em tempo real a partir de predictions)
-- =========================================================
create or replace view public.rankings as
with totals as (
  select
    p.user_id,
    sum(p.points) as total_points,
    count(*) filter (where p.points = 3) as exact_hits,
    count(*) filter (where p.points = 1) as partial_hits,
    count(*) filter (where p.points = 0 and p.computed_at is not null) as misses,
    count(*) filter (where p.computed_at is not null) as resolved_count
  from public.predictions p
  inner join public.payments pay on pay.user_id = p.user_id and pay.status = 'approved'
  group by p.user_id
)
select
  u.id as user_id,
  u.name,
  u.avatar_url,
  coalesce(t.total_points, 0) as total_points,
  coalesce(t.exact_hits, 0)   as exact_hits,
  coalesce(t.partial_hits, 0) as partial_hits,
  coalesce(t.misses, 0)       as misses,
  coalesce(t.resolved_count, 0) as resolved_count,
  rank() over (
    order by
      coalesce(t.total_points, 0) desc,
      coalesce(t.exact_hits, 0) desc
  ) as position
from public.users u
inner join public.payments pay on pay.user_id = u.id and pay.status = 'approved'
left join totals t on t.user_id = u.id;

-- =========================================================
-- ROW LEVEL SECURITY
-- =========================================================
alter table public.users        enable row level security;
alter table public.groups       enable row level security;
alter table public.teams        enable row level security;
alter table public.matches      enable row level security;
alter table public.predictions  enable row level security;
alter table public.payments     enable row level security;
alter table public.admin_logs   enable row level security;

-- USERS — todos veem seu próprio user; admin vê tudo
create policy "users_self_read" on public.users
  for select using (auth.uid() = id);
create policy "users_admin_read" on public.users
  for select using (
    exists (select 1 from public.users where id = auth.uid() and role = 'admin')
  );

-- GROUPS, TEAMS, MATCHES — leitura pública para autenticados
create policy "groups_authed_read" on public.groups
  for select using (auth.role() = 'authenticated');
create policy "teams_authed_read" on public.teams
  for select using (auth.role() = 'authenticated');
create policy "matches_authed_read" on public.matches
  for select using (auth.role() = 'authenticated');

-- Admin pode tudo em groups/teams/matches
create policy "matches_admin_all" on public.matches
  for all using (
    exists (select 1 from public.users where id = auth.uid() and role = 'admin')
  );

-- PREDICTIONS — usuário só lê e escreve as próprias
create policy "predictions_self_read" on public.predictions
  for select using (auth.uid() = user_id);
create policy "predictions_self_insert" on public.predictions
  for insert with check (auth.uid() = user_id);
create policy "predictions_self_update" on public.predictions
  for update using (auth.uid() = user_id);

-- Admin lê todas as predictions (para calcular pontos/ranking)
create policy "predictions_admin_read" on public.predictions
  for select using (
    exists (select 1 from public.users where id = auth.uid() and role = 'admin')
  );
create policy "predictions_admin_update" on public.predictions
  for update using (
    exists (select 1 from public.users where id = auth.uid() and role = 'admin')
  );

-- PAYMENTS — usuário lê e cria o próprio; admin atualiza status
create policy "payments_self_read" on public.payments
  for select using (auth.uid() = user_id);
create policy "payments_self_insert" on public.payments
  for insert with check (auth.uid() = user_id);
create policy "payments_admin_all" on public.payments
  for all using (
    exists (select 1 from public.users where id = auth.uid() and role = 'admin')
  );

-- ADMIN_LOGS — append-only para admin
create policy "admin_logs_admin_read" on public.admin_logs
  for select using (
    exists (select 1 from public.users where id = auth.uid() and role = 'admin')
  );
create policy "admin_logs_admin_insert" on public.admin_logs
  for insert with check (
    exists (select 1 from public.users where id = auth.uid() and role = 'admin')
  );
-- sem policy de update/delete = bloqueado por padrão

-- =========================================================
-- FUNÇÃO: calcular pontos quando admin insere resultado
-- =========================================================
create or replace function public.compute_match_points(p_match_id uuid)
returns void language plpgsql security definer as $$
declare
  m record;
begin
  select * into m from public.matches where id = p_match_id;
  if m.home_score is null or m.away_score is null then return; end if;

  update public.predictions
  set
    points = case
      when home_score = m.home_score and away_score = m.away_score then 3
      when sign(home_score - away_score) = sign(m.home_score - m.away_score) then 1
      else 0
    end,
    computed_at = now()
  where match_id = p_match_id;
end;
$$;

-- Trigger: recalcula automaticamente quando match.home_score/away_score mudam
create or replace function public.on_match_finalized()
returns trigger language plpgsql as $$
begin
  if new.home_score is not null and new.away_score is not null
     and (old.home_score is distinct from new.home_score or old.away_score is distinct from new.away_score) then
    perform public.compute_match_points(new.id);
  end if;
  return new;
end;
$$;
create trigger matches_compute_points
  after update on public.matches
  for each row execute function public.on_match_finalized();
