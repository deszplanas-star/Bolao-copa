"use server";

import { revalidatePath } from "next/cache";
import { waitUntil } from "@vercel/functions";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedAdmin } from "@/lib/auth";
import { buildAllBetsPdf, buildUserBetsPdf } from "@/lib/bets-pdf";
import {
  sendConsolidatedBetsEmail,
  sendCountdownEmail,
  sendCzechFixNotice,
  sendTestEmail,
  sendUserApprovalNotification,
} from "@/lib/email";

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
  const supabase = createAdminClient() ?? createClient();
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
 * Envia para TODOS os aprovados UM ÚNICO PDF consolidado com as apostas de
 * TODOS os participantes — transparência: cada um pode conferir os palpites
 * dos demais. O PDF é montado uma vez só e reaproveitado em todos os envios.
 */
export async function sendConsolidatedBets(): Promise<BroadcastResult> {
  const admin = await getAuthedAdmin();
  if (!admin) return { ok: false, error: "Acesso negado." };

  const supabase = createClient();
  const { data: rows, error } = await supabase
    .from("payments")
    .select("user_id, approved_at")
    .eq("status", "approved");

  if (error) return { ok: false, error: error.message };

  const approvedAtByUser = new Map<string, string | null>();
  for (const r of rows ?? []) {
    approvedAtByUser.set(r.user_id as string, (r.approved_at as string | null) ?? null);
  }
  const userIds = Array.from(approvedAtByUser.keys());
  if (userIds.length === 0) return { ok: true, total: 0, sent: 0, failed: 0 };

  const consolidated = await buildAllBetsPdf(userIds, approvedAtByUser);
  if (!consolidated) {
    return {
      ok: false,
      error:
        "Não consegui montar o PDF consolidado — nenhum palpite encontrado. Confira a SUPABASE_SERVICE_ROLE_KEY na Vercel ou o role='admin' no banco.",
    };
  }

  const { sent, failed } = await runInChunks(consolidated.players, 4, (p) =>
    sendConsolidatedBetsEmail({
      user_name: p.name,
      user_email: p.email,
      totalPlayers: consolidated.players.length,
      pdfBytes: consolidated.bytes,
    }),
  );

  await logAdmin(admin.id, "broadcast.consolidated_bets", "payment", admin.id, {
    total: consolidated.players.length,
    sent,
    failed,
  });

  return { ok: true, total: consolidated.players.length, sent, failed };
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

/**
 * Dispara um email de teste SÓ para o admin logado (adminEmail), pra validar
 * o transporte Gmail em produção sem spammar ninguém e sem depender de
 * PDF/role. Aguarda o resultado (não usa waitUntil) pra devolver o veredito.
 */
export async function sendAdminTestEmail(): Promise<
  { ok: true; detail: string; to: string } | { ok: false; error: string }
> {
  const admin = await getAuthedAdmin();
  if (!admin) return { ok: false, error: "Acesso negado." };

  const res = await sendTestEmail();
  await logAdmin(admin.id, "email.test", "admin", admin.id, {
    ok: res.ok,
    detail: res.detail,
  });

  if (!res.ok) return { ok: false, error: res.detail };
  return { ok: true, detail: res.detail, to: res.to };
}

/**
 * Dispara o email de contagem regressiva (com o PDF dos palpites em anexo)
 * para TODOS os apostadores com pagamento aprovado. Os dias até a estreia são
 * calculados no servidor a partir do 1º jogo (kickoff), em horário de Brasília.
 */
export async function notifyCountdown(): Promise<BroadcastResult> {
  const admin = await getAuthedAdmin();
  if (!admin) return { ok: false, error: "Acesso negado." };

  const supabase = createClient();

  // Dias até a estreia = data do 1º jogo (kickoff) - hoje, em BRT (UTC-3).
  const { data: firstMatch } = await supabase
    .from("matches")
    .select("kickoff_at")
    .order("kickoff_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  let daysLeft = 0;
  if (firstMatch?.kickoff_at) {
    const brtDay = (d: Date) => {
      const b = new Date(d.getTime() - 3 * 60 * 60 * 1000); // desloca p/ BRT
      return Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
    };
    const kickoff = new Date(firstMatch.kickoff_at as string);
    daysLeft = Math.max(0, Math.round((brtDay(kickoff) - brtDay(new Date())) / 86_400_000));
  }

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
    return sendCountdownEmail({
      user_name: pdf.name,
      user_email: pdf.email,
      pdfBytes: pdf.bytes,
      daysLeft,
    });
  });

  await logAdmin(admin.id, "broadcast.countdown", "payment", admin.id, {
    total: userIds.length,
    sent,
    failed,
    daysLeft,
  });

  return { ok: true, total: userIds.length, sent, failed };
}

