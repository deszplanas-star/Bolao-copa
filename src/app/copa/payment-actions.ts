"use server";

import { revalidatePath } from "next/cache";
import { waitUntil } from "@vercel/functions";
import { createClient } from "@/lib/supabase/server";
import { sendKoPixNotification } from "@/lib/email";

// ============================================================
// FASE 2 — entrada paga (PIX manual, R$50), tabela ko_payments.
// Separada da fase 1: não exige ter palpitado em nada (aposta-se a cada
// rodada). Só registra o PIX + comprovante e avisa o admin pra aprovar.
// ============================================================

type ActionResult = { ok: true } | { ok: false; error: string };

const MAX_RECEIPT_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_RECEIPT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
]);

export async function submitKoPayment(formData: FormData): Promise<ActionResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  const receipt = formData.get("receipt");
  if (!(receipt instanceof File) || receipt.size === 0) {
    return { ok: false, error: "Anexe o comprovante de pagamento." };
  }
  if (receipt.size > MAX_RECEIPT_BYTES) {
    return { ok: false, error: "Comprovante muito grande (máx 5MB)." };
  }
  if (!ALLOWED_RECEIPT_TYPES.has(receipt.type)) {
    return { ok: false, error: "Formato inválido — use PNG, JPG, WEBP ou PDF." };
  }

  const amountCents = parseInt(process.env.NEXT_PUBLIC_PIX_AMOUNT ?? "50", 10) * 100;

  const { error } = await supabase.from("ko_payments").upsert(
    {
      user_id: user.id,
      amount_cents: amountCents,
      status: "pending",
      user_confirmed_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) return { ok: false, error: error.message };

  // Notifica admin em background — não bloqueia a resposta pro apostador.
  const receiptBuffer = Buffer.from(await receipt.arrayBuffer());
  const receiptName = receipt.name || "comprovante";
  const receiptType = receipt.type;
  const userName =
    (user.user_metadata?.full_name as string | undefined) ??
    (user.user_metadata?.name as string | undefined) ??
    user.email ??
    "Apostador";

  waitUntil(
    (async () => {
      try {
        await sendKoPixNotification({
          user_name: userName,
          user_email: user.email ?? "",
          receipt: {
            buffer: receiptBuffer,
            filename: receiptName,
            contentType: receiptType,
          },
        });
      } catch (e) {
        console.error("[submitKoPayment] notificação admin falhou", e);
      }
    })(),
  );

  revalidatePath("/copa");
  return { ok: true };
}
