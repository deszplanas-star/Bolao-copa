-- Liberação de edição POR USUÁRIO.
-- Flag concedida manualmente pelo admin pra deixar UMA pessoa reeditar os
-- próprios palpites mesmo com a aposta selada/aprovada — sem reabrir jogo pra
-- todo mundo (diferente de matches.reopened) e independente do pagamento.
-- A trava de horário (apito de cada jogo) continua valendo no servidor.

alter table public.users
  add column if not exists edits_unlocked boolean not null default false;

-- Como usar (no SQL Editor):
--   Liberar:  update public.users set edits_unlocked = true  where lower(email) = 'pessoa@exemplo.com';
--   Re-travar: update public.users set edits_unlocked = false where lower(email) = 'pessoa@exemplo.com';
