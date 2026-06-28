import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// Palpites de TODOS (entrada do mata-mata aprovada) para um jogo do mata-mata.
// Espelha /api/match-predictions, mas em cima de ko_predictions + ko_payments.
export async function GET(
  _req: NextRequest,
  { params }: { params: { koMatchId: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = createAdminClient();
  if (!db) return NextResponse.json({ error: "DB unavailable" }, { status: 500 });

  const { data, error } = await db
    .from("ko_predictions")
    .select("home_score, away_score, pen_home, pen_away, points, computed_at, user_id")
    .eq("ko_match_id", params.koMatchId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data || data.length === 0) return NextResponse.json({ predictions: [] });

  const userIds = [...new Set(data.map((p) => p.user_id))];
  const [usersRes, paymentsRes] = await Promise.all([
    db.from("users").select("id, name, avatar_url").in("id", userIds),
    db.from("ko_payments").select("user_id").eq("status", "approved").in("user_id", userIds),
  ]);
  const userMap = new Map((usersRes.data ?? []).map((u) => [u.id, u]));
  const approvedIds = new Set((paymentsRes.data ?? []).map((p) => p.user_id));

  const predictions = data
    .filter((p) => approvedIds.has(p.user_id))
    .map((p) => ({
      userId: p.user_id,
      name: userMap.get(p.user_id)?.name ?? "?",
      avatar_url: userMap.get(p.user_id)?.avatar_url ?? null,
      home_score: p.home_score,
      away_score: p.away_score,
      pen_home: p.pen_home,
      pen_away: p.pen_away,
      points: p.points,
      computed: !!p.computed_at,
    }))
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, "pt-BR"));

  return NextResponse.json({ predictions });
}
