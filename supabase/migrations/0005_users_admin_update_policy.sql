-- A tabela public.users só tinha policies de SELECT (self + admin). Faltava
-- uma policy de UPDATE, então NENHUMA escrita em users passava pelo RLS — nem
-- de admin. Isso bloqueava o botão "Liberar edição" (que faz UPDATE em
-- users.edits_unlocked de outro apostador), retornando 0 linhas.
--
-- Mesmo padrão de checagem das demais policies de admin do schema 0001
-- (exists em users onde id = auth.uid() e role = 'admin'); o subselect resolve
-- pela policy users_self_read, sem recursão.

create policy "users_admin_update" on public.users
  for update
  using (exists (select 1 from public.users where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from public.users where id = auth.uid() and role = 'admin'));

-- Rollback: drop policy "users_admin_update" on public.users;
