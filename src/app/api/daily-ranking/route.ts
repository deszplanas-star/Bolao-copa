import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ============================================================
// Email diário do ranking (07:00 BRT), disparado pelo n8n.
// Conteúdo da manhã: jogos encerrados nas últimas 24h + ranking
// parcial. Só envia se houve jogo no período. Substitui o cron das
// 22:00 do GitHub Actions (atrasava horas).
// Auth: Bearer = CRON_SECRET ou SUPABASE_SERVICE_ROLE_KEY.
// ============================================================

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://bolao-copa-pu3k.vercel.app";

function esc(s: unknown) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
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

  const { data: ranking, error: rErr } = await db
    .from("rankings")
    .select("user_id, name, total_points, exact_hits, partial_hits, position, penalty_points")
    .order("position", { ascending: true })
    .limit(500);
  if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 });
  if (!ranking?.length) return NextResponse.json({ skip: "ranking vazio" });

  // Jogos encerrados nas últimas 24h (cobre "ontem" no disparo das 07:00)
  const sinceIso = new Date(now - 24 * 3600 * 1000).toISOString();
  const [{ data: teams }, { data: games }] = await Promise.all([
    db.from("teams").select("id, name"),
    db
      .from("matches")
      .select("home_team_id, away_team_id, home_score, away_score, finalized_at")
      .eq("status", "finished")
      .gte("finalized_at", sinceIso)
      .order("finalized_at", { ascending: true }),
  ]);
  if (!games?.length) return NextResponse.json({ skip: "sem jogos nas últimas 24h" });

  const nameById = new Map((teams ?? []).map((t) => [t.id as string, t.name as string]));
  const ids = ranking.map((r) => r.user_id as string);
  const { data: users } = await db.from("users").select("id, email").in("id", ids);
  const emailById = new Map((users ?? []).map((u) => [u.id as string, u.email as string]));
  const recipients = ranking.map((r) => emailById.get(r.user_id as string)).filter(Boolean) as string[];

  const dateLabel = new Date(now - 3 * 3600 * 1000).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
  });

  const gamesHtml = games
    .map(
      (m) => `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${esc(nameById.get(m.home_team_id as string))}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:center;font-weight:700;">${m.home_score} × ${m.away_score}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${esc(nameById.get(m.away_team_id as string))}</td>
      </tr>`,
    )
    .join("");

  const rankHtml = ranking
    .map(
      (r) => `<tr style="${(r.position as number) <= 3 ? "background:#f0fff5;" : ""}">
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-weight:700;color:${(r.position as number) <= 3 ? "#009739" : "#666"};">${r.position}º</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${esc(r.name || "—")}${(r.penalty_points as number) > 0 ? " ⚖️" : ""}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${r.exact_hits}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-weight:700;">${r.total_points}</td>
      </tr>`,
    )
    .join("");

  const html = `
  <div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;color:#0a1f44;">
    <h2 style="color:#009739;margin-bottom:2px;">Bolão 26 — Parcial de ${dateLabel} ☕</h2>
    <p style="color:#5a6a85;margin-top:0;">Bom dia! Resultados de ontem e a classificação parcial do bolão.</p>

    <h3 style="margin:20px 0 6px;">Jogos de ontem</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">${gamesHtml}</table>

    <h3 style="margin:24px 0 6px;">Classificação parcial</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead><tr style="background:#002776;color:#fff;">
        <th style="padding:6px 8px;text-align:left;">#</th>
        <th style="padding:6px 8px;text-align:left;">Jogador</th>
        <th style="padding:6px 8px;text-align:right;">Exatos</th>
        <th style="padding:6px 8px;text-align:right;">Pts</th>
      </tr></thead>
      <tbody>${rankHtml}</tbody>
    </table>

    <p style="margin-top:16px;"><a href="${APP_URL}/apostas?tab=ranking" style="display:inline-block;background:#002776;color:#fff;padding:10px 18px;text-decoration:none;font-weight:bold;">Ver ranking ao vivo →</a></p>
    <p style="color:#8092ab;font-size:12px;">Pontuação: +3 placar exato · +1 vencedor/empate · 0 errou. ⚖️ = punição aplicada pelo admin.</p>
  </div>`;

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

  let sent = 0;
  const errors: string[] = [];
  for (const batch of chunk(recipients, 45)) {
    try {
      await transporter.sendMail({
        from: process.env.GMAIL_FROM ?? `Bolão 26 <${GMAIL_USER}>`,
        to: GMAIL_USER,
        bcc: batch,
        subject: `[Bolão 26] Parcial do ranking — ${dateLabel} ☕🏆`,
        html,
      });
      sent += batch.length;
    } catch (e) {
      errors.push((e as Error).message.slice(0, 120));
    }
  }

  return NextResponse.json({ sent, jogos: games.length, errors });
}
