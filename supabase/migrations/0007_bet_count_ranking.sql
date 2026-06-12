-- ============================================================
-- 0007 — bet_count na view rankings (badge de entrada tardia)
-- Rodar no SQL Editor do projeto do Bolão:
-- https://supabase.com/dashboard/project/tsecywhgikstgyrgmnos/sql/new
-- ============================================================

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
      coalesce(t.total_points, 0) - u.penalty_points desc,
      coalesce(t.exact_hits, 0) desc
  ) as position,
  u.penalty_points,
  u.penalty_reason,
  coalesce(t.bet_count, 0) as bet_count
from public.users u
inner join public.payments pay on pay.user_id = u.id and pay.status = 'approved'
left join totals t on t.user_id = u.id;

notify pgrst, 'reload schema';

-- prova: atrasados com menos de 72 palpites
select name, bet_count from public.rankings where bet_count < 72 order by bet_count;
