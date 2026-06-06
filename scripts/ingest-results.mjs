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
  }

  console.log(`\nResumo: ${updated} atualizado(s), ${skipped} sem mudança.`);
  if (problems.length) console.log("Avisos:\n- " + problems.join("\n- "));
}

main().catch((e) => {
  console.error("FALHOU:", e.message);
  process.exit(1);
});
