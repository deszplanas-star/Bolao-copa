import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendPushEvents, sendPushToUsers, type PushEvent } from "@/lib/push";

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
  // A football-data OSCILA o TLA de alguns times entre o código FIFA e o ISO
  // de chamada pra chamada. Mapeamos AMBAS as variantes pra não perder placar
  // ao vivo: Uruguai (URU/URY) e Curaçao (CUR/CUW).
  URU: "uy", CUR: "cw",
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
  URU: "Uruguai", CUR: "Curaçau",
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
    duration?: string; // REGULAR | EXTRA_TIME | PENALTY_SHOOTOUT
    fullTime?: { home: number | null; away: number | null };
    regularTime?: { home: number | null; away: number | null }; // 90 min (só quando houve prorrog.)
    extraTime?: { home: number | null; away: number | null }; // gols SÓ da prorrogação
    penalties?: { home: number | null; away: number | null };
  };
};

function pairKey(a: string, b: string) {
  return [a, b].sort().join("|");
}

async function run(req: NextRequest) {
  // Aceita o CRON_SECRET (segredo dedicado, de baixo privilégio — é o que o
  // n8n guarda) ou a service key (uso interno/manual).
  const got = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const cron = process.env.CRON_SECRET?.trim();
  const authorized = !!got && ((!!cron && got === cron) || (!!svc && got === svc));
  if (!authorized) {
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

  const [{ data: teams }, { data: ours }, { data: koRows }] = await Promise.all([
    db.from("teams").select("id, iso_code"),
    db
      .from("matches")
      .select("id, home_team_id, away_team_id, home_score, away_score, status"),
    // Estado anterior do mata-mata: necessário pra detectar gol/início/fim
    // (o ramo ko só espelhava o placar — não notificava). home_score/away_score
    // são o tempo normal (pênaltis ficam em pen_*).
    db.from("ko_matches").select("fd_id, home_score, away_score, status"),
  ]);
  const isoToId = new Map((teams ?? []).map((t) => [t.iso_code as string, t.id as string]));
  const byPair = new Map(
    (ours ?? []).map((m) => [pairKey(m.home_team_id as string, m.away_team_id as string), m]),
  );
  const koByFd = new Map((koRows ?? []).map((k) => [k.fd_id as number, k]));

  let updated = 0;
  let koUpserts = 0;
  const problems: string[] = [];
  const pushEvents: PushEvent[] = [];

  for (const am of apiMatches) {
    // ---- mata-mata → ko_matches (espelho, atualiza sempre que mudar) ----
    if (am.stage !== "GROUP_STAGE") {
      const homeTla = am.homeTeam?.tla ?? null;
      const awayTla = am.awayTeam?.tla ?? null;

      const ftHome = am.score?.fullTime?.home ?? null;
      const ftAway = am.score?.fullTime?.away ?? null;
      // reg_home/reg_away = placar do TEMPO NORMAL (90 min). A football-data só
      // manda regularTime quando o jogo passou dos 90; senão o fullTime já é o 90 min.
      const regTime = am.score?.regularTime;
      const extraTime = am.score?.extraTime;
      // went_to_et: regularTime presente ⟺ o jogo foi à prorrogação.
      const wentToEt = regTime?.home != null && regTime?.away != null;
      const regHome = regTime?.home ?? ftHome;
      const regAway = regTime?.away ?? ftAway;

      // ⚠️ FOOTBALL-DATA: em jogo decidido nos pênaltis, score.fullTime JÁ VEM
      // somado com a disputa (1×1 + pênaltis 4×3 → fullTime 5×4) — E o campo
      // score.penalties OSCILA depois do FINISHED (Austrália×Egito 03/07 veio
      // penalties 4×4 com fullTime 3×5; o antigo fullTime−penalties gravou
      // home_score −1×1 e zerou os pontos de todo mundo). Fontes ESTÁVEIS:
      //   acumulado pós-prorrogação = regularTime + extraTime
      //   pênaltis                  = fullTime − acumulado
      const hasPens = am.score?.duration === "PENALTY_SHOOTOUT";
      let normalHome = ftHome;
      let normalAway = ftAway;
      let penHome: number | null = null;
      let penAway: number | null = null;
      if (hasPens) {
        if (wentToEt) {
          normalHome = (regTime?.home ?? 0) + (extraTime?.home ?? 0);
          normalAway = (regTime?.away ?? 0) + (extraTime?.away ?? 0);
        } else if (ftHome != null && ftAway != null) {
          // sem regularTime (não deveria acontecer em disputa): modelo antigo
          normalHome = ftHome - (am.score?.penalties?.home ?? 0);
          normalAway = ftAway - (am.score?.penalties?.away ?? 0);
        }
        penHome =
          ftHome != null && normalHome != null
            ? ftHome - normalHome
            : (am.score?.penalties?.home ?? null);
        penAway =
          ftAway != null && normalAway != null
            ? ftAway - normalAway
            : (am.score?.penalties?.away ?? null);
        // Sanidade: pênalti negativo, placar negativo ou disputa "empatada" em
        // jogo ENCERRADO = snapshot inconsistente da API. Tenta o campo
        // penalties puro; se ainda inconsistente, PULA o jogo neste ciclo (o
        // upsert é absoluto — melhor manter o dado anterior que gravar lixo).
        const badPens = (h: number | null, a: number | null) =>
          h == null || a == null || h < 0 || a < 0 || (DONE.has(am.status) && h === a);
        if (badPens(penHome, penAway)) {
          penHome = am.score?.penalties?.home ?? null;
          penAway = am.score?.penalties?.away ?? null;
        }
        if (
          badPens(penHome, penAway) ||
          normalHome == null ||
          normalAway == null ||
          normalHome < 0 ||
          normalAway < 0
        ) {
          problems.push(`ko ${am.id}: placar inconsistente na API, ciclo pulado`);
          continue;
        }
      }

      const koStatus = DONE.has(am.status)
        ? "finished"
        : LIVE.has(am.status)
          ? "live"
          : "scheduled";
      const prevKo = koByFd.get(am.id); // estado anterior (pra detectar gol/início/fim)

      const { error } = await db.from("ko_matches").upsert(
        {
          fd_id: am.id,
          stage: am.stage,
          home_name: homeTla ? (TLA_TO_NAME[homeTla] ?? am.homeTeam?.name) : null,
          away_name: awayTla ? (TLA_TO_NAME[awayTla] ?? am.awayTeam?.name) : null,
          home_iso: homeTla ? (TLA_TO_ISO[homeTla] ?? null) : null,
          away_iso: awayTla ? (TLA_TO_ISO[awayTla] ?? null) : null,
          kickoff_at: am.utcDate ?? null,
          home_score: normalHome,
          away_score: normalAway,
          reg_home: regHome,
          reg_away: regAway,
          went_to_et: wentToEt,
          pen_home: penHome,
          pen_away: penAway,
          status: koStatus,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "fd_id" },
      );
      if (error) {
        problems.push(`ko ${am.id}: ${error.message.slice(0, 80)}`);
        continue;
      }
      koUpserts++;

      // ---- push de gol no mata-mata (espelha a lógica da fase de grupos) ----
      // Idempotência: jogo já finalizado NÃO dispara de novo. A football-data
      // oscila placar/status por horas depois do FINISHED — sem essa guarda o
      // push de "Fim de jogo/GOL" entraria em loop (mesmo gotcha da fase 1).
      if (prevKo?.status !== "finished") {
        const homeName = homeTla ? (TLA_TO_NAME[homeTla] ?? am.homeTeam?.name ?? "?") : "?";
        const awayName = awayTla ? (TLA_TO_NAME[awayTla] ?? am.awayTeam?.name ?? "?") : "?";
        if (koStatus === "finished") {
          const penTxt = hasPens ? ` (pênaltis ${penHome} × ${penAway})` : "";
          pushEvents.push({
            title: "Fim de jogo! 🏁",
            body: `${homeName} ${normalHome ?? 0} × ${normalAway ?? 0} ${awayName}${penTxt} — confira o mata-mata`,
            tag: `ko-fim-${am.id}`,
            url: "/copa",
          });
        } else if (koStatus === "live") {
          const prevTotal = (prevKo?.home_score ?? 0) + (prevKo?.away_score ?? 0);
          const newTotal = (normalHome ?? 0) + (normalAway ?? 0);
          const isMatchStart = !prevKo || prevKo.status === "scheduled";
          if (isMatchStart) {
            pushEvents.push({
              title: "Apita o árbitro! ⚽",
              body: `${homeName} × ${awayName} — mata-mata começando`,
              tag: `ko-gol-${am.id}`,
              url: "/copa",
            });
          } else if (newTotal > prevTotal) {
            pushEvents.push({
              title: "GOL! ⚽",
              body: `${homeName} ${normalHome} × ${normalAway} ${awayName}`,
              tag: `ko-gol-${am.id}`,
              url: "/copa",
            });
          }
        }
      }
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

    // Idempotência: jogo já finalizado no banco NÃO é mais tocado pelo cron.
    // A football-data oscila placar/status por horas depois do FINISHED, o que
    // re-finalizava o jogo e reenviava o push "Fim de jogo/GOL" em loop (caso
    // Egito x Irã). Correção de placar pós-fim é manual no /admin (reopened).
    if (mine.status === "finished") continue;

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
      const isMatchStart = mine.home_score === null && mine.away_score === null;
      const goalsIncreased = (ourHome + ourAway) > ((mine.home_score ?? 0) + (mine.away_score ?? 0));
      if (isMatchStart) {
        pushEvents.push({
          title: "Apita o árbitro! ⚽",
          body: `${homeName} × ${awayName} — jogo começando`,
          tag: `gol-${am.id}`,
          url: "/apostas?tab=resultados",
        });
      } else if (goalsIncreased) {
        pushEvents.push({
          title: "GOL! ⚽",
          body: `${homeName} ${hs} × ${as} ${awayName}`,
          tag: `gol-${am.id}`,
          url: "/apostas?tab=resultados",
        });
      }
    }
  }

  let push: unknown = null;
  if (pushEvents.length > 0) push = await sendPushEvents(pushEvents);

  // BROCOU! — push dirigido para quem cravou nos jogos que encerraram agora
  const finishedMatchIds = pushEvents
    .filter((e) => e.tag?.startsWith("fim-"))
    .map((e) => e.tag!.replace("fim-", ""));

  if (finishedMatchIds.length > 0) {
    for (const matchId of finishedMatchIds) {
      const { data: cravadores } = await db
        .from("predictions")
        .select("user_id")
        .eq("match_id", matchId)
        .eq("points", 3);
      const userIds = (cravadores ?? []).map((c) => c.user_id as string);
      if (userIds.length > 0) {
        await sendPushToUsers(userIds, {
          title: "BROCOU! 🎯",
          body: `Bolão do Planinhas — você cravou o placar exato! Veja o ranking.`,
          tag: `brocou-${matchId}`,
          url: "/apostas?tab=ranking",
        });
      }
    }
  }

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
