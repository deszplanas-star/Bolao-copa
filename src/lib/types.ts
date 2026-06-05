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
};
