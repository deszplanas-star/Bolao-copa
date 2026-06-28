import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type {
  Group,
  KoMatch,
  KoMatchView,
  KoPredictionFields,
  KoRankingRow,
  Match,
  MatchView,
  Prediction,
  RankingRow,
  Team,
} from "@/lib/types";
import ApostasClient from "./ApostasClient";

export const dynamic = "force-dynamic";

export default async function ApostasPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/apostas");

  const [
    groupsRes,
    teamsRes,
    matchesRes,
    predsRes,
    paymentRes,
    rankingsRes,
    userRowRes,
    championRes,
    koMatchesRes,
    koPredsRes,
    koRankingsRes,
  ] = await Promise.all([
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
      // Flag de liberação de edição individual. Defensivo: se a coluna ainda
      // não existir (deploy antes da migration), o erro é ignorado e cai em false.
      supabase.from("users").select("edits_unlocked").eq("id", user.id).maybeSingle(),
      // Palpite de campeão de cada apostador — vira a bandeirinha antes do nome
      // no ranking do mata-mata. Só lê iso+nome do time (público entre participantes).
      supabase.from("champion_predictions").select("user_id, team_iso, team_name"),
      // Mata-mata (fase 2): jogos, meus palpites e ranking. Defensivo: antes do
      // 1º ingest/migration as tabelas podem não existir — cai em lista vazia.
      supabase.from("ko_matches").select("*").order("kickoff_at", { ascending: true }),
      supabase
        .from("ko_predictions")
        .select(
          "ko_match_id,home_score,away_score,pen_home,pen_away,normal_points,pen_points,points,computed_at",
        )
        .eq("user_id", user.id),
      supabase.from("ko_rankings").select("*").order("position", { ascending: true }).limit(300),
    ]);

  const groups = (groupsRes.data ?? []) as Group[];
  const teams = (teamsRes.data ?? []) as Team[];
  const matches = (matchesRes.data ?? []) as Match[];
  const preds = (predsRes.data ?? []) as Prediction[];
  const paymentStatus =
    (paymentRes.data?.status as "pending" | "approved" | "denied" | undefined) ?? null;
  const rankings = (rankingsRes.data ?? []) as RankingRow[];
  const editsUnlocked = (userRowRes.data?.edits_unlocked as boolean | undefined) ?? false;

  // user_id → palpite de campeão (bandeira + nome do time) pro ranking do mata-mata.
  const championByUser: Record<string, { iso: string; name: string }> = {};
  for (const c of (championRes.data ?? []) as { user_id: string; team_iso: string | null; team_name: string | null }[]) {
    if (c.team_iso) championByUser[c.user_id] = { iso: c.team_iso, name: c.team_name ?? "" };
  }

  // Mata-mata: jogos + meu palpite de cada jogo, e o ranking da fase 2.
  const koMatchesRaw = (koMatchesRes.error ? [] : (koMatchesRes.data ?? [])) as KoMatch[];
  const koPreds = (koPredsRes.error ? [] : (koPredsRes.data ?? [])) as (KoPredictionFields & {
    ko_match_id: string;
  })[];
  const koRankings = (koRankingsRes.error ? [] : (koRankingsRes.data ?? [])) as KoRankingRow[];
  const koPredByMatch = new Map(koPreds.map((p) => [p.ko_match_id, p]));
  const koMatches: KoMatchView[] = koMatchesRaw.map((m) => ({
    ...m,
    prediction: koPredByMatch.get(m.id) ?? null,
  }));

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
      editsUnlocked={editsUnlocked}
      championByUser={championByUser}
      koMatches={koMatches}
      koRankings={koRankings}
    />
  );
}
