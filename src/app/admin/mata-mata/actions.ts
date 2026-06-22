"use server";

import { revalidatePath } from "next/cache";
import { waitUntil } from "@vercel/functions";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthedAdmin } from "@/lib/auth";
import { sendKoApprovalNotification } from "@/lib/email";

// ============================================================
// FASE 2 — ações de admin do mata-mata. Isoladas das ações da fase 1.
// ============================================================

type ActionResult = { ok: true } | { ok: false; error: string };

const idSchema = z.object({ payment_id: z.string().uuid() });
const denySchema = z.object({
  payment_id: z.string().uuid(),
  reason: z.string().min(1).max(500).optional(),
});
// Aceita ISO datetime OU string vazia (limpa o prazo).
const deadlineSchema = z.object({ champion_lock_at: z.string().max(40) });

async function logAdmin(adminId: string, action: string, targetId: string, payload: Record<string, unknown> = {}) {
  const db = createAdminClient() ?? createClient();
  await db.from("admin_logs").insert({
    admin_id: adminId,
    action,
    target_type: "ko",
    target_id: targetId,
    payload,
  });
}

export async function approveKoPayment(input: unknown): Promise<ActionResult> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Entrada inválida." };
  const admin = await getAuthedAdmin();
  if (!admin) return { ok: false, error: "Acesso negado." };

  const db = createAdminClient() ?? createClient();

  const { data: row } = await db
    .from("ko_payments")
    .select("user_id")
    .eq("id", parsed.data.payment_id)
    .maybeSingle();

  const { data, error } = await db
    .from("ko_payments")
    .update({
      status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: admin.id,
      denied_reason: null,
    })
    .eq("id", parsed.data.payment_id)
    .select("id");

  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "Pagamento não encontrado (0 linhas)." };

  await logAdmin(admin.id, "ko_payment.approve", parsed.data.payment_id);

  // Notifica o apostador em background.
  const uid = row?.user_id as string | undefined;
  if (uid) {
    waitUntil(
      (async () => {
        try {
          const { data: u } = await db.from("users").select("name,email").eq("id", uid).maybeSingle();
          if (u?.email) {
            await sendKoApprovalNotification({
              user_name: (u.name as string | null) ?? (u.email as string),
              user_email: u.email as string,
            });
          }
        } catch (e) {
          console.error("[approveKoPayment] notificação falhou", e);
        }
      })(),
    );
  }

  revalidatePath("/admin/mata-mata");
  return { ok: true };
}

export async function denyKoPayment(input: unknown): Promise<ActionResult> {
  const parsed = denySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Entrada inválida." };
  const admin = await getAuthedAdmin();
  if (!admin) return { ok: false, error: "Acesso negado." };

  const db = createAdminClient() ?? createClient();
  const { error } = await db
    .from("ko_payments")
    .update({
      status: "denied",
      denied_reason: parsed.data.reason ?? "Sem motivo informado",
      approved_at: null,
      approved_by: null,
    })
    .eq("id", parsed.data.payment_id);

  if (error) return { ok: false, error: error.message };
  await logAdmin(admin.id, "ko_payment.deny", parsed.data.payment_id, { reason: parsed.data.reason });
  revalidatePath("/admin/mata-mata");
  return { ok: true };
}

/**
 * Define (ou limpa) o prazo de trava do palpite de campeão. Mande uma string
 * ISO (ex.: "2026-06-28T16:00:00-03:00") ou "" pra deixar aberto.
 */
export async function setChampionDeadline(input: unknown): Promise<ActionResult> {
  const parsed = deadlineSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Entrada inválida." };
  const admin = await getAuthedAdmin();
  if (!admin) return { ok: false, error: "Acesso negado." };

  const raw = parsed.data.champion_lock_at.trim();
  let value: string | null = null;
  if (raw !== "") {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return { ok: false, error: "Data/hora inválida." };
    value = d.toISOString();
  }

  const db = createAdminClient() ?? createClient();
  const { error } = await db
    .from("ko_config")
    .upsert({ id: 1, champion_lock_at: value }, { onConflict: "id" });

  if (error) return { ok: false, error: error.message };
  await logAdmin(admin.id, "ko_config.champion_deadline", "1", { champion_lock_at: value });
  revalidatePath("/admin/mata-mata");
  revalidatePath("/copa");
  return { ok: true };
}

/**
 * Reapura TODOS os jogos finalizados + o campeão (chama a função recompute_all_ko
 * no banco). Útil após corrigir um placar à mão ou se um trigger não disparou.
 */
export async function recomputeKo(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const admin = await getAuthedAdmin();
  if (!admin) return { ok: false, error: "Acesso negado." };

  const db = createAdminClient();
  if (!db) {
    return {
      ok: false,
      error: "Falta a SUPABASE_SERVICE_ROLE_KEY na Vercel — adicione (Production) e refaça o deploy.",
    };
  }

  const { error } = await db.rpc("recompute_all_ko");
  if (error) return { ok: false, error: error.message };

  await logAdmin(admin.id, "ko.recompute_all", "1");
  revalidatePath("/admin/mata-mata");
  revalidatePath("/copa");
  return { ok: true };
}
