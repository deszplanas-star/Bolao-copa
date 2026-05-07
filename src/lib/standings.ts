import type { MatchView, Team } from "./types";

export type StandingRow = {
  team: Team;
  pos: number;
  p: number;
  j: number;
  v: number;
  e: number;
  d: number;
  gp: number;
  gc: number;
  sg: number;
};

type DraftPredictions = Record<string, { home_score: number; away_score: number } | null>;

export function computeStandings(
  teams: Team[],
  matches: MatchView[],
  drafts: DraftPredictions = {},
): StandingRow[] {
  const rows = new Map<string, StandingRow>();
  for (const team of teams) {
    rows.set(team.id, {
      team,
      pos: 0,
      p: 0,
      j: 0,
      v: 0,
      e: 0,
      d: 0,
      gp: 0,
      gc: 0,
      sg: 0,
    });
  }

  for (const m of matches) {
    const draft = drafts[m.id];
    const pred =
      draft !== undefined
        ? draft
        : m.prediction
          ? { home_score: m.prediction.home_score, away_score: m.prediction.away_score }
          : null;

    if (!pred) continue;

    const home = rows.get(m.home_team_id);
    const away = rows.get(m.away_team_id);
    if (!home || !away) continue;

    home.j++;
    away.j++;
    home.gp += pred.home_score;
    home.gc += pred.away_score;
    away.gp += pred.away_score;
    away.gc += pred.home_score;

    if (pred.home_score > pred.away_score) {
      home.v++;
      home.p += 3;
      away.d++;
    } else if (pred.home_score < pred.away_score) {
      away.v++;
      away.p += 3;
      home.d++;
    } else {
      home.e++;
      away.e++;
      home.p += 1;
      away.p += 1;
    }
  }

  const list = Array.from(rows.values()).map((r) => ({ ...r, sg: r.gp - r.gc }));
  list.sort(
    (a, b) =>
      b.p - a.p ||
      b.sg - a.sg ||
      b.gp - a.gp ||
      a.team.name.localeCompare(b.team.name, "pt-BR"),
  );
  list.forEach((r, i) => (r.pos = i + 1));
  return list;
}
