import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthedAdmin } from "@/lib/auth";
import type {
  ChampionCandidate,
  ChampionPick,
  KoMatch,
  KoMatchView,
  KoPredictionFields,
  KoRankingRow,
} from "@/lib/types";
import CopaClient from "./CopaClient";

export const dynamic = "force-dynamic";

export default async function CopaPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/copa");

  const [koRes, predsRes, payRes, rankRes, champRes, cfgRes, adminCheck] =
    await Promise.all([
      // Defensivo: antes da migration 0005/0008 ou do 1º ingest pode não existir.
      supabase.from("ko_matches").select("*").order("kickoff_at", { ascending: true }),
      supabase
        .from("ko_predictions")
        .select(
          "ko_match_id,home_score,away_score,pen_home,pen_away,normal_points,pen_points,points,computed_at",
        )
        .eq("user_id", user.id),
      supabase.from("ko_payments").select("status").eq("user_id", user.id).maybeSingle(),
      supabase.from("ko_rankings").select("*").order("position", { ascending: true }).limit(300),
      supabase
        .from("champion_predictions")
        .select("team_iso,team_name,points,computed_at")
        .eq("user_id", user.id)
        .maybeSingle(),
      supabase.from("ko_config").select("champion_lock_at").eq("id", 1).maybeSingle(),
      getAuthedAdmin(),
    ]);

  const ko = (koRes.error ? [] : (koRes.data ?? [])) as KoMatch[];
  const preds = (predsRes.error ? [] : (predsRes.data ?? [])) as (KoPredictionFields & {
    ko_match_id: string;
  })[];
  const paymentStatus =
    (payRes.data?.status as "pending" | "approved" | "denied" | undefined) ?? null;
  const rankings = (rankRes.error ? [] : (rankRes.data ?? [])) as KoRankingRow[];
  const champion = (champRes.data ?? null) as ChampionPick;
  const championLockAt = (cfgRes.data?.champion_lock_at as string | null | undefined) ?? null;
  const isAdmin = !!adminCheck;

  const predByMatch = new Map(preds.map((p) => [p.ko_match_id, p]));
  const matches: KoMatchView[] = ko.map((m) => ({
    ...m,
    prediction: predByMatch.get(m.id) ?? null,
  }));

  // Candidatos a campeão = seleções já presentes no chaveamento (dedup por iso).
  // Antes de os 16avos serem definidos a lista vem vazia; aí o picker fica
  // travado com aviso "aguardando classificados".
  const seen = new Set<string>();
  const candidates: ChampionCandidate[] = [];
  for (const m of ko) {
    for (const t of [
      { iso: m.home_iso, name: m.home_name },
      { iso: m.away_iso, name: m.away_name },
    ]) {
      if (t.iso && t.name && !seen.has(t.iso)) {
        seen.add(t.iso);
        candidates.push({ iso: t.iso, name: t.name });
      }
    }
  }
  candidates.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  return (
    <CopaClient
      user={{
        email: user.email ?? "",
        name:
          (user.user_metadata?.full_name as string | undefined) ??
          (user.user_metadata?.name as string | undefined) ??
          user.email ??
          "",
      }}
      currentUserId={user.id}
      matches={matches}
      paymentStatus={paymentStatus}
      rankings={rankings}
      champion={champion}
      championLockAt={championLockAt}
      candidates={candidates}
      isAdmin={isAdmin}
    />
  );
}
