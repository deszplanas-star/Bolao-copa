-- ============================================================
-- 0008 — FASE 2: Bolão do Mata-Mata (16avos → Final) + Campeão
-- Rodar no SQL Editor do projeto do Bolão:
-- https://supabase.com/dashboard/project/tsecywhgikstgyrgmnos/sql/new
--
-- ⚠️ ISOLAMENTO TOTAL: esta migration NÃO altera nenhuma tabela da fase 1
-- (matches / predictions / payments / rankings). Só CRIA objetos novos.
-- Se algo aqui der errado, o bolão da fase de grupos não é afetado.
--
-- ⚠️ ORDEM: rodar esta migration ANTES de publicar o deploy com a /copa.
-- Verificável depois: GET /rest/v1/ko_predictions?select=id&limit=1 (sem 42P01).
--
-- Reaproveita do schema 0001: enum payment_status ('pending'/'approved'/'denied')
-- e a função public.set_updated_at(). A tabela ko_matches vem do 0005 (espelho
-- da football-data, alimentado pelo cron-ingest de 1 em 1 min).
-- ============================================================

-- =========================================================
-- 1) KO_PREDICTIONS — palpite por jogo do mata-mata
--    4 placares OBRIGATÓRIOS: tempo normal/prorrogação (home/away)
--    + pênaltis (home/away). Pênalti é seguro: sempre preenchido,
--    mas só pontua se o jogo de fato foi pra pênaltis.
-- =========================================================
create table if not exists public.ko_predictions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  ko_match_id   uuid not null references public.ko_matches(id) on delete cascade,
  -- placar do tempo normal + prorrogação (o que a football-data manda em fullTime)
  home_score    int not null check (home_score between 0 and 99),
  away_score    int not null check (away_score between 0 and 99),
  -- placar dos pênaltis (obrigatório no palpite; só conta se houver disputa)
  pen_home      int not null check (pen_home between 0 and 99),
  pen_away      int not null check (pen_away between 0 and 99),
  -- pontuação desmembrada (normal + pênalti) p/ ranking honesto e desempate
  normal_points int not null default 0,
  pen_points    int not null default 0,
  points        int not null default 0,   -- = normal_points + pen_points
  computed_at   timestamptz,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique (user_id, ko_match_id)
);
create index if not exists idx_ko_pred_user  on public.ko_predictions(user_id);
create index if not exists idx_ko_pred_match on public.ko_predictions(ko_match_id);

drop trigger if exists ko_predictions_updated_at on public.ko_predictions;
create trigger ko_predictions_updated_at
  before update on public.ko_predictions
  for each row execute function public.set_updated_at();

-- =========================================================
-- 2) CHAMPION_PREDICTIONS — 1 palpite de campeão por pessoa (+5 pts)
--    Guarda iso (bandeira) + nome. Trava no apito do 1º jogo dos 16avos
--    (controlado pela ko_config; checagem fica no server action).
-- =========================================================
create table if not exists public.champion_predictions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid unique not null references public.users(id) on delete cascade,
  team_iso      text not null,            -- ex: 'br', 'gb-eng' (casa com o ko_matches.*_iso)
  team_name     text not null,
  points        int not null default 0,   -- 5 se acertar, senão 0
  computed_at   timestamptz,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

drop trigger if exists champion_predictions_updated_at on public.champion_predictions;
create trigger champion_predictions_updated_at
  before update on public.champion_predictions
  for each row execute function public.set_updated_at();

-- =========================================================
-- 3) KO_PAYMENTS — entrada paga da fase 2 (PIX manual, R$50)
--    Tabela SEPARADA da fase 1: quem jogou os grupos paga de novo;
--    quem não jogou pode entrar agora. Mesmo fluxo de aprovação humana.
-- =========================================================
create table if not exists public.ko_payments (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid unique not null references public.users(id) on delete cascade,
  amount_cents        int not null default 5000,    -- R$50,00
  status              payment_status not null default 'pending',
  user_confirmed_at   timestamptz,
  approved_at         timestamptz,
  approved_by         uuid references public.users(id),
  denied_reason       text,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

drop trigger if exists ko_payments_updated_at on public.ko_payments;
create trigger ko_payments_updated_at
  before update on public.ko_payments
  for each row execute function public.set_updated_at();

-- =========================================================
-- 4) KO_CONFIG — configuração de linha única da fase 2
--    champion_lock_at = momento em que o palpite de campeão trava.
--    Default: 1º kickoff dos 16avos já conhecido no ko_matches (pode ser NULL
--    se o chaveamento ainda não tiver horário — admin define depois na aba).
-- =========================================================
create table if not exists public.ko_config (
  id                int primary key default 1 check (id = 1),  -- garante linha única
  champion_lock_at  timestamptz,
  updated_at        timestamptz default now()
);

