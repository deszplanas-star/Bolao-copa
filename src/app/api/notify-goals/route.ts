import { NextRequest, NextResponse } from "next/server";
import webpush from "web-push";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Chamada pelo ingest-results.mjs (GitHub Actions) quando um placar muda.
// Auth: Bearer = SUPABASE_SERVICE_ROLE_KEY — o ingest já tem essa secret,
// então não precisamos criar/distribuir um token novo.
type GoalEvent = {
  title: string;
  body: string;
  tag?: string;
};

export async function POST(req: NextRequest) {
  const expected = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const got = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || got !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  const priv = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!pub || !priv) {
    return NextResponse.json({ error: "VAPID keys ausentes no ambiente" }, { status: 500 });
  }
  webpush.setVapidDetails("mailto:deszplanas@gmail.com", pub, priv);

  let events: GoalEvent[];
  try {
    const body = await req.json();
    events = (body?.events ?? []).filter(
      (e: GoalEvent) => typeof e?.title === "string" && typeof e?.body === "string",
    );
  } catch {
    return NextResponse.json({ error: "body inválido" }, { status: 400 });
  }
  if (events.length === 0) return NextResponse.json({ sent: 0, subs: 0 });

  const db = createAdminClient();
  if (!db) {
    return NextResponse.json({ error: "service role ausente" }, { status: 500 });
  }

  const { data: subs, error } = await db
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let sent = 0;
  const dead: string[] = [];

  for (const ev of events) {
    const payload = JSON.stringify({
      title: ev.title,
      body: ev.body,
      tag: ev.tag ?? "bolao26-gol",
      url: "/apostas",
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
          // 404/410 = inscrição morta (app desinstalado, permissão revogada)
          if (code === 404 || code === 410) dead.push(s.id as string);
        }
      }),
    );
  }

  if (dead.length > 0) {
    await db.from("push_subscriptions").delete().in("id", Array.from(new Set(dead)));
  }

  return NextResponse.json({ sent, subs: subs?.length ?? 0, pruned: new Set(dead).size });
}
