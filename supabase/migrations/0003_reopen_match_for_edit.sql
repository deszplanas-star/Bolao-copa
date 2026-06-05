-- ============================================================
-- Bolão 26 — Reabertura cirúrgica de jogos + correção de seleção
-- Contexto: o Grupo A estava com "Dinamarca" quando o correto é
-- "República Tcheca". Quem já pagou/finalizou precisa poder corrigir
-- APENAS os placares dos jogos dessa seleção.
-- ============================================================

-- 1) Interruptor por jogo: quando true, mesmo apostas já seladas
--    podem reeditar o palpite deste jogo (até a trava de tempo do apito).
alter table public.matches
  add column if not exists reopened boolean not null default false;

-- 2) Correção da seleção no banco ao vivo (idempotente).
--    O id (uuid) do time NÃO muda → jogos e palpites continuam válidos.
update public.teams
set iso_code = 'cz', name = 'República Tcheca'
where iso_code = 'dk';

-- 3) Reabre só os jogos da seleção corrigida que ainda não começaram.
update public.matches m
set reopened = true
from public.teams t
where t.iso_code = 'cz'
  and (m.home_team_id = t.id or m.away_team_id = t.id)
  and m.status = 'scheduled';

-- Rollback:
--   update public.matches set reopened = false;
--   (e, se preciso, reverter o nome:)
--   update public.teams set iso_code='dk', name='Dinamarca' where iso_code='cz';
