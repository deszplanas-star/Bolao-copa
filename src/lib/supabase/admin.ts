import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Cliente Supabase com SERVICE ROLE — BYPASSA o RLS por completo.
 *
 * Usar SOMENTE no servidor, dentro de server actions já protegidas por
 * `getAuthedAdmin()`. NUNCA importar isto em componente client nem expor a key.
 *
 * Existe porque as ações de admin precisam escrever/ler dados de OUTROS
 * usuários (ex.: edits_unlocked em users, PDF de palpites alheios), e o cliente
 * de sessão (anon + cookies) aplica RLS como o usuário logado — o que exigiria
 * role='admin' no banco + policy de UPDATE em cada tabela. Com a service role,
 * nada disso é necessário.
 *
 * Retorna null se SUPABASE_SERVICE_ROLE_KEY não estiver no ambiente (Vercel),
 * pra quem chama devolver um erro claro em vez de falhar em silêncio.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return createSupabaseClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
