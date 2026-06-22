import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedAdmin } from "@/lib/auth";
import MataMataAdminClient from "./MataMataAdminClient";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type KoPaymentRow = {
  id: string;
  user_id: string;
  amount_cents: number;
  status: "pending" | "approved" | "denied";
  user_confirmed_at: string | null;
  approved_at: string | null;
  denied_reason: string | null;
  created_at: string;
  user: { name: string | null; email: string } | null;
};

export default async function MataMataAdminPage() {
  const admin = await getAuthedAdmin();
  if (!admin) redirect("/copa");

  // Service role pra ler dados de todos os apostadores (bypassa RLS).
  const db = createAdminClient() ?? createClient();

  const [payRes, usersRes, cfgRes, finalRes, champCountRes] = await Promise.all([
    db
      .from("ko_payments")
      .select("id,user_id,amount_cents,status,user_confirmed_at,approved_at,denied_reason,created_at")
      .order("user_confirmed_at", { ascending: false }),
    db.from("users").select("id,name,email"),
    db.from("ko_config").select("champion_lock_at").eq("id", 1).maybeSingle(),
    db
      .from("ko_matches")
      .select("home_name,away_name,home_score,away_score,pen_home,pen_away,status")
      .eq("stage", "FINAL")
      .maybeSingle(),
    db.from("champion_predictions").select("user_id"),
  ]);

  const userById = new Map(
    ((usersRes.data ?? []) as { id: string; name: string | null; email: string }[]).map((u) => [u.id, u]),
  );

  const payments: KoPaymentRow[] = ((payRes.data ?? []) as Omit<KoPaymentRow, "user">[]).map((p) => {
    const u = userById.get(p.user_id);
    return { ...p, user: u ? { name: u.name, email: u.email } : null };
  });

  const championLockAt = (cfgRes.data?.champion_lock_at as string | null | undefined) ?? null;
  const championCount = (champCountRes.data ?? []).length;
  const finalMatch = (finalRes.error ? null : finalRes.data) as
    | {
        home_name: string | null;
        away_name: string | null;
        home_score: number | null;
        away_score: number | null;
        pen_home: number | null;
        pen_away: number | null;
        status: string;
      }
    | null;

  return (
    <MataMataAdminClient
      adminName={admin.name}
      payments={payments}
      championLockAt={championLockAt}
      championCount={championCount}
      finalMatch={finalMatch}
    />
  );
}
