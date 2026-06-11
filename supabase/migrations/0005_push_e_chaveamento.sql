-- ============================================================
-- 0005 — Push de gols (PWA) + chaveamento (fases eliminatórias)
-- Rodar no SQL Editor do dashboard (conta do Bolão):
-- https://supabase.com/dashboard/project/tsecywhgikstgyrgmnos/sql/new
-- ============================================================

-- Inscrições de push (uma por navegador/dispositivo instalado)
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  endpoint    text unique not null,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;

create policy "push_select_own" on public.push_subscriptions
  for select to authenticated using (auth.uid() = user_id);
create policy "push_insert_own" on public.push_subscriptions
  for insert to authenticated with check (auth.uid() = user_id);
create policy "push_delete_own" on public.push_subscriptions
  for delete to authenticated using (auth.uid() = user_id);

-- Jogos das fases eliminatórias (espelho da football-data.org; somente
-- leitura no app — quem escreve é o ingest com service role)
create table if not exists public.ko_matches (
  id          uuid primary key default gen_random_uuid(),
  fd_id       bigint unique not null,          -- id do jogo na football-data
  stage       text not null,                   -- LAST_32 | LAST_16 | QUARTER_FINALS | SEMI_FINALS | THIRD_PLACE | FINAL
  home_name   text,
  away_name   text,
  home_iso    text,                            -- iso p/ bandeira (flagcdn), null até definir
  away_iso    text,
  kickoff_at  timestamptz,
  home_score  int,
  away_score  int,
  pen_home    int,                             -- placar dos pênaltis, se houver
  pen_away    int,
  status      text not null default 'scheduled',
  updated_at  timestamptz not null default now()
);

alter table public.ko_matches enable row level security;

create policy "ko_select_authenticated" on public.ko_matches
  for select to authenticated using (true);

notify pgrst, 'reload schema';
