import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendPushEvents, type PushEvent } from "@/lib/push";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ============================================================
// Ingest de resultados rodando NA VERCEL, disparado pelo n8n a cada
// 1 min (o cron do GitHub grátis atrasava horas). Mesma lógica do
// scripts/ingest-results.mjs: football-data.org → matches (placar ao
// vivo + push de gol) e fases eliminatórias → ko_matches.
// Auth: Bearer = SUPABASE_SERVICE_ROLE_KEY.
// ============================================================

const TLA_TO_ISO: Record<string, string> = {
  MEX: "mx", CZE: "cz", KOR: "kr", RSA: "za",
  SUI: "ch", CAN: "ca", BIH: "ba", QAT: "qa",
  BRA: "br", MAR: "ma", SCO: "gb-sct", HAI: "ht",
  USA: "us", PAR: "py", AUS: "au", TUR: "tr",
  GER: "de", ECU: "ec", CIV: "ci", CUW: "cw",
  NED: "nl", JPN: "jp", SWE: "se", TUN: "tn",
  BEL: "be", EGY: "eg", IRN: "ir", NZL: "nz",
  ESP: "es", URY: "uy", CPV: "cv", KSA: "sa",
  FRA: "fr", NOR: "no", SEN: "sn", IRQ: "iq",
  ARG: "ar", AUT: "at", ALG: "dz", JOR: "jo",
  POR: "pt", COL: "co", UZB: "uz", COD: "cd",
  ENG: "gb-eng", CRO: "hr", GHA: "gh", PAN: "pa",
};
const TLA_TO_NAME: Record<string, string> = {
  MEX: "México", CZE: "Rep. Tcheca", KOR: "Coreia do Sul", RSA: "África do Sul",
  SUI: "Suíça", CAN: "Canadá", BIH: "Bósnia", QAT: "Catar",
  BRA: "Brasil", MAR: "Marrocos", SCO: "Escócia", HAI: "Haiti",
  USA: "Estados Unidos", PAR: "Paraguai", AUS: "Austrália", TUR: "Turquia",
  GER: "Alemanha", ECU: "Equador", CIV: "Costa do Marfim", CUW: "Curaçau",
  NED: "Holanda", JPN: "Japão", SWE: "Suécia", TUN: "Tunísia",
  BEL: "Bélgica", EGY: "Egito", IRN: "Irã", NZL: "Nova Zelândia",
  ESP: "Espanha", URY: "Uruguai", CPV: "Cabo Verde", KSA: "Arábia Saudita",
  FRA: "França", NOR: "Noruega", SEN: "Senegal", IRQ: "Iraque",
  ARG: "Argentina", AUT: "Áustria", ALG: "Argélia", JOR: "Jordânia",
  POR: "Portugal", COL: "Colômbia", UZB: "Uzbequistão", COD: "RD Congo",
  ENG: "Inglaterra", CRO: "Croácia", GHA: "Gana", PAN: "Panamá",
};
const LIVE = new Set(["IN_PLAY", "PAUSED"]);
const DONE = new Set(["FINISHED"]);

const WINDOW_START = Date.parse("2026-06-10T00:00:00Z");
const WINDOW_END = Date.parse("2026-07-20T23:59:59Z");

type FdMatch = {
  id: number;
  stage: string;
  status: string;
  utcDate?: string;
  homeTeam?: { tla?: string; name?: string };
  awayTeam?: { tla?: string; name?: string };
  score?: {
    fullTime?: { home: number | null; away: number | null };
    penalties?: { home: number | null; away: number | null };
  };
};

function pairKey(a: string, b: string) {
  return [a, b].sort().join("|");
}

