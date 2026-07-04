import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ============================================================
// Email "tempo acabando" do MATA-MATA. Dispara quando um jogo entra na
// janela de 1h antes do apito e vai SÓ pra quem ainda NÃO preencheu o
// palpite (ou deixou incompleto — ex.: sem o placar dos 90 min nas
// oitavas+), lembrando que a aposta trava 30 min antes. Idempotente:
// registra em admin_logs (action='ko_missing_email') e nunca repete.
// Disparado pelo n8n a cada ~2 min. Auth: Bearer = CRON_SECRET ou service key.
// ============================================================

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://bolao-copa-pu3k.vercel.app";
const REMIND_MS = 60 * 60 * 1000; // 1h antes: abre a janela do lembrete
const LOCK_MS = 30 * 60 * 1000; // 30 min antes: trava da aposta (fim da janela)

function esc(s: unknown) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtKickoff(iso: string) {
  return new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export async function POST(req: NextRequest) {
  const got = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const cron = process.env.CRON_SECRET?.trim();
  if (!got || !((cron && got === cron) || (svc && got === svc))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  if (now < Date.parse("2026-06-11T00:00:00Z") || now > Date.parse("2026-07-21T23:59:59Z")) {
    return NextResponse.json({ skip: "fora da janela do torneio" });
  }

  const db = createAdminClient();
  if (!db) return NextResponse.json({ error: "service role ausente" }, { status: 500 });

  // 1) Jogos entre 1h e 30 min do apito (aposta ainda ABERTA — depois da trava
  //    o lembrete seria mentira). Só confrontos com os dois times definidos.
  const openIso = new Date(now + LOCK_MS).toISOString();
  const limitIso = new Date(now + REMIND_MS).toISOString();
  const { data: koMatches, error: kmErr } = await db
    .from("ko_matches")
    .select("id, stage, home_name, away_name, kickoff_at, status")
    .eq("status", "scheduled")
    .not("kickoff_at", "is", null)
    .gt("kickoff_at", openIso)
    .lte("kickoff_at", limitIso);
  if (kmErr) return NextResponse.json({ error: kmErr.message }, { status: 500 });
  const candidates = (koMatches ?? []).filter((m) => m.home_name && m.away_name);
  if (candidates.length === 0) return NextResponse.json({ skip: "nenhum jogo na janela de 1h" });

  // 2) Dedup por jogo (admin_logs).
  const ids = candidates.map((m) => m.id as string);
  const { data: sentLogs } = await db
    .from("admin_logs")
    .select("target_id")
    .eq("action", "ko_missing_email")
    .in("target_id", ids);
  const alreadySent = new Set((sentLogs ?? []).map((l) => l.target_id as string));
  const toCheck = candidates.filter((m) => !alreadySent.has(m.id as string));
  if (toCheck.length === 0) return NextResponse.json({ skip: "todos já lembrados" });

  // 3) Participantes = entrada aprovada.
  const { data: pays } = await db.from("ko_payments").select("user_id").eq("status", "approved");
  const participantIds = Array.from(new Set((pays ?? []).map((p) => p.user_id as string)));
  if (participantIds.length === 0) return NextResponse.json({ skip: "sem participantes aprovados" });
  const { data: users } = await db
    .from("users")
    .select("id, name, email")
    .in("id", participantIds);
  const participants = ((users ?? []) as { id: string; name: string | null; email: string | null }[])
    .filter((u) => u.email)
    .map((u) => ({ id: u.id, name: u.name || "Participante", email: u.email as string }));

  const { data: adminRow } = await db
    .from("users")
    .select("id")
    .eq("role", "admin")
    .limit(1)
    .maybeSingle();
  const adminId = (adminRow?.id as string | undefined) ?? participants[0]?.id;

  const GMAIL_USER = process.env.GMAIL_USER;
  const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;
  if (!GMAIL_USER || !GMAIL_PASS) {
    return NextResponse.json({ error: "GMAIL_USER/GMAIL_APP_PASSWORD ausentes" }, { status: 500 });
  }
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });

  const results: { match: string; lembretes: number }[] = [];
  const errors: string[] = [];

  for (const m of toCheck) {
    const matchId = m.id as string;
    const newModel = (m.stage as string) !== "LAST_32"; // oitavas+ exigem o placar dos 90 min

    const { data: preds } = await db
      .from("ko_predictions")
      .select("user_id, home_score, away_score, pen_home, pen_away, reg_home, reg_away")
      .eq("ko_match_id", matchId);
    const predByUser = new Map((preds ?? []).map((p) => [p.user_id as string, p]));

    // "Não preencheu" = sem linha OU palpite incompleto pro modelo da fase.
    const missing = participants
      .map((p) => {
        const pr = predByUser.get(p.id);
        if (!pr) return { ...p, reason: "sem palpite" };
        const baseOk =
          pr.home_score != null && pr.away_score != null && pr.pen_home != null && pr.pen_away != null;
        const regOk = !newModel || (pr.reg_home != null && pr.reg_away != null);
        if (!baseOk) return { ...p, reason: "palpite incompleto" };
        if (!regOk) return { ...p, reason: "falta o placar do tempo normal (90 min)" };
        return null;
      })
      .filter(Boolean) as { id: string; name: string; email: string; reason: string }[];

    const title = `${m.home_name} × ${m.away_name}`;
    const kickoff = m.kickoff_at as string;
    const lockAt = new Date(new Date(kickoff).getTime() - LOCK_MS).toISOString();

    if (missing.length === 0) {
      // Todo mundo preencheu — registra o dedup mesmo assim pra não re-checar
      // esse jogo a cada 2 min até a trava.
      await db.from("admin_logs").insert({
        admin_id: adminId,
        action: "ko_missing_email",
        target_type: "ko_match",
        target_id: matchId,
        payload: { missing: 0, title },
      });
      results.push({ match: title, lembretes: 0 });
      continue;
    }

    let sent = 0;
    for (const p of missing) {
      const firstName = p.name.trim().split(/\s+/)[0];
      const html = `
      <div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:#0a1f44;">
        <h2 style="color:#b00020;margin-bottom:2px;">⏰ Tempo acabando, ${esc(firstName)}!</h2>
        <p style="color:#5a6a85;margin-top:0;">
          Você ainda <b>não preencheu seu palpite</b> para
          <b>${esc(title)}</b> — hoje, ${esc(fmtKickoff(kickoff))} (BRT).
          ${p.reason !== "sem palpite" ? `<br/><i>(${esc(p.reason)})</i>` : ""}
        </p>
        <div style="background:#fff3f3;border-left:4px solid #b00020;padding:12px 16px;margin:14px 0;font-size:15px;">
          As apostas deste jogo <b>travam às ${esc(fmtTime(lockAt))}</b> (30 min antes do apito).
          Você tem <b>cerca de 30 minutos</b> pra registrar o palpite!
        </div>
        <p style="margin-top:16px;"><a href="${APP_URL}/copa" style="display:inline-block;background:#009739;color:#fff;padding:12px 24px;text-decoration:none;font-weight:bold;">PREENCHER AGORA →</a></p>
        <p style="color:#8092ab;font-size:12px;">Sem palpite = zero ponto no jogo. Corre! 🏃 · Bolão do Planinhas</p>
      </div>`;
      try {
        await transporter.sendMail({
          from: process.env.GMAIL_FROM ?? `Bolão 26 <${GMAIL_USER}>`,
          to: p.email,
          subject: `⏰ Faltam 30 min pra fechar ${title} — seu palpite está em branco!`,
          html,
        });
        sent++;
      } catch (e) {
        errors.push(`${title} → ${p.email}: ${(e as Error).message.slice(0, 120)}`);
      }
    }

    await db.from("admin_logs").insert({
      admin_id: adminId,
      action: "ko_missing_email",
      target_type: "ko_match",
      target_id: matchId,
      payload: { missing: missing.length, sent, title },
    });
    results.push({ match: title, lembretes: sent });
  }

  return NextResponse.json({ enviados: results, errors });
}
