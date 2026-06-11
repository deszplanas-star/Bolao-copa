import { NextRequest, NextResponse } from "next/server";
import { sendPushEvents, type PushEvent } from "@/lib/push";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Dispara push pros inscritos. Chamada pelo ingest do GitHub Actions
// (fallback manual) e por testes. Auth: Bearer = SUPABASE_SERVICE_ROLE_KEY.
export async function POST(req: NextRequest) {
  const expected = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const got = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || got !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let events: PushEvent[];
  try {
    const body = await req.json();
    events = (body?.events ?? []).filter(
      (e: PushEvent) => typeof e?.title === "string" && typeof e?.body === "string",
    );
  } catch {
    return NextResponse.json({ error: "body inválido" }, { status: 400 });
  }
  if (events.length === 0) return NextResponse.json({ sent: 0, subs: 0 });

  const res = await sendPushEvents(events);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 500 });
  return NextResponse.json({ sent: res.sent, subs: res.subs, pruned: res.pruned });
}
