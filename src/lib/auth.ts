import { createClient } from "@/lib/supabase/server";

export type AuthedAdmin = {
  id: string;
  email: string;
  name: string;
};

/**
 * Retorna o admin autenticado, ou null.
 * Considera admin quem tem `role = 'admin'` OU está em `ADMIN_EMAILS` (CSV no env).
 * `ADMIN_EMAILS` serve de bootstrap antes de existir um admin no banco.
 */
export async function getAuthedAdmin(): Promise<AuthedAdmin | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) return null;

  const adminEmails = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const isBootstrapAdmin = adminEmails.includes(user.email.toLowerCase());

  let isRoleAdmin = false;
  if (!isBootstrapAdmin) {
    const { data } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    isRoleAdmin = (data as { role?: string } | null)?.role === "admin";
  }

  if (!isBootstrapAdmin && !isRoleAdmin) return null;

  return {
    id: user.id,
    email: user.email,
    name:
      (user.user_metadata?.full_name as string | undefined) ??
      (user.user_metadata?.name as string | undefined) ??
      user.email,
  };
}
