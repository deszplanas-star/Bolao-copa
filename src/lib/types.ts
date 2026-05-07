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
  prediction: { home_score: number; away_score: number } | null;
};
