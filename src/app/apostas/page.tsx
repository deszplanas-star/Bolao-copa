import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Group, Match, MatchView, Prediction, RankingRow, Team } from "@/lib/types";
import ApostasClient from "./ApostasClient";

export const dynamic = "force-dynamic";

export default async function ApostasPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/apostas");

  const [groupsRes, teamsRes, matchesRes, predsRes, paymentRes, rankingsRes] = await Promise.all([
    supabase.from("groups").select("*").order("ord", { ascending: true }),
    supabase.from("teams").select("*"),
    supabase.from("matches").select("*").order("kickoff_at", { ascending: true }),
    supabase
      .from("predictions")
      .select("id,user_id,match_id,home_score,away_score,points,computed_at")
      .eq("user_id", user.id),
    supabase
      .from("payments")
      .select("status")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("rankings")
      .select("*")
      .order("position", { ascending: true })
      .limit(200),
  ]);

  const groups = (groupsRes.data ?? []) as Group[];
  const teams = (teamsRes.data ?? []) as Team[];
  const matches = (matchesRes.data ?? []) as Match[];
  const preds = (predsRes.data ?? []) as Prediction[];
  const paymentStatus =
    (paymentRes.data?.status as "pending" | "approved" | "denied" | undefined) ?? null;
  const rankings = (rankingsRes.data ?? []) as RankingRow[];

  const teamById = new Map(teams.map((t) => [t.id, t]));
  const predByMatch = new Map(preds.map((p) => [p.match_id, p]));

  const matchViews: MatchView[] = matches
    .map((m) => {
      const home = teamById.get(m.home_team_id);
      const away = teamById.get(m.away_team_id);
      if (!home || !away) return null;
      const p = predByMatch.get(m.id);
      return {
        ...m,
        home,
        away,
        prediction: p
          ? {
              home_score: p.home_score,
              away_score: p.away_score,
              points: p.points,
              computed_at: p.computed_at,
            }
          : null,
      } satisfies MatchView;
    })
    .filter((m): m is MatchView => m !== null);

  return (
    <ApostasClient
      user={{
        email: user.email ?? "",
        name:
          (user.user_metadata?.full_name as string | undefined) ??
          (user.user_metadata?.name as string | undefined) ??
          user.email ??
          "",
      }}
      groups={groups}
      teams={teams}
      matches={matchViews}
      paymentStatus={paymentStatus}
      rankings={rankings}
      currentUserId={user.id}
    />
  );
}
