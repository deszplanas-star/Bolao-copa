"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

type ActionResult = { ok: true } | { ok: false; error: string };

export async function submitPayment(): Promise<ActionResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

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
  revalidatePath("/apostas");
  return { ok: true };
}
