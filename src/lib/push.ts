import webpush from "web-push";
import { createAdminClient } from "@/lib/supabase/admin";

export type PushEvent = {
  title: string;
  body: string;
  tag?: string;
  url?: string;
};

export type PushResult =
  | { ok: true; sent: number; subs: number; pruned: number }
  | { ok: false; error: string };

/**
 * Envia os eventos pra TODAS as inscrições de push e remove as mortas
 * (404/410 — app desinstalado ou permissão revogada). Usado pela rota
 * /api/notify-goals (chamada externa) e pelo /api/cron-ingest (in-process).
 */
export async function sendPushEvents(events: PushEvent[]): Promise<PushResult> {
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  const priv = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!pub || !priv) return { ok: false, error: "VAPID keys ausentes no ambiente" };
  webpush.setVapidDetails("mailto:deszplanas@gmail.com", pub, priv);

  const db = createAdminClient();
  if (!db) return { ok: false, error: "service role ausente" };

  const { data: subs, error } = await db
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth");
  if (error) return { ok: false, error: error.message };

  let sent = 0;
  const dead: string[] = [];

  for (const ev of events) {
    const payload = JSON.stringify({
      title: ev.title,
      body: ev.body,
      tag: ev.tag ?? "bolao26-gol",
      url: ev.url ?? "/apostas?tab=resultados",
    });
    await Promise.all(
      (subs ?? []).map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
          );
          sent++;
        } catch (e: unknown) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) dead.push(s.id as string);
        }
      }),
    );
  }

  if (dead.length > 0) {
    await db.from("push_subscriptions").delete().in("id", Array.from(new Set(dead)));
  }

  return { ok: true, sent, subs: subs?.length ?? 0, pruned: new Set(dead).size };
}