drop trigger if exists ko_config_updated_at on public.ko_config;
create trigger ko_config_updated_at
  before update on public.ko_config
  for each row execute function public.set_updated_at();

insert into public.ko_config (id, champion_lock_at)
values (1, (select min(kickoff_at) from public.ko_matches
            where stage = 'LAST_32' and kickoff_at is not null))
on conflict (id) do nothing;

-- =========================================================
-- 5) PONTUAÇÃO — recalcula os palpites de UM jogo do mata-mata
--    Normal/prorrogação: 3 exato · 1 resultado · 0 errou.
--    Pênaltis (só se m.pen_* preenchido): +3 exato · +1 vencedor · 0.
--    points = normal_points + pen_points (até 6 num jogo de pênalti).
-- =========================================================
create or replace function public.compute_ko_match_points(p_ko_match_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  m record;
begin
  select * into m from public.ko_matches where id = p_ko_match_id;
  if m.home_score is null or m.away_score is null then return; end if;

  update public.ko_predictions p
  set
    normal_points = case
      when p.home_score = m.home_score and p.away_score = m.away_score then 3
      when sign(p.home_score - p.away_score) = sign(m.home_score - m.away_score) then 1
      else 0
    end,
    pen_points = case
      when m.pen_home is null or m.pen_away is null then 0
      when p.pen_home = m.pen_home and p.pen_away = m.pen_away then 3
      when sign(p.pen_home - p.pen_away) = sign(m.pen_home - m.pen_away) then 1
      else 0
    end,
    points =
      (case
        when p.home_score = m.home_score and p.away_score = m.away_score then 3
        when sign(p.home_score - p.away_score) = sign(m.home_score - m.away_score) then 1
        else 0
      end)
      +
      (case
        when m.pen_home is null or m.pen_away is null then 0
        when p.pen_home = m.pen_home and p.pen_away = m.pen_away then 3
        when sign(p.pen_home - p.pen_away) = sign(m.pen_home - m.pen_away) then 1
        else 0
      end),
    computed_at = now()
  where p.ko_match_id = p_ko_match_id;
end;
$$;

-- Apura o bônus de campeão a partir do vencedor da FINAL (inclui pênaltis).
-- Roda quando a FINAL ganha placar; idempotente (pode rodar várias vezes).
create or replace function public.compute_champion()
returns void language plpgsql security definer set search_path = public as $$
declare
  f record;
  champ_iso text;
begin
  select * into f
    from public.ko_matches
   where stage = 'FINAL'
     and home_score is not null and away_score is not null
   order by updated_at desc
   limit 1;
  if not found then return; end if;

  if f.home_score > f.away_score then
    champ_iso := f.home_iso;
  elsif f.away_score > f.home_score then
    champ_iso := f.away_iso;
  elsif f.pen_home is not null and f.pen_away is not null then
    champ_iso := case when f.pen_home > f.pen_away then f.home_iso else f.away_iso end;
  else
    return;  -- empatou e ainda não tem pênaltis: espera o próximo ingest
  end if;

  update public.champion_predictions
     set points = case when lower(team_iso) = lower(champ_iso) then 5 else 0 end,
         computed_at = now();
end;
$$;

-- Conveniência: recalcula TODOS os jogos já finalizados + campeão (uso no admin
-- ou após corrigir um placar à mão).
create or replace function public.recompute_all_ko()
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select id from public.ko_matches
            where home_score is not null and away_score is not null loop
    perform public.compute_ko_match_points(r.id);
  end loop;
  perform public.compute_champion();
end;
$$;

-- Trigger: o cron-ingest faz UPSERT em ko_matches a cada minuto. Quando um
-- placar (normal ou pênalti) muda, recalcula os palpites do jogo; se foi a
-- FINAL, recalcula o campeão.
create or replace function public.on_ko_match_change()
returns trigger language plpgsql as $$
begin
  if new.home_score is not null and new.away_score is not null then
    perform public.compute_ko_match_points(new.id);
    if new.stage = 'FINAL' then
      perform public.compute_champion();
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists ko_matches_compute_points on public.ko_matches;
create trigger ko_matches_compute_points
  after insert or update on public.ko_matches
  for each row execute function public.on_ko_match_change();

-- =========================================================
-- 6) VIEW: ko_rankings — só conta quem tem ko_payments aprovado.
--    total = soma dos pontos dos jogos + bônus de campeão.
--    Desempate: mais placares exatos no tempo normal (normal_points = 3).
-- =========================================================
create or replace view public.ko_rankings as
with ko as (
  select
    p.user_id,
    sum(p.points)                                          as ko_points,
    count(*) filter (where p.normal_points = 3)            as exact_hits,
    count(*) filter (where p.pen_points = 3)               as pen_exact_hits,
    count(*) filter (where p.computed_at is not null)      as resolved_count,
    count(*)                                               as bet_count
  from public.ko_predictions p
  inner join public.ko_payments pay
          on pay.user_id = p.user_id and pay.status = 'approved'
  group by p.user_id
)
select
  u.id        as user_id,
  u.name,
  u.avatar_url,
  coalesce(k.ko_points, 0) + coalesce(c.points, 0) as total_points,
  coalesce(k.exact_hits, 0)      as exact_hits,
  coalesce(k.pen_exact_hits, 0)  as pen_exact_hits,
  coalesce(k.resolved_count, 0)  as resolved_count,
  coalesce(k.bet_count, 0)       as bet_count,
  coalesce(c.points, 0)          as champion_points,
  c.team_name                    as champion_pick,
  rank() over (
    order by
      coalesce(k.ko_points, 0) + coalesce(c.points, 0) desc,
      coalesce(k.exact_hits, 0) desc
  ) as position
