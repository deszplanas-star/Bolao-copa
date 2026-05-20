"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { buildUserBetsPdf } from "@/lib/bets-pdf";
import { sendAdminPixNotification } from "@/lib/email";

type ActionResult = { ok: true } | { ok: false; error: string };

const MAX_RECEIPT_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_RECEIPT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
]);

export async function submitPayment(formData: FormData): Promise<ActionResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  // Validar comprovante
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

  // Trava: precisa ter os 72 palpites preenchidos
  const [{ count: predCount }, { count: matchCount }] = await Promise.all([
    supabase
      .from("predictions")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id),
    supabase.from("matches").select("*", { count: "exact", head: true }),
  ]);

  if ((predCount ?? 0) < (matchCount ?? 0)) {
    return {
      ok: false,
      error: `Faltam ${(matchCount ?? 0) - (predCount ?? 0)} palpite(s) para ativar a aposta.`,
    };
  }

  const amountCents = parseInt(process.env.NEXT_PUBLIC_PIX_AMOUNT ?? "50", 10) * 100;

  const { error } = await supabase.from("payments").upsert(
    {
      user_id: user.id,
      amount_cents: amountCents,
      status: "pending",
      user_confirmed_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) return { ok: false, error: error.message };

  // Lê o arquivo do comprovante como Buffer
  const receiptBuffer = Buffer.from(await receipt.arrayBuffer());

  // Notifica admin com PDF das apostas + comprovante de pagamento
  try {
    const pdf = await buildUserBetsPdf(user.id);
    if (pdf) {
      await sendAdminPixNotification({
        user_name: pdf.name,
        user_email: pdf.email,
        pdfBytes: pdf.bytes,
        receipt: {
          buffer: receiptBuffer,
          filename: receipt.name || "comprovante",
          contentType: receipt.type,
        },
      });
    }
  } catch (e) {
    console.error("[submitPayment] notificação admin falhou", e);
  }

  revalidatePath("/apostas");
  return { ok: true };
}
