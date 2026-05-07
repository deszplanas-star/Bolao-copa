"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getAuthedAdmin } from "@/lib/auth";

type ActionResult = { ok: true } | { ok: false; error: string };

const approvePaymentSchema = z.object({
  payment_id: z.string().uuid(),
});

const denyPaymentSchema = z.object({
  payment_id: z.string().uuid(),
  reason: z.string().min(1).max(500).optional(),
});

const setMatchResultSchema = z.object({
  match_id: z.string().uuid(),
  home_score: z.number().int().min(0).max(99),
  away_score: z.number().int().min(0).max(99),
});

const clearMatchResultSchema = z.object({
  match_id: z.string().uuid(),
});

async function logAdmin(
  adminId: string,
  action: string,
  targetType: string,
  targetId: string,
  payload: Record<string, unknown> = {},
) {
  const supabase = createClient();
  await supabase.from("admin_logs").insert({
    admin_id: adminId,
    action,
    target_type: targetType,
    target_id: targetId,
    payload,
  });
}

export async function approvePayment(input: unknown): Promise<ActionResult> {
  const parsed = approvePaymentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Entrada inválida." };

  const admin = await getAuthedAdmin();
  if (!admin) return { ok: false, error: "Acesso negado." };

  const supabase = createClient();
  const { error } = await supabase
    .from("payments")
    .update({
      status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: admin.id,
      denied_reason: null,
    })
    .eq("id", parsed.data.payment_id);

  if (error) return { ok: false, error: error.message };

  await logAdmin(admin.id, "payment.approve", "payment", parsed.data.payment_id);
  revalidatePath("/admin");
  return { ok: true };
}

export async function denyPayment(input: unknown): Promise<ActionResult> {
  const parsed = denyPaymentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Entrada inválida." };

  const admin = await getAuthedAdmin();
  if (!admin) return { ok: false, error: "Acesso negado." };

  const supabase = createClient();
  const { error } = await supabase
    .from("payments")
    .update({
      status: "denied",
      denied_reason: parsed.data.reason ?? "Sem motivo informado",
      approved_at: null,
      approved_by: null,
    })
    .eq("id", parsed.data.payment_id);

  if (error) return { ok: false, error: error.message };

  await logAdmin(admin.id, "payment.deny", "payment", parsed.data.payment_id, {
    reason: parsed.data.reason,
  });
  revalidatePath("/admin");
  return { ok: true };
}

export async function setMatchResult(input: unknown): Promise<ActionResult> {
  const parsed = setMatchResultSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Placar inválido." };

  const admin = await getAuthedAdmin();
  if (!admin) return { ok: false, error: "Acesso negado." };

  const supabase = createClient();
  const { error } = await supabase
    .from("matches")
    .update({
      home_score: parsed.data.home_score,
      away_score: parsed.data.away_score,
      status: "finished",
      finalized_at: new Date().toISOString(),
      finalized_by: admin.id,
    })
    .eq("id", parsed.data.match_id);

  if (error) return { ok: false, error: error.message };

  // Trigger no banco recalcula pontos automaticamente.
  await logAdmin(admin.id, "match.set_result", "match", parsed.data.match_id, {
    home_score: parsed.data.home_score,
    away_score: parsed.data.away_score,
  });
  revalidatePath("/admin");
  revalidatePath("/apostas");
  return { ok: true };
}

export async function clearMatchResult(input: unknown): Promise<ActionResult> {
  const parsed = clearMatchResultSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Entrada inválida." };

  const admin = await getAuthedAdmin();
  if (!admin) return { ok: false, error: "Acesso negado." };

  const supabase = createClient();
  const { error } = await supabase
    .from("matches")
    .update({
      home_score: null,
      away_score: null,
      status: "scheduled",
      finalized_at: null,
      finalized_by: null,
    })
    .eq("id", parsed.data.match_id);

  if (error) return { ok: false, error: error.message };

  // Zerar pontos de quem palpitou nesse jogo (trigger só recomputa quando há placar)
  await supabase
    .from("predictions")
    .update({ points: 0, computed_at: null })
    .eq("match_id", parsed.data.match_id);

  await logAdmin(admin.id, "match.clear_result", "match", parsed.data.match_id);
  revalidatePath("/admin");
  revalidatePath("/apostas");
  return { ok: true };
}
