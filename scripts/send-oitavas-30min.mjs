// One-off (04/07): comunicado do mata-mata pra todos os participantes com
// entrada aprovada — oitavas abertas (confrontos definidos) + prazo de
// fechamento ajustado de 1h para 30 MIN antes do apito.
// Rodar na pasta app/:  node --env-file=.env.local scripts/send-oitavas-30min.mjs
// Teste em um email só:  node --env-file=.env.local scripts/send-oitavas-30min.mjs so@email.com
import nodemailer from "nodemailer";

// .trim() em tudo: o .env.local é CRLF e o --env-file pode deixar \r no valor.
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const GMAIL_USER = process.env.GMAIL_USER?.trim();
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD?.trim();
const APP_URL = "https://bolao-copa-pu3k.vercel.app";
const onlyTo = process.argv[2] ?? null; // modo teste: 1 destinatário

if (!SB_URL || !SB_KEY || !GMAIL_USER || !GMAIL_PASS) {
  console.error("faltam envs (SUPABASE/GMAIL) — rodar com --env-file=.env.local");
  process.exit(1);
}

async function sb(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

const fmtKickoff = (iso) =>
  new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function main() {
  const [pays, users, oitavas] = await Promise.all([
    sb("ko_payments?select=user_id&status=eq.approved"),
    sb("users?select=id,name,email"),
    sb("ko_matches?stage=eq.LAST_16&select=home_name,away_name,kickoff_at&order=kickoff_at.asc"),
  ]);
  const byId = new Map(users.map((u) => [u.id, u]));
  let recipients = pays
    .map((p) => byId.get(p.user_id))
    .filter((u) => u?.email)
    .map((u) => ({ name: u.name ?? u.email, email: u.email }));
  if (onlyTo) recipients = [{ name: "TESTE", email: onlyTo }];

  const rows = oitavas
    .map(
      (m) => `
        <tr>
          <td style="padding:8px 12px; border-bottom:1px solid #e7ecf3; font-weight:700; color:#002776;">
            ${esc(m.home_name ?? "A definir")} × ${esc(m.away_name ?? "A definir")}
          </td>
          <td style="padding:8px 12px; border-bottom:1px solid #e7ecf3; text-align:right; color:#5a6a85; font-size:13px; white-space:nowrap;">
            ${m.kickoff_at ? fmtKickoff(m.kickoff_at) : "a definir"}
          </td>
        </tr>`,
    )
    .join("");

  const html = (firstName) => `
  <div style="max-width:560px; margin:0 auto; font-family:Arial,Helvetica,sans-serif; color:#1a1a1a; border:1px solid #d2dae5;">
    <div style="background:#002776; padding:22px 24px; border-bottom:4px solid #FFDF00;">
      <div style="color:#FFDF00; font-size:12px; letter-spacing:2px; text-transform:uppercase; font-weight:700;">Bolão do Planinhas · Copa 26</div>
      <div style="color:#ffffff; font-size:24px; font-weight:800; margin-top:6px;">Oitavas abertas! ⚽</div>
    </div>
    <div style="padding:24px;">
      <p style="margin-top:0;">Olá, ${esc(firstName)}! 👋</p>
      <p>Os confrontos das <strong>oitavas de final</strong> já estão no ar — incluindo o clássico <strong>Portugal × Espanha</strong> e <strong>Argentina × Egito</strong>. Corre pra registrar seus palpites:</p>
      <table style="width:100%; border-collapse:collapse; margin:16px 0; background:#f5f7fa;">
        ${rows}
      </table>
      <div style="background:#fff9dc; border-left:4px solid #FFDF00; padding:14px 16px; margin:18px 0; font-size:14px;">
        <strong style="color:#002776;">⏰ Novo prazo:</strong> as apostas de cada jogo agora fecham
        <strong>30 minutos antes do apito</strong> (antes era 1h). Mais tempo pra decidir — mas não deixa pra última hora!
      </div>
      <div style="background:#f4f6f9; border-left:4px solid #009739; padding:14px 16px; margin:18px 0; font-size:14px;">
        <strong style="color:#002776;">Lembrete da pontuação nas oitavas+:</strong><br/>
        São <strong>3 placares</strong> por jogo — tempo normal, prorrogação (placar somado) e pênaltis.<br/>
        🎯 Exato: <strong>+3</strong> cada · ✅ Resultado/quem avança: <strong>+1</strong> cada — até <strong>9 pts</strong> num jogo só.
      </div>
      <p style="text-align:center; margin:26px 0 8px;">
        <a href="${APP_URL}/copa" style="background:#009739; color:#ffffff; text-decoration:none; font-weight:800; padding:13px 30px; display:inline-block;">FAZER MEUS PALPITES</a>
      </p>
      <p style="color:#8092ab; font-size:12px; text-align:center; margin-top:18px;">Boa sorte! 🍀 — Bolão do Planinhas</p>
    </div>
  </div>`;

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });

  let ok = 0;
  let fail = 0;
  for (const r of recipients) {
    const firstName = String(r.name).trim().split(/\s+/)[0];
    try {
      await transporter.sendMail({
        from: `Bolão 26 <${GMAIL_USER}>`,
        to: r.email,
        subject: "🏆 Oitavas abertas — Portugal×Espanha no ar · apostas fecham 30 min antes",
        html: html(firstName),
      });
      ok++;
      console.log(`ok  ${r.email}`);
    } catch (e) {
      fail++;
      console.log(`ERRO ${r.email}: ${e.message}`);
    }
  }
  console.log(`\nenviados=${ok} falhas=${fail} (de ${recipients.length})`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FALHOU:", e.message);
  process.exit(1);
});
