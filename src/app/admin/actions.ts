"use server";

import { revalidatePath } from "next/cache";
import { waitUntil } from "@vercel/functions";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getAuthedAdmin } from "@/lib/auth";
import { buildUserBetsPdf } from "@/lib/bets-pdf";
import { sendCzechFixNotice, sendUserApprovalNotification } from "@/lib/email";

type ActionResult = { ok: true } | { ok: false; error: string };
type BroadcastResult =
  | { ok: true; total: number; sent: number; failed: number }
  | { ok: false; error: string };

// Roda tarefas async em lotes pequenos pra não estourar o tempo da função
// serverless nem disparar dezenas de envios simultâneos no Resend.
async function runInChunks<T>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<boolean>,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    const results = await Promise.all(chunk.map((it) => fn(it).catch(() => false)));
    for (const ok of results) ok ? sent++ : failed++;
  }
  return { sent, failed };
}

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

  // Descobre user_id do payment antes de update — pra gerar o PDF
  const { data: paymentRow } = await supabase
    .from("payments")
    .select("user_id")
    .eq("id", parsed.data.payment_id)
    .maybeSingle();

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

  // Notifica o apostador em background — não bloqueia resposta admin
  const targetUserId = paymentRow?.user_id as string | undefined;
  if (targetUserId) {
    waitUntil(
      (async () => {
        try {
          const pdf = await buildUserBetsPdf(targetUserId);
          if (pdf) {
            await sendUserApprovalNotification({
              user_name: pdf.name,
              user_email: pdf.email,
              pdfBytes: pdf.bytes,
            });
          }
        } catch (e) {
          console.error("[approvePayment] notificação user falhou", e);
        }
      })(),
    );
  }

  revalidatePath("/admin");
  return { ok: true };
}

/**
 * Reenvia o PDF de confirmação para TODOS os apostadores com pagamento
 * aprovado. Útil pra cobrir quem não recebeu (ex.: quando o role de admin
 * ainda não estava no banco e o RLS bloqueava a geração do PDF).
 */
export async function resendApprovedPdfs(): Promise<BroadcastResult> {
  const admin = await getAuthedAdmin();
  if (!admin) return { ok: false, error: "Acesso negado." };

  const supabase = createClient();
  const { data: rows, error } = await supabase
    .from("payments")
    .select("user_id")
    .eq("status", "approved");

  if (error) return { ok: false, error: error.message };

  const userIds = Array.from(new Set((rows ?? []).map((r) => r.user_id as string)));
  if (userIds.length === 0) return { ok: true, total: 0, sent: 0, failed: 0 };

  const { sent, failed } = await runInChunks(userIds, 4, async (uid) => {
    const pdf = await buildUserBetsPdf(uid);
    if (!pdf) return false;
    return sendUserApprovalNotification({
      user_name: pdf.name,
      user_email: pdf.email,
      pdfBytes: pdf.bytes,
    });
  });

  await logAdmin(admin.id, "broadcast.resend_pdfs", "payment", admin.id, {
    total: userIds.length,
    sent,
    failed,
  });

  return { ok: true, total: userIds.length, sent, failed };
}

/**
 * Avisa por email todos os apostadores que têm palpite em algum jogo
 * reaberto (correção Dinamarca → República Tcheca, Grupo A), com o link
 * pra revisar o placar. Sem anexo.
 */
export async function notifyCzechFix(): Promise<BroadcastResult> {
  const admin = await getAuthedAdmin();
  if (!admin) return { ok: false, error: "Acesso negado." };

  const supabase = createClient();

  const { data: reopened, error: rErr } = await supabase
    .from("matches")
    .select("id")
    .eq("reopened", true);
  if (rErr) return { ok: false, error: rErr.message };

  const matchIds = (reopened ?? []).map((m) => m.id as string);
  if (matchIds.length === 0) {
    return { ok: false, error: "Nenhum jogo reaberto encontrado." };
  }

  const { data: preds, error: pErr } = await supabase
    .from("predictions")
    .select("user_id")
    .in("match_id", matchIds);
  if (pErr) return { ok: false, error: pErr.message };

  const userIds = Array.from(new Set((preds ?? []).map((p) => p.user_id as string)));
  if (userIds.length === 0) return { ok: true, total: 0, sent: 0, failed: 0 };

  const { data: users, error: uErr } = await supabase
    .from("users")
    .select("id, name, email")
    .in("id", userIds);
  if (uErr) return { ok: false, error: uErr.message };

  const recipients = (users ?? []).filter((u) => !!u.email);

  const { sent, failed } = await runInChunks(recipients, 5, (u) =>
    sendCzechFixNotice({
      user_name: (u.name as string | null) ?? (u.email as string),
      user_email: u.email as string,
    }),
  );

  await logAdmin(admin.id, "broadcast.czech_fix", "match", admin.id, {
    total: recipients.length,
    sent,
    failed,
  });

  return { ok: true, total: recipients.length, sent, failed };
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
