"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

type ActionResult = { ok: true } | { ok: false; error: string };

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({
    p256dh: z.string().min(1).max(300),
    auth: z.string().min(1).max(100),
  }),
});

/**
 * Salva a inscrição de push do navegador/dispositivo (uma por endpoint).
 * RLS garante que cada um só grava a própria inscrição (auth.uid()).
 */
export async function savePushSubscription(input: unknown): Promise<ActionResult> {
  const parsed = subscriptionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Inscrição inválida." };

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: user.id,
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
    },
    { onConflict: "endpoint" },
  );

  if (error) {
    return {
      ok: false,
      error: error.message.includes("push_subscriptions")
        ? "Tabela push_subscriptions não existe — rode a migration 0005 no SQL Editor."
        : error.message,
    };
  }
  return { ok: true };
}

export async function removePushSubscription(input: unknown): Promise<ActionResult> {
  const parsed = z.object({ endpoint: z.string().url().max(1000) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Entrada inválida." };

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", parsed.data.endpoint);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