from public.users u
inner join public.ko_payments pay
        on pay.user_id = u.id and pay.status = 'approved'
left join ko k on k.user_id = u.id
left join public.champion_predictions c on c.user_id = u.id;

-- =========================================================
-- 7) ROW LEVEL SECURITY
--    Mesmo padrão da fase 1: cada um lê/escreve o próprio; admin enxerga tudo.
--    (Triggers e o cron rodam como service role / SECURITY DEFINER e ignoram RLS.)
-- =========================================================
alter table public.ko_predictions      enable row level security;
alter table public.champion_predictions enable row level security;
alter table public.ko_payments          enable row level security;
alter table public.ko_config            enable row level security;

-- KO_PREDICTIONS
create policy "ko_pred_self_read"   on public.ko_predictions
  for select using (auth.uid() = user_id);
create policy "ko_pred_self_insert" on public.ko_predictions
  for insert with check (auth.uid() = user_id);
create policy "ko_pred_self_update" on public.ko_predictions
  for update using (auth.uid() = user_id);
create policy "ko_pred_admin_read"  on public.ko_predictions
  for select using (exists (select 1 from public.users where id = auth.uid() and role = 'admin'));
create policy "ko_pred_admin_update" on public.ko_predictions
  for update using (exists (select 1 from public.users where id = auth.uid() and role = 'admin'));

-- CHAMPION_PREDICTIONS
create policy "champ_self_read"   on public.champion_predictions
  for select using (auth.uid() = user_id);
create policy "champ_self_insert" on public.champion_predictions
  for insert with check (auth.uid() = user_id);
create policy "champ_self_update" on public.champion_predictions
  for update using (auth.uid() = user_id);
create policy "champ_admin_read"  on public.champion_predictions
  for select using (exists (select 1 from public.users where id = auth.uid() and role = 'admin'));
create policy "champ_admin_update" on public.champion_predictions
  for update using (exists (select 1 from public.users where id = auth.uid() and role = 'admin'));

-- KO_PAYMENTS
create policy "ko_pay_self_read"   on public.ko_payments
  for select using (auth.uid() = user_id);
create policy "ko_pay_self_insert" on public.ko_payments
  for insert with check (auth.uid() = user_id);
create policy "ko_pay_admin_all"   on public.ko_payments
  for all using (exists (select 1 from public.users where id = auth.uid() and role = 'admin'));

-- KO_CONFIG — leitura p/ autenticados; escrita só admin
create policy "ko_config_authed_read" on public.ko_config
  for select using (auth.role() = 'authenticated');
create policy "ko_config_admin_all"   on public.ko_config
  for all using (exists (select 1 from public.users where id = auth.uid() and role = 'admin'));

-- =========================================================
notify pgrst, 'reload schema';

-- =========================================================
-- PROVA (rodar junto; deve retornar sem erro):
-- =========================================================
-- 1) tabelas criadas:
select 'ko_predictions' as obj, count(*) from public.ko_predictions
union all select 'champion_predictions', count(*) from public.champion_predictions
union all select 'ko_payments', count(*) from public.ko_payments;
-- 2) config (champion_lock_at pode vir NULL se os 16avos ainda não têm horário):
select * from public.ko_config;
-- 3) view responde:
select * from public.ko_rankings limit 1;

-- =========================================================
-- ROLLBACK (se precisar desfazer — não toca em nada da fase 1):
-- =========================================================
-- drop view if exists public.ko_rankings;
-- drop trigger if exists ko_matches_compute_points on public.ko_matches;
-- drop function if exists public.on_ko_match_change();
-- drop function if exists public.recompute_all_ko();
-- drop function if exists public.compute_champion();
-- drop function if exists public.compute_ko_match_points(uuid);
-- drop table if exists public.ko_predictions;
-- drop table if exists public.champion_predictions;
-- drop table if exists public.ko_payments;
-- drop table if exists public.ko_config;
-- notify pgrst, 'reload schema';
