"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const CUTOFF_MS = 5 * 60 * 1000;

const upsertSchema = z.object({
  match_id: z.string().uuid(),
  home_score: z.number().int().min(0).max(99),
  away_score: z.number().int().min(0).max(99),
});

const deleteSchema = z.object({
  match_id: z.string().uuid(),
});

type ActionResult = { ok: true } | { ok: false; error: string };

type MatchLockInfo = { id: string; status: string; kickoff_at: string };
type SupabaseClient = ReturnType<typeof createClient>;
type AuthedUser = { id: string };
type GetMatchResult =
  | { ok: false; error: string }
  | { ok: true; supabase: SupabaseClient; user: AuthedUser; match: MatchLockInfo };

async function getUserAndMatch(matchId: string): Promise<GetMatchResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  const { data, error: mErr } = await supabase
    .from("matches")
    .select("id, status, kickoff_at")
    .eq("id", matchId)
    .single();
  if (mErr || !data) return { ok: false, error: "Jogo não encontrado." };

  return { ok: true, supabase, user, match: data as MatchLockInfo };
}

async function isBetSealed(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("payments")
    .select("status")
    .eq("user_id", userId)
    .maybeSingle();
  const status = data?.status as string | undefined;
  return status === "pending" || status === "approved";
}

function isLocked(status: string, kickoff_at: string) {
  if (status !== "scheduled") return true;
  return new Date(kickoff_at).getTime() - Date.now() <= CUTOFF_MS;
}

export async function upsertPrediction(input: unknown): Promise<ActionResult> {
  const parsed = upsertSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Palpite inválido." };

  const got = await getUserAndMatch(parsed.data.match_id);
  if (!got.ok) return { ok: false, error: got.error };
  const { supabase, user, match } = got;

  if (await isBetSealed(supabase, user.id)) {
    return { ok: false, error: "Aposta já foi ativada — palpites travados." };
  }

  if (isLocked(match.status, match.kickoff_at)) {
    return { ok: false, error: "Apostas para este jogo já estão fechadas." };
  }

  const { error } = await supabase.from("predictions").upsert(
    {
      user_id: user.id,
      match_id: parsed.data.match_id,
      home_score: parsed.data.home_score,
      away_score: parsed.data.away_score,
    },
    { onConflict: "user_id,match_id" },
  );

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function deletePrediction(input: unknown): Promise<ActionResult> {
  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Entrada inválida." };

  const got = await getUserAndMatch(parsed.data.match_id);
  if (!got.ok) return { ok: false, error: got.error };
  const { supabase, user, match } = got;

  if (await isBetSealed(supabase, user.id)) {
    return { ok: false, error: "Aposta já foi ativada — palpites travados." };
  }

  if (isLocked(match.status, match.kickoff_at)) {
    return { ok: false, error: "Apostas para este jogo já estão fechadas." };
  }

  const { error } = await supabase
    .from("predictions")
    .delete()
    .eq("user_id", user.id)
    .eq("match_id", parsed.data.match_id);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