const setEditsUnlockedSchema = z.object({
  user_id: z.string().uuid(),
  unlocked: z.boolean(),
});

/**
 * Liga/desliga a liberação de edição individual (users.edits_unlocked) de um
 * apostador. Detecta 0 linhas afetadas e devolve erro explícito — pra não
 * falhar em silêncio se faltar a coluna (migration) ou o role='admin' (RLS).
 */
export async function setUserEditsUnlocked(input: unknown): Promise<ActionResult> {
  const parsed = setEditsUnlockedSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Entrada inválida." };

  const admin = await getAuthedAdmin();
  if (!admin) return { ok: false, error: "Acesso negado." };

  // Service role: bypassa RLS. Não depende de role='admin' nem de policy de
  // UPDATE em users — quem chega aqui já passou pelo getAuthedAdmin.
  const db = createAdminClient();
  if (!db) {
    return {
      ok: false,
      error:
        "Falta a SUPABASE_SERVICE_ROLE_KEY na Vercel — adicione (Production) e refaça o deploy.",
    };
  }

  const { data, error } = await db
    .from("users")
    .update({ edits_unlocked: parsed.data.unlocked })
    .eq("id", parsed.data.user_id)
    .select("id");

  if (error) {
    return {
      ok: false,
      error: error.message.includes("edits_unlocked")
        ? "Coluna edits_unlocked não encontrada no schema cache — se a migration 0004 já rodou, espere ~30s ou rode `NOTIFY pgrst, 'reload schema';` e tente de novo."
        : `Falhou: ${error.message}`,
    };
  }
  if (!data || data.length === 0) {
    return { ok: false, error: "Apostador não encontrado (0 linhas)." };
  }

  await logAdmin(admin.id, "user.edits_unlocked", "user", parsed.data.user_id, {
    unlocked: parsed.data.unlocked,
  });
  revalidatePath("/admin");
  revalidatePath("/apostas");
  return { ok: true };
}

/**
 * Trava todos os jogos que estão `reopened=true` (ex.: correção da Tcheca no
 * Grupo A). Mesma proteção contra falha silenciosa: se havia jogos abertos mas
 * nada foi travado, avisa que é provável problema de role/RLS.
 */
export async function lockReopenedMatches(): Promise<
  { ok: true; locked: number } | { ok: false; error: string }
> {
  const admin = await getAuthedAdmin();
  if (!admin) return { ok: false, error: "Acesso negado." };

  const db = createAdminClient();
  if (!db) {
    return {
      ok: false,
      error:
        "Falta a SUPABASE_SERVICE_ROLE_KEY na Vercel — adicione (Production) e refaça o deploy.",
    };
  }

  const { data: open, error: selErr } = await db
    .from("matches")
    .select("id")
    .eq("reopened", true);
  if (selErr) return { ok: false, error: selErr.message };

  const openCount = open?.length ?? 0;
  if (openCount === 0) return { ok: true, locked: 0 };

  const { data, error } = await db
    .from("matches")
    .update({ reopened: false })
    .eq("reopened", true)
    .select("id");
  if (error) return { ok: false, error: error.message };

  const locked = data?.length ?? 0;

  await logAdmin(admin.id, "match.lock_reopened", "match", admin.id, { locked });
  revalidatePath("/admin");
  revalidatePath("/apostas");
  return { ok: true, locked };
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
