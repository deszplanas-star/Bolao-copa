// ============================================================
// Ingestão de resultados da Copa 2026 → Supabase (Bolão 26)
// ------------------------------------------------------------
// Roda a cada ~5 min (GitHub Actions). Busca os jogos da fase de
// grupos na football-data.org, casa cada jogo com a nossa linha em
// `matches` PELO PAR DE TIMES (não pela data — nossas datas são
// aproximadas) e grava o placar. O trigger do banco recalcula os
// pontos, então o ranking se move (ao vivo / provisório).
//
// Env necessários:
//   FOOTBALL_DATA_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================

// Janela do torneio PRIMEIRO — fora dela não há o que ingerir, então saímos
// cedo (e antes de exigir os secrets, pra não falhar à toa antes da Copa).
const NOW = Date.now();
const WINDOW_START = Date.parse("2026-06-10T00:00:00Z");
const WINDOW_END = Date.parse("2026-07-20T23:59:59Z");
if (NOW < WINDOW_START || NOW > WINDOW_END) {
  console.log("Fora da janela do torneio — nada a fazer.");
  process.exit(0);
}

const FD_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!FD_TOKEN || !SB_URL || !SB_KEY) {
  console.error("Faltam env vars (FOOTBALL_DATA_TOKEN / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  process.exit(1);
}

// Sigla (TLA) da football-data.org → iso_code do nosso banco.
const TLA_TO_ISO = {
  // A football-data OSCILA o TLA de Uruguai (URU/URY) e Curaçao (CUR/CUW)
  // entre código FIFA e ISO. Mapeamos as duas variantes pra não perder placar.
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

// Status da API que consideramos "tem placar pra gravar".
const LIVE = new Set(["IN_PLAY", "PAUSED"]);
const DONE = new Set(["FINISHED"]);

// App em produção — o ingest avisa a rota /api/notify-goals (push de gol no
// PWA). Auth: a própria service key, que o workflow já injeta.
const APP_URL = process.env.APP_URL || "https://bolao-copa-pu3k.vercel.app";

// Nome em pt-BR pra notificação e pro chaveamento (TLA da football-data).
const TLA_TO_NAME = {
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

async function sb(path, init = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

function pairKey(a, b) {
  return [a, b].sort().join("|");
}

async function main() {
  // 1) Nosso banco: times (iso→id) e jogos (por par de times).
  const teams = await sb("teams?select=id,iso_code");
  const isoToId = new Map(teams.map((t) => [t.iso_code, t.id]));

  const matches = await sb(
    "matches?select=id,home_team_id,away_team_id,home_score,away_score,status",
  );
  const byPair = new Map();
  for (const m of matches) byPair.set(pairKey(m.home_team_id, m.away_team_id), m);

  // 2) Jogos reais da Copa (fase de grupos).
  const fd = await fetch("https://api.football-data.org/v4/competitions/WC/matches", {
    headers: { "X-Auth-Token": FD_TOKEN },
  });
  if (!fd.ok) throw new Error(`football-data ${fd.status}: ${await fd.text()}`);
  const { matches: apiMatches } = await fd.json();

  let updated = 0;
  let skipped = 0;
  const problems = [];
  const pushEvents = []; // notificações de gol/fim de jogo pro PWA

  // ---- Fases eliminatórias → ko_matches (chaveamento, espelho da API) ----
  let koUpserts = 0;
  for (const am of apiMatches) {
    if (am.stage === "GROUP_STAGE") continue;
    const homeTla = am.homeTeam?.tla ?? null;
    const awayTla = am.awayTeam?.tla ?? null;
    const ftHome = am.score?.fullTime?.home ?? null;
    const ftAway = am.score?.fullTime?.away ?? null;
    // reg_* = placar do tempo normal (90 min); went_to_et = foi à prorrogação.
    // Ver cron-ingest/route.ts e migration 0009 (camada de prorrogação oitavas+).
    const regTime = am.score?.regularTime;
    const extraTime = am.score?.extraTime;
    const regHome = regTime?.home ?? ftHome;
    const regAway = regTime?.away ?? ftAway;
    const wentToEt = regTime?.home != null && regTime?.away != null;
    // ⚠️ FOOTBALL-DATA: em jogo de pênaltis, score.fullTime JÁ VEM somado com a
    // disputa E score.penalties OSCILA depois do FINISHED (chegou a vir 4×4 com
    // fullTime 3×5 — o antigo fullTime−penalties gravava placar −1). Fontes
    // estáveis: acumulado = regularTime+extraTime; pênaltis = fullTime−acumulado.
    // Espelha cron-ingest/route.ts.
    const hasPens = am.score?.duration === "PENALTY_SHOOTOUT";
    let normalHome = ftHome;
    let normalAway = ftAway;
    let penHome = null;
    let penAway = null;
    if (hasPens) {
      if (wentToEt) {
        normalHome = (regTime?.home ?? 0) + (extraTime?.home ?? 0);
        normalAway = (regTime?.away ?? 0) + (extraTime?.away ?? 0);
      } else if (ftHome != null && ftAway != null) {
        normalHome = ftHome - (am.score?.penalties?.home ?? 0);
        normalAway = ftAway - (am.score?.penalties?.away ?? 0);
      }
      penHome =
        ftHome != null && normalHome != null ? ftHome - normalHome : (am.score?.penalties?.home ?? null);
      penAway =
        ftAway != null && normalAway != null ? ftAway - normalAway : (am.score?.penalties?.away ?? null);
      const badPens = (h, a) =>
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
    const row = {
      fd_id: am.id,
      stage: am.stage,
      kickoff_at: am.utcDate ?? null,
      home_score: normalHome,
      away_score: normalAway,
      reg_home: regHome,
      reg_away: regAway,
      went_to_et: wentToEt,
      pen_home: penHome,
      pen_away: penAway,
      status: DONE.has(am.status) ? "finished" : LIVE.has(am.status) ? "live" : "scheduled",
      updated_at: new Date().toISOString(),
    };
    // Nomes/iso só entram quando a API define os times — confronto preenchido
    // à mão no banco não pode voltar a NULL (o upsert só atualiza campos
    // presentes). Detecção de mando invertido fica só no cron-ingest/route.ts.
    if (homeTla && awayTla) {
      row.home_name = TLA_TO_NAME[homeTla] ?? am.homeTeam?.name;
      row.away_name = TLA_TO_NAME[awayTla] ?? am.awayTeam?.name;
      row.home_iso = TLA_TO_ISO[homeTla] ?? null;
      row.away_iso = TLA_TO_ISO[awayTla] ?? null;
    }
    try {
      await sb("ko_matches?on_conflict=fd_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(row),
      });
      koUpserts++;
    } catch (e) {
      // Tabela ainda não criada (migration 0005) — segue a vida, só avisa.
      problems.push(`ko_matches: ${e.message.slice(0, 120)}`);
      break;
    }
  }

  for (const am of apiMatches) {
    if (am.stage !== "GROUP_STAGE") continue;
    const isLive = LIVE.has(am.status);
    const isDone = DONE.has(am.status);
    if (!isLive && !isDone) continue;

    const hs = am.score?.fullTime?.home;
    const as = am.score?.fullTime?.away;
    if (hs == null || as == null) continue;

    const isoHome = TLA_TO_ISO[am.homeTeam?.tla];
    const isoAway = TLA_TO_ISO[am.awayTeam?.tla];
    const tidHome = isoToId.get(isoHome);
    const tidAway = isoToId.get(isoAway);
    if (!tidHome || !tidAway) {
      problems.push(`sem mapa: ${am.homeTeam?.tla} x ${am.awayTeam?.tla}`);
      continue;
    }

    const ours = byPair.get(pairKey(tidHome, tidAway));
    if (!ours) {
      problems.push(`sem jogo no banco: ${isoHome} x ${isoAway}`);
      continue;
    }

    // Idempotência: jogo já finalizado no banco NÃO é mais tocado. A
    // football-data oscila placar/status por horas após o FINISHED, o que
    // reenviava push "Fim de jogo/GOL" em loop. Correção pós-fim é manual.
    if (ours.status === "finished") {
      skipped++;
      continue;
    }

    // Traduz o placar para a perspectiva casa/fora do NOSSO jogo.
    const ourHome = ours.home_team_id === tidHome ? hs : as;
    const ourAway = ours.home_team_id === tidHome ? as : hs;
    const newStatus = isDone ? "finished" : ours.status;

    // Só grava se mudou algo (evita recálculo redundante).
    const same =
      ours.home_score === ourHome &&
      ours.away_score === ourAway &&
      ours.status === newStatus;
    if (same) {
      skipped++;
      continue;
    }

    const body = { home_score: ourHome, away_score: ourAway, status: newStatus };
    if (isDone) body.finalized_at = new Date().toISOString();

    await sb(`matches?id=eq.${ours.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(body),
    });
    updated++;
    console.log(
      `✓ ${isoHome} ${ourHome}x${ourAway} ${isoAway} [${am.status}${isDone ? "→finished" : ""}]`,
    );

    // Notificação: gol (placar mudou em jogo ao vivo) ou apito final.
    const homeName = TLA_TO_NAME[am.homeTeam?.tla] ?? am.homeTeam?.name ?? "?";
    const awayName = TLA_TO_NAME[am.awayTeam?.tla] ?? am.awayTeam?.name ?? "?";
    const scoreChanged = ours.home_score !== ourHome || ours.away_score !== ourAway;
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

  // ---- Push pro PWA (rota autenticada com a própria service key) ----
  if (pushEvents.length > 0) {
    try {
      const res = await fetch(`${APP_URL}/api/notify-goals`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SB_KEY}`,
        },
        body: JSON.stringify({ events: pushEvents }),
      });
      const out = await res.json().catch(() => ({}));
      console.log(`Push: ${res.status} ${JSON.stringify(out)}`);
    } catch (e) {
      console.log(`Push falhou (segue sem notificar): ${e.message}`);
    }
  }

  console.log(
    `\nResumo: ${updated} atualizado(s), ${skipped} sem mudança, ${koUpserts} jogo(s) de mata-mata, ${pushEvents.length} notificação(ões).`,
  );
  if (problems.length) console.log("Avisos:\n- " + problems.join("\n- "));
}

// ============================================================
// MODO PLANTÃO: o cron do GitHub em repo grátis atrasa HORAS (medido:
// ciclos de 4-5h em 11/06). Então cada execução que conseguir nascer
// vira um plantão: fica em loop consultando a cada POLL_SEC enquanto
// houver jogo rolando ou começando em breve, por até MAX_MIN minutos
// (< 6h, o teto do job). Repo é público — minutos não contam cota.
// ============================================================
const POLL_SEC = parseInt(process.env.POLL_SEC || "60", 10);
const MAX_MIN = parseInt(process.env.MAX_MIN || "330", 10);

async function hasActionSoon() {
  // Há jogo ao vivo agora, ou com kickoff nos próximos 30 min?
  const rows = await sb(
    "matches?select=kickoff_at,status&order=kickoff_at",
  );
  const now = Date.now();
  for (const m of rows) {
    const ko = Date.parse(m.kickoff_at);
    const inPlayWindow = now >= ko - 30 * 60_000 && now <= ko + 150 * 60_000;
    if (m.status !== "finished" && inPlayWindow) return true;
  }
  return false;
}

async function plantao() {
  const deadline = Date.now() + MAX_MIN * 60_000;
  let cycle = 0;
  for (;;) {
    cycle++;
    console.log(`\n--- ciclo ${cycle} (${new Date().toISOString()}) ---`);
    try {
      await main();
    } catch (e) {
      console.error("ciclo falhou (segue o plantão):", e.message);
    }
    if (Date.now() >= deadline) {
      console.log("Plantão encerrado (tempo máximo).");
      return;
    }
    let action = false;
    try {
      action = await hasActionSoon();
    } catch {
      action = true; // na dúvida, continua de plantão
    }
    if (!action) {
      console.log("Sem jogo ao vivo ou iminente — encerrando até o próximo cron.");
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_SEC * 1000));
  }
}

plantao().catch((e) => {
  console.error("FALHOU:", e.message);
  process.exit(1);
});
