// ============================================================
// Email diário do ranking — Bolão 26
// ------------------------------------------------------------
// Roda 1x/dia às 22:00 BRT (01:00 UTC) via GitHub Actions.
// Monta o ranking atual (view `rankings`) + os jogos encerrados
// no dia (BRT) e dispara por email para todos os participantes
// (quem está no ranking = pagamento aprovado).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY,
//      RESEND_FROM_EMAIL (opcional), APP_URL (opcional)
// ============================================================

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.RESEND_FROM_EMAIL || "Bolão 26 <bolao@empresta.com.br>";
const APP_URL = process.env.APP_URL || "https://bolao-copa-pu3k.vercel.app";

if (!SB_URL || !SB_KEY || !RESEND_KEY) {
  console.error("Faltam env vars (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / RESEND_API_KEY)");
  process.exit(1);
}

async function sb(path) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Início do dia BRT (UTC-3) em instante UTC — pra filtrar jogos "de hoje".
function startOfBrtTodayIso() {
  const brtNow = new Date(Date.now() - 3 * 3600 * 1000);
  const midnight = Date.UTC(brtNow.getUTCFullYear(), brtNow.getUTCMonth(), brtNow.getUTCDate());
  return new Date(midnight + 3 * 3600 * 1000).toISOString();
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function main() {
  const ranking = await sb("rankings?select=user_id,name,total_points,exact_hits,partial_hits,position&order=position.asc&limit=500");
  if (!ranking.length) {
    console.log("Ranking vazio (ninguém aprovado ainda) — nada a enviar.");
    return;
  }

  // Emails dos participantes ranqueados.
  const ids = ranking.map((r) => r.user_id);
  const users = await sb(`users?select=id,email&id=in.(${ids.join(",")})`);
  const emailById = new Map(users.map((u) => [u.id, u.email]));
  const recipients = ranking.map((r) => emailById.get(r.user_id)).filter(Boolean);

  // Jogos encerrados hoje (BRT).
  const startIso = startOfBrtTodayIso();
  const teams = await sb("teams?select=id,name");
  const nameById = new Map(teams.map((t) => [t.id, t.name]));
  const todays = await sb(
    `matches?select=home_team_id,away_team_id,home_score,away_score,finalized_at&status=eq.finished&finalized_at=gte.${startIso}&order=finalized_at.asc`,
  );

  if (!todays.length) {
    console.log("Nenhum jogo encerrado hoje (BRT) — pulando o email do dia.");
    return;
  }

  const dateLabel = new Date(Date.now() - 3 * 3600 * 1000).toLocaleDateString("pt-BR", {
    day: "2-digit", month: "2-digit",
  });

  const gamesHtml = todays
    .map(
      (m) => `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${esc(nameById.get(m.home_team_id))}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:center;font-weight:700;">${m.home_score} × ${m.away_score}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${esc(nameById.get(m.away_team_id))}</td>
      </tr>`,
    )
    .join("");

  const rankHtml = ranking
    .map(
      (r) => `<tr style="${r.position <= 3 ? "background:#f0fff5;" : ""}">
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-weight:700;color:${r.position <= 3 ? "#009739" : "#666"};">${r.position}º</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${esc(r.name || "—")}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${r.exact_hits}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-weight:700;">${r.total_points}</td>
      </tr>`,
    )
    .join("");

  const html = `
  <div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;color:#0a1f44;">
    <h2 style="color:#009739;margin-bottom:2px;">Bolão 26 — Ranking de ${dateLabel}</h2>
    <p style="color:#5a6a85;margin-top:0;">Resultados do dia e a classificação atualizada. Boa sorte! 🏆</p>

    <h3 style="margin:20px 0 6px;">Jogos de hoje</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">${gamesHtml}</table>

    <h3 style="margin:24px 0 6px;">Classificação geral</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead><tr style="background:#002776;color:#fff;">
        <th style="padding:6px 8px;text-align:left;">#</th>
        <th style="padding:6px 8px;text-align:left;">Jogador</th>
        <th style="padding:6px 8px;text-align:right;">Exatos</th>
        <th style="padding:6px 8px;text-align:right;">Pts</th>
      </tr></thead>
      <tbody>${rankHtml}</tbody>
    </table>

    <p style="margin-top:16px;"><a href="${APP_URL}/apostas" style="display:inline-block;background:#002776;color:#fff;padding:10px 18px;text-decoration:none;font-weight:bold;">Ver no site →</a></p>
    <p style="color:#8092ab;font-size:12px;">Pontuação: +3 placar exato · +1 vencedor/empate · 0 errou.</p>
  </div>`;

  // Dispara em lotes via bcc (até 45 por email) pra economizar chamadas.
  let sent = 0;
  for (const batch of chunk(recipients, 45)) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: [FROM.match(/<(.+)>/)?.[1] || FROM],
        bcc: batch,
        subject: `[Bolão 26] Ranking de ${dateLabel} 🏆`,
        html,
      }),
    });
    if (!res.ok) {
      console.error(`Resend ${res.status}: ${await res.text()}`);
    } else {
      sent += batch.length;
    }
  }

  console.log(`Email do ranking enviado para ${sent} participante(s). Jogos no resumo: ${todays.length}.`);
}

main().catch((e) => {
  console.error("FALHOU:", e.message);
  process.exit(1);
});
