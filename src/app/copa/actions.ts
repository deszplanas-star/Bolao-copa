"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

// ============================================================
// FASE 2 — Mata-mata. Palpites por jogo + palpite de campeão.
//
// Diferenças importantes pra fase 1 (apostas/actions.ts):
//  - NÃO existe trava de "aposta selada": aqui aposta-se A CADA RODADA, então
//    o palpite fica editável até o jogo travar.
//  - A trava é por TEMPO: fecha 30 MIN antes do apito (na fase 1 é 5 min).
//  - Cada palpite tem 4 placares OBRIGATÓRIOS: normal/prorrogação + pênaltis.
// ============================================================

// Trava: 30 minutos antes do kickoff (vs. 5 min na fase de grupos).
const KO_CUTOFF_MS = 30 * 60 * 1000;

const upsertKoSchema = z.object({
  ko_match_id: z.string().uuid(),
  home_score: z.number().int().min(0).max(99),
  away_score: z.number().int().min(0).max(99),
  // Placar do tempo normal (90 min). Obrigatório da oitava em diante; nos
  // 16avos não é usado (vem ausente). Ver migration 0009.
  reg_home: z.number().int().min(0).max(99).optional(),
  reg_away: z.number().int().min(0).max(99).optional(),
  pen_home: z.number().int().min(0).max(99),
  pen_away: z.number().int().min(0).max(99),
});

const championSchema = z.object({
  team_iso: z.string().min(1).max(12),
  team_name: z.string().min(1).max(60),
});

type ActionResult = { ok: true } | { ok: false; error: string };

function isKoLocked(status: string, kickoff_at: string | null): boolean {
  // Sem horário ainda definido = aposta aberta (o confronto acabou de surgir).
  if (!kickoff_at) return false;
  if (status !== "scheduled") return true;
  return new Date(kickoff_at).getTime() - Date.now() <= KO_CUTOFF_MS;
}

/**
 * Salva/atualiza o palpite de UM jogo do mata-mata. Bloqueia só pela trava de
 * tempo (30 min antes do apito). Os pênaltis são obrigatórios — funcionam como
 * "seguro": só pontuam se o jogo de fato for pra disputa.
 */
export async function upsertKoPrediction(input: unknown): Promise<ActionResult> {
  const parsed = upsertKoSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Palpite inválido." };

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  const { data: match, error: mErr } = await supabase
    .from("ko_matches")
    .select("id, status, kickoff_at")
    .eq("id", parsed.data.ko_match_id)
    .single();
  if (mErr || !match) return { ok: false, error: "Jogo não encontrado." };

  if (isKoLocked(match.status as string, match.kickoff_at as string | null)) {
    return { ok: false, error: "Apostas para este jogo já estão fechadas (fecha 30 min antes)." };
  }

  const { error } = await supabase.from("ko_predictions").upsert(
    {
      user_id: user.id,
      ko_match_id: parsed.data.ko_match_id,
      home_score: parsed.data.home_score,
      away_score: parsed.data.away_score,
      reg_home: parsed.data.reg_home ?? null,
      reg_away: parsed.data.reg_away ?? null,
      pen_home: parsed.data.pen_home,
      pen_away: parsed.data.pen_away,
    },
    { onConflict: "user_id,ko_match_id" },
  );

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Salva/atualiza o palpite de CAMPEÃO. Trava no momento configurado em
 * ko_config.champion_lock_at (apito do 1º jogo dos 16avos). Se o prazo ainda
 * não foi definido (NULL), o palpite segue aberto.
 */
export async function upsertChampion(input: unknown): Promise<ActionResult> {
  const parsed = championSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Seleção inválida." };

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  // Trava do campeão (lida ao vivo, à prova de falha no servidor).
  const { data: cfg } = await supabase
    .from("ko_config")
    .select("champion_lock_at")
    .eq("id", 1)
    .maybeSingle();
  const lockAt = cfg?.champion_lock_at as string | null | undefined;
  if (lockAt && Date.now() >= new Date(lockAt).getTime()) {
    return { ok: false, error: "O palpite de campeão já está fechado." };
  }

  const { error } = await supabase.from("champion_predictions").upsert(
    {
      user_id: user.id,
      team_iso: parsed.data.team_iso,
      team_name: parsed.data.team_name,
    },
    { onConflict: "user_id" },
  );

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
