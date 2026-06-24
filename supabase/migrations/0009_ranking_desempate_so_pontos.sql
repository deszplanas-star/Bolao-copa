-- ============================================================
-- 0009 — Ranking: empate por PONTOS divide igual (sem desempate por exatos)
-- Antes (0007/0008): rank() desempatava por exact_hits, então quem tinha os
-- mesmos pontos mas mais placares exatos ficava em posição melhor e levava
-- prêmio maior — não "empatava" de fato. Regra nova: mesmos pontos = mesma
-- posição = dividem o prêmio igualmente (o calcPrizes do app já soma e divide).
-- Rodar no SQL Editor do projeto do Bolão:
-- https://supabase.com/dashboard/project/tsecywhgikstgyrgmnos/sql/new
-- ============================================================

-- 1) View da fase de grupos (a que alimenta a tela de prêmios)
create or replace view public.rankings as
with totals as (
  select
    p.user_id,
    sum(p.points) as total_points,
    count(*) filter (where p.points = 3) as exact_hits,
    count(*) filter (where p.points = 1) as partial_hits,
    count(*) filter (where p.points = 0 and p.computed_at is not null) as misses,
    count(*) filter (where p.computed_at is not null) as resolved_count,
    count(*) as bet_count
  from public.predictions p
  inner join public.payments pay on pay.user_id = p.user_id and pay.status = 'approved'
  group by p.user_id
)
select
  u.id as user_id,
  u.name,
  u.avatar_url,
  coalesce(t.total_points, 0) - u.penalty_points as total_points,
  coalesce(t.exact_hits, 0)   as exact_hits,
  coalesce(t.partial_hits, 0) as partial_hits,
  coalesce(t.misses, 0)       as misses,
  coalesce(t.resolved_count, 0) as resolved_count,
  rank() over (
    order by
      coalesce(t.total_points, 0) - u.penalty_points desc
  ) as position,
  u.penalty_points,
  u.penalty_reason,
  coalesce(t.bet_count, 0) as bet_count
from public.users u
inner join public.payments pay on pay.user_id = u.id and pay.status = 'approved'
left join totals t on t.user_id = u.id;

-- 2) View do mata-mata (fase 2) — mesma regra, sem desempate por exatos
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
      coalesce(k.ko_points, 0) + coalesce(c.points, 0) desc
  ) as position
from public.users u
inner join public.ko_payments pay
        on pay.user_id = u.id and pay.status = 'approved'
left join ko k on k.user_id = u.id
left join public.champion_predictions c on c.user_id = u.id;

notify pgrst, 'reload schema';

-- prova: posições e empates por pontos
select position, name, total_points, exact_hits from public.rankings order by position, name limit 30;
