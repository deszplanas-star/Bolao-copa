export type Group = {
  id: string;
  code: string;
  name: string;
  ord: number;
};

export type Team = {
  id: string;
  iso_code: string;
  name: string;
  group_id: string;
};

export type MatchStatus = "scheduled" | "locked" | "finished";

export type Match = {
  id: string;
  group_id: string;
  home_team_id: string;
  away_team_id: string;
  kickoff_at: string;
  stadium: string | null;
  matchday: number;
  home_score: number | null;
  away_score: number | null;
  status: MatchStatus;
  reopened: boolean;
};

export type Prediction = {
  id: string;
  user_id: string;
  match_id: string;
  home_score: number;
  away_score: number;
  points: number;
  computed_at: string | null;
};

export type GroupWithTeams = Group & { teams: Team[] };

export type MatchView = Match & {
  home: Team;
  away: Team;
  prediction: {
    home_score: number;
    away_score: number;
    points: number;
    computed_at: string | null;
  } | null;
};

export type RankingRow = {
  user_id: string;
  name: string | null;
  avatar_url: string | null;
  total_points: number;
  exact_hits: number;
  partial_hits: number;
  misses: number;
  resolved_count: number;
  position: number;
  // Penalidade aplicada pelo admin (migration 0006) — opcionais até a
  // migration rodar, pra view antiga não quebrar o app.
  penalty_points?: number;
  penalty_reason?: string | null;
  // Total de palpites do jogador (migration 0007) — quem entrou atrasado
  // tem menos que o total de jogos e ganha o badge (i) no ranking.
  bet_count?: number;
};

// ============================================================
// FASE 2 — MATA-MATA (migration 0008)
// ============================================================

// Espelho da football-data (tabela ko_matches, alimentada pelo cron-ingest).
export type KoMatch = {
  id: string;
  fd_id: number;
  stage: string; // LAST_32 | LAST_16 | QUARTER_FINALS | SEMI_FINALS | THIRD_PLACE | FINAL
  home_name: string | null;
  away_name: string | null;
  home_iso: string | null;
  away_iso: string | null;
  kickoff_at: string | null;
  home_score: number | null; // placar ACUMULADO ao fim da prorrogação (= fullTime − pênaltis)
  away_score: number | null;
  reg_home: number | null; // placar do TEMPO NORMAL (90 min) — usado da oitava em diante
  reg_away: number | null;
  went_to_et: boolean; // o jogo foi à prorrogação?
  pen_home: number | null;
  pen_away: number | null;
  status: string; // scheduled | live | finished
};

// Palpite do usuário num jogo do mata-mata.
//  - 16avos (LAST_32): home/away (normal+prorrog combinado) + pênaltis.
//  - oitavas+ : reg_* (tempo normal 90 min) + home/away (placar pós-prorrogação) + pênaltis.
export type KoPredictionFields = {
  home_score: number;
  away_score: number;
  reg_home: number | null;
  reg_away: number | null;
  pen_home: number;
  pen_away: number;
  normal_points: number;
  prorrog_points: number;
  pen_points: number;
  points: number;
  computed_at: string | null;
};

export type KoMatchView = KoMatch & {
  prediction: KoPredictionFields | null;
};

// Palpite de campeão do usuário (+5 se acertar).
export type ChampionPick = {
  team_iso: string;
  team_name: string;
  points: number;
  computed_at: string | null;
} | null;

// Candidato ao palpite de campeão (seleção que aparece no chaveamento).
export type ChampionCandidate = { iso: string; name: string };

// Linha da view ko_rankings (gated por ko_payments aprovado).
export type KoRankingRow = {
  user_id: string;
  name: string | null;
  avatar_url: string | null;
  total_points: number;
  exact_hits: number;
  pen_exact_hits: number;
  resolved_count: number;
  bet_count: number;
  champion_points: number;
  champion_pick: string | null;
  position: number;
};
