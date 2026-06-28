import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ============================================================
// Email "apostas fechadas" do MATA-MATA. Dispara quando um jogo entra na
// última 1h antes do apito (= momento em que a aposta fecha, KO_CUTOFF_MS).
// Manda pra TODOS os participantes (entrada da fase 2 aprovada) uma tabela
// com o palpite de cada um naquele jogo. Idempotente: registra o envio em
// admin_logs (action='ko_bets_email', target_id=ko_match_id) e nunca repete.
// Disparado pelo n8n a cada ~2 min. Auth: Bearer = CRON_SECRET ou service key.
// ============================================================

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://bolao-copa-pu3k.vercel.app";
const CUTOFF_MS = 60 * 60 * 1000; // 1h antes — igual à trava das apostas do mata-mata

function esc(s: unknown) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

  // 1) Jogos do mata-mata que ENTRARAM na última 1h (aposta fechando) e ainda
  //    não começaram. Só os que já têm os dois times definidos.
  const limitIso = new Date(now + CUTOFF_MS).toISOString();
  const nowIso = new Date(now).toISOString();
  const { data: koMatches, error: kmErr } = await db
    .from("ko_matches")
    .select("id, home_name, away_name, kickoff_at, stage, status")
    .eq("status", "scheduled")
    .not("kickoff_at", "is", null)
    .gt("kickoff_at", nowIso)
    .lte("kickoff_at", limitIso);
  if (kmErr) return NextResponse.json({ error: kmErr.message }, { status: 500 });
  const candidates = (koMatches ?? []).filter((m) => m.home_name && m.away_name);
  if (candidates.length === 0) return NextResponse.json({ skip: "nenhum jogo fechando agora" });

  // 2) Dedup: quais desses já tiveram o email enviado (admin_logs).
  const ids = candidates.map((m) => m.id as string);
  const { data: sentLogs } = await db
    .from("admin_logs")
    .select("target_id")
    .eq("action", "ko_bets_email")
    .in("target_id", ids);
  const alreadySent = new Set((sentLogs ?? []).map((l) => l.target_id as string));
  const toSend = candidates.filter((m) => !alreadySent.has(m.id as string));
  if (toSend.length === 0) return NextResponse.json({ skip: "todos já notificados" });

  // 3) Participantes do mata-mata = entrada (ko_payments) aprovada.
  const { data: pays } = await db.from("ko_payments").select("user_id").eq("status", "approved");
  const participantIds = Array.from(new Set((pays ?? []).map((p) => p.user_id as string)));
  if (participantIds.length === 0) return NextResponse.json({ skip: "sem participantes aprovados" });
  const { data: users } = await db
    .from("users")
    .select("id, name, email")
    .in("id", participantIds);
  const participants = (users ?? []).map((u) => ({
    id: u.id as string,
    name: (u.name as string) || "Sem nome",
    email: (u.email as string) || "",
  }));
  const recipients = participants.map((p) => p.email).filter(Boolean);
  if (recipients.length === 0) return NextResponse.json({ skip: "sem emails de participantes" });

  // admin_id pro registro de dedup (admin_logs costuma exigir um uuid válido).
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

  const results: { match: string; sent: number }[] = [];
  const errors: string[] = [];

  for (const m of toSend) {
    const matchId = m.id as string;
    // Palpites de TODOS naquele jogo.
    const { data: preds } = await db
      .from("ko_predictions")
      .select("user_id, home_score, away_score, pen_home, pen_away")
      .eq("ko_match_id", matchId);
    const predByUser = new Map((preds ?? []).map((p) => [p.user_id as string, p]));

    const title = `${m.home_name} × ${m.away_name}`;
    const rowsHtml = participants
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
      .map((p) => {
        const pr = predByUser.get(p.id);
        let palpite = '<span style="color:#b00;">sem palpite</span>';
        if (pr) {
          const pen =
            pr.pen_home !== null && pr.pen_away !== null
              ? ` <span style="color:#888;">(pên ${pr.pen_home}-${pr.pen_away})</span>`
              : "";
          palpite = `<b>${pr.home_score} × ${pr.away_score}</b>${pen}`;
        }
        return `<tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;">${esc(p.name)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:center;">${palpite}</td>
        </tr>`;
      })
      .join("");

    const html = `
    <div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;color:#0a1f44;">
      <h2 style="color:#FF8C00;margin-bottom:2px;">🏆 Apostas fechadas · Mata-mata</h2>
      <p style="color:#5a6a85;margin-top:0;">
        <b>${esc(title)}</b> — ${esc(fmtKickoff(m.kickoff_at as string))} (BRT). As apostas
        deste jogo acabaram de fechar (1h antes do apito). Veja o palpite de cada um:
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <thead><tr style="background:#002776;color:#fff;">
          <th style="padding:6px 8px;text-align:left;">Participante</th>
          <th style="padding:6px 8px;text-align:center;">Palpite</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <p style="margin-top:16px;"><a href="${APP_URL}/copa" style="display:inline-block;background:#002776;color:#fff;padding:10px 18px;text-decoration:none;font-weight:bold;">Abrir o mata-mata →</a></p>
      <p style="color:#8092ab;font-size:12px;">Boa sorte! 🍀 · Bolão do Planinhas</p>
    </div>`;

    try {
      await transporter.sendMail({
        from: process.env.GMAIL_FROM ?? `Bolão 26 <${GMAIL_USER}>`,
        to: GMAIL_USER,
        bcc: recipients,
        subject: `[Bolão 26] Apostas fechadas: ${title} 🏆`,
        html,
      });
      await db.from("admin_logs").insert({
        admin_id: adminId,
        action: "ko_bets_email",
        target_type: "ko_match",
        target_id: matchId,
        payload: { recipients: recipients.length, title },
      });
      results.push({ match: title, sent: recipients.length });
    } catch (e) {
      errors.push(`${title}: ${(e as Error).message.slice(0, 140)}`);
    }
  }

  return NextResponse.json({ enviados: results, errors });
}
