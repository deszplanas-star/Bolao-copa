import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildBetsPdf,
  buildConsolidatedPdf,
  type PdfInput,
  type PdfMatch,
} from "@/lib/pdf";

export async function buildUserBetsPdf(
  userId: string,
): Promise<{ bytes: Uint8Array; name: string; email: string } | null> {
  const supabase = createClient();

  const [{ data: userRow }, { data: preds }, { data: matches }, { data: teams }, { data: groups }] =
    await Promise.all([
      supabase.from("users").select("name, email").eq("id", userId).maybeSingle(),
      supabase
        .from("predictions")
        .select("match_id, home_score, away_score")
        .eq("user_id", userId),
      supabase.from("matches").select("id, group_id, home_team_id, away_team_id, kickoff_at"),
      supabase.from("teams").select("id, name"),
      supabase.from("groups").select("id, code"),
    ]);

  if (!userRow) return null;

  const teamById = new Map((teams ?? []).map((t) => [t.id as string, t.name as string]));
  const groupById = new Map((groups ?? []).map((g) => [g.id as string, g.code as string]));
  const matchById = new Map((matches ?? []).map((m) => [m.id as string, m]));

  const pdfMatches: PdfMatch[] = (preds ?? [])
    .map((p) => {
      const m = matchById.get(p.match_id as string);
      if (!m) return null;
      return {
        group_code: groupById.get(m.group_id as string) ?? "?",
        home_name: teamById.get(m.home_team_id as string) ?? "?",
        away_name: teamById.get(m.away_team_id as string) ?? "?",
        home_score: p.home_score as number,
        away_score: p.away_score as number,
        kickoff_at: m.kickoff_at as string,
      };
    })
    .filter((x): x is PdfMatch => x !== null);

  const input: PdfInput = {
    user_name: (userRow.name as string | null) ?? (userRow.email as string),
    user_email: userRow.email as string,
    submitted_at: new Date().toISOString(),
    matches: pdfMatches,
  };

  const bytes = await buildBetsPdf(input);
  return { bytes, name: input.user_name, email: input.user_email };
}

export type ConsolidatedPlayer = { name: string; email: string };

/**
 * Monta UM PDF com as apostas de todos os userIds (aprovados), em ordem
 * alfabética. Usa service role quando disponível — o cliente de sessão lê
 * palpites alheios via RLS e, sem role='admin', voltaria vazio em silêncio.
 * Os palpites são buscados POR usuário de propósito: uma query única com
 * `.in()` esbarra no teto de 1.000 linhas do PostgREST (e 30 apostadores ×
 * 72 palpites já passa disso) e truncaria o PDF sem avisar.
 */
export async function buildAllBetsPdf(
  userIds: string[],
  approvedAtByUser: Map<string, string | null>,
): Promise<{ bytes: Uint8Array; players: ConsolidatedPlayer[] } | null> {
  const supabase = createAdminClient() ?? createClient();

  const [{ data: users }, { data: matches }, { data: teams }, { data: groups }] =
    await Promise.all([
      supabase.from("users").select("id, name, email").in("id", userIds),
      supabase.from("matches").select("id, group_id, home_team_id, away_team_id, kickoff_at"),
      supabase.from("teams").select("id, name"),
      supabase.from("groups").select("id, code"),
    ]);

  if (!users || users.length === 0) return null;

  const teamById = new Map((teams ?? []).map((t) => [t.id as string, t.name as string]));
  const groupById = new Map((groups ?? []).map((g) => [g.id as string, g.code as string]));
  const matchById = new Map((matches ?? []).map((m) => [m.id as string, m]));

  const sorted = [...users].sort((a, b) =>
    (((a.name as string | null) ?? (a.email as string)) || "").localeCompare(
      ((b.name as string | null) ?? (b.email as string)) || "",
      "pt-BR",
    ),
  );

  const inputs: PdfInput[] = [];
  for (const u of sorted) {
    const { data: preds } = await supabase
      .from("predictions")
      .select("match_id, home_score, away_score")
      .eq("user_id", u.id as string);

    const pdfMatches: PdfMatch[] = (preds ?? [])
      .map((p) => {
        const m = matchById.get(p.match_id as string);
        if (!m) return null;
        return {
          group_code: groupById.get(m.group_id as string) ?? "?",
          home_name: teamById.get(m.home_team_id as string) ?? "?",
          away_name: teamById.get(m.away_team_id as string) ?? "?",
          home_score: p.home_score as number,
          away_score: p.away_score as number,
          kickoff_at: m.kickoff_at as string,
        };
      })
      .filter((x): x is PdfMatch => x !== null);

    if (pdfMatches.length === 0) continue; // aprovado sem palpite não entra

    inputs.push({
      user_name: (u.name as string | null) ?? (u.email as string),
      user_email: u.email as string,
      submitted_at: approvedAtByUser.get(u.id as string) ?? new Date().toISOString(),
      matches: pdfMatches,
    });
  }

  if (inputs.length === 0) return null;

  const bytes = await buildConsolidatedPdf(inputs, new Date().toISOString());
  return {
    bytes,
    players: inputs.map((i) => ({ name: i.user_name, email: i.user_email })),
  };
}
