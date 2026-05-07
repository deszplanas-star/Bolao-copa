import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthedAdmin } from "@/lib/auth";
import type { Group, Match, Team } from "@/lib/types";
import AdminClient from "./AdminClient";

export const dynamic = "force-dynamic";

type PaymentRow = {
  id: string;
  user_id: string;
  amount_cents: number;
  status: "pending" | "approved" | "denied";
  user_confirmed_at: string | null;
  approved_at: string | null;
  denied_reason: string | null;
  created_at: string;
};

type UserRow = {
  id: string;
  email: string;
  name: string | null;
};

export default async function AdminPage() {
  const admin = await getAuthedAdmin();
  if (!admin) redirect("/apostas");

  const supabase = createClient();

  const [paymentsRes, usersRes, groupsRes, teamsRes, matchesRes] = await Promise.all([
    supabase
      .from("payments")
      .select(
        "id,user_id,amount_cents,status,user_confirmed_at,approved_at,denied_reason,created_at",
      )
      .order("user_confirmed_at", { ascending: false }),
    supabase.from("users").select("id,email,name"),
    supabase.from("groups").select("*").order("ord", { ascending: true }),
    supabase.from("teams").select("*"),
    supabase.from("matches").select("*").order("kickoff_at", { ascending: true }),
  ]);

  const payments = (paymentsRes.data ?? []) as PaymentRow[];
  const users = (usersRes.data ?? []) as UserRow[];
  const groups = (groupsRes.data ?? []) as Group[];
  const teams = (teamsRes.data ?? []) as Team[];
  const matches = (matchesRes.data ?? []) as Match[];

  const userById = new Map(users.map((u) => [u.id, u]));
  const teamById = new Map(teams.map((t) => [t.id, t]));

  const enrichedPayments = payments.map((p) => ({
    ...p,
    user: userById.get(p.user_id) ?? null,
  }));

  const enrichedMatches = matches
    .map((m) => {
      const home = teamById.get(m.home_team_id);
      const away = teamById.get(m.away_team_id);
      if (!home || !away) return null;
      return { ...m, home, away };
    })
    .filter(<T,>(x: T | null): x is T => x !== null);

  return (
    <AdminClient
      admin={admin}
      payments={enrichedPayments}
      groups={groups}
      matches={enrichedMatches}
    />
  );
}