async function run(req: NextRequest) {
  const expected = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const got = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || got !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  if (now < WINDOW_START || now > WINDOW_END) {
    return NextResponse.json({ skip: "fora da janela do torneio" });
  }

  const token = process.env.FOOTBALL_DATA_TOKEN?.trim();
  if (!token) {
    return NextResponse.json({ error: "FOOTBALL_DATA_TOKEN ausente" }, { status: 500 });
  }
  const db = createAdminClient();
  if (!db) return NextResponse.json({ error: "service role ausente" }, { status: 500 });

  const fd = await fetch("https://api.football-data.org/v4/competitions/WC/matches", {
    headers: { "X-Auth-Token": token },
    cache: "no-store",
  });
  if (!fd.ok) {
    return NextResponse.json(
      { error: `football-data ${fd.status}: ${(await fd.text()).slice(0, 200)}` },
      { status: 502 },
    );
  }
  const { matches: apiMatches } = (await fd.json()) as { matches: FdMatch[] };

  const [{ data: teams }, { data: ours }] = await Promise.all([
    db.from("teams").select("id, iso_code"),
    db
      .from("matches")
      .select("id, home_team_id, away_team_id, home_score, away_score, status"),
  ]);
  const isoToId = new Map((teams ?? []).map((t) => [t.iso_code as string, t.id as string]));
  const byPair = new Map(
    (ours ?? []).map((m) => [pairKey(m.home_team_id as string, m.away_team_id as string), m]),
  );

  let updated = 0;
  let koUpserts = 0;
  const problems: string[] = [];
  const pushEvents: PushEvent[] = [];

  for (const am of apiMatches) {
    // ---- mata-mata → ko_matches (espelho, atualiza sempre que mudar) ----
    if (am.stage !== "GROUP_STAGE") {
      const homeTla = am.homeTeam?.tla ?? null;
      const awayTla = am.awayTeam?.tla ?? null;
      const { error } = await db.from("ko_matches").upsert(
        {
          fd_id: am.id,
          stage: am.stage,
          home_name: homeTla ? (TLA_TO_NAME[homeTla] ?? am.homeTeam?.name) : null,
          away_name: awayTla ? (TLA_TO_NAME[awayTla] ?? am.awayTeam?.name) : null,
          home_iso: homeTla ? (TLA_TO_ISO[homeTla] ?? null) : null,
          away_iso: awayTla ? (TLA_TO_ISO[awayTla] ?? null) : null,
          kickoff_at: am.utcDate ?? null,
          home_score: am.score?.fullTime?.home ?? null,
          away_score: am.score?.fullTime?.away ?? null,
          pen_home: am.score?.penalties?.home ?? null,
          pen_away: am.score?.penalties?.away ?? null,
          status: DONE.has(am.status) ? "finished" : LIVE.has(am.status) ? "live" : "scheduled",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "fd_id" },
      );
      if (error) problems.push(`ko ${am.id}: ${error.message.slice(0, 80)}`);
      else koUpserts++;
      continue;
    }

    // ---- fase de grupos → matches + push de gol ----
    const isLive = LIVE.has(am.status);
    const isDone = DONE.has(am.status);
    if (!isLive && !isDone) continue;

    const hs = am.score?.fullTime?.home;
    const as = am.score?.fullTime?.away;
    if (hs == null || as == null) continue;

    const tidHome = isoToId.get(TLA_TO_ISO[am.homeTeam?.tla ?? ""] ?? "");
    const tidAway = isoToId.get(TLA_TO_ISO[am.awayTeam?.tla ?? ""] ?? "");
    if (!tidHome || !tidAway) {
      problems.push(`sem mapa: ${am.homeTeam?.tla} x ${am.awayTeam?.tla}`);
      continue;
    }
    const mine = byPair.get(pairKey(tidHome, tidAway));
    if (!mine) {
      problems.push(`sem jogo no banco: ${am.homeTeam?.tla} x ${am.awayTeam?.tla}`);
      continue;
    }

    // Traduz pro mando/visitante do NOSSO jogo (pode estar invertido)
    const ourHome = mine.home_team_id === tidHome ? hs : as;
    const ourAway = mine.home_team_id === tidHome ? as : hs;
    const newStatus = isDone ? "finished" : (mine.status as string);
    const same =
      mine.home_score === ourHome && mine.away_score === ourAway && mine.status === newStatus;
    if (same) continue;

    const body: Record<string, unknown> = {
      home_score: ourHome,
      away_score: ourAway,
      status: newStatus,
    };
    if (isDone) body.finalized_at = new Date().toISOString();
    const { error } = await db.from("matches").update(body).eq("id", mine.id as string);
    if (error) {
      problems.push(`update ${am.id}: ${error.message.slice(0, 80)}`);
      continue;
    }
    updated++;

    const homeName = TLA_TO_NAME[am.homeTeam?.tla ?? ""] ?? am.homeTeam?.name ?? "?";
    const awayName = TLA_TO_NAME[am.awayTeam?.tla ?? ""] ?? am.awayTeam?.name ?? "?";
    const scoreChanged = mine.home_score !== ourHome || mine.away_score !== ourAway;
    if (isDone) {
      pushEvents.push({
        title: "Fim de jogo! 🏁",
        body: `${homeName} ${hs} × ${as} ${awayName} — confira seus pontos no ranking`,
        tag: `fim-${am.id}`,
        url: "/apostas?tab=ranking",
      });
    } else if (scoreChanged) {
      pushEvents.push({
        title: "GOL! ⚽",
        body: `${homeName} ${hs} × ${as} ${awayName}`,
        tag: `gol-${am.id}`,
        url: "/apostas?tab=resultados",
      });
    }
  }

  let push: unknown = null;
  if (pushEvents.length > 0) push = await sendPushEvents(pushEvents);

  return NextResponse.json({
    updated,
    ko: koUpserts,
    notificacoes: pushEvents.length,
    push,
    problems: problems.slice(0, 5),
  });
}

export async function POST(req: NextRequest) {
  return run(req);
}
export async function GET(req: NextRequest) {
  return run(req);
}
