"use server";

import { revalidatePath } from "next/cache";
import { waitUntil } from "@vercel/functions";
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
    // Nomeia os jogos sem palpite salvo — só dizer "faltam N" obrigava o
    // apostador a caçar qual era (caso Douglas: tela 72/72, banco com 71).
    const [{ data: preds }, { data: ms }, { data: ts }, { data: gs }] = await Promise.all([
      supabase.from("predictions").select("match_id").eq("user_id", user.id),
      supabase.from("matches").select("id, group_id, home_team_id, away_team_id"),
      supabase.from("teams").select("id, name"),
      supabase.from("groups").select("id, code"),
    ]);
    const have = new Set((preds ?? []).map((p) => p.match_id as string));
    const teamName = new Map((ts ?? []).map((t) => [t.id as string, t.name as string]));
    const groupCode = new Map((gs ?? []).map((g) => [g.id as string, g.code as string]));
    const missing = (ms ?? [])
      .filter((m) => !have.has(m.id as string))
      .map(
        (m) =>
          `Grupo ${groupCode.get(m.group_id as string) ?? "?"}: ${teamName.get(m.home_team_id as string) ?? "?"} × ${teamName.get(m.away_team_id as string) ?? "?"}`,
      );
    const shown = missing.slice(0, 3).join(" · ");
    const rest = missing.length > 3 ? ` e mais ${missing.length - 3} jogo(s)` : "";
    return {
      ok: false,
      error: `Falta salvar ${missing.length} palpite(s): ${shown}${rest}. Redigite o placar desse(s) jogo(s) (vai aparecer "Salvo") e confirme de novo.`,
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
  const receiptName = receipt.name || "comprovante";
  const receiptType = receipt.type;

  // Notifica admin em background — não bloqueia a resposta pro cliente.
  // waitUntil mantém a função serverless viva até o email completar.
  waitUntil(
    (async () => {
      try {
        const pdf = await buildUserBetsPdf(user.id);
        if (pdf) {
          await sendAdminPixNotification({
            user_name: pdf.name,
            user_email: pdf.email,
            pdfBytes: pdf.bytes,
            receipt: {
              buffer: receiptBuffer,
              filename: receiptName,
              contentType: receiptType,
            },
          });
        }
      } catch (e) {
        console.error("[submitPayment] notificação admin falhou", e);
      }
    })(),
  );

  revalidatePath("/apostas");
  return { ok: true };
}
