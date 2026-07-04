import nodemailer from "nodemailer";
import { WHATSAPP_GROUP_URL } from "@/lib/pdf";

// Envio via Gmail SMTP (sem necessidade de domínio verificado).
// Configurar no ambiente: GMAIL_USER (ex.: deszplanas@gmail.com) e
// GMAIL_APP_PASSWORD (Senha de app do Google, 16 caracteres).
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;
const fromEmail =
  process.env.GMAIL_FROM ?? (GMAIL_USER ? `Bolão 26 <${GMAIL_USER}>` : "Bolão 26");
const adminEmail =
  process.env.ADMIN_NOTIFICATION_EMAIL ??
  process.env.ADMIN_EMAILS?.split(",")[0]?.trim() ??
  GMAIL_USER ??
  "deszplanas@gmail.com";

function transport() {
  if (!GMAIL_USER || !GMAIL_PASS) return null;
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });
}

type Attachment = { filename: string; content: Buffer };

async function send(opts: {
  to: string;
  subject: string;
  html: string;
  attachments?: Attachment[];
}): Promise<boolean> {
  const t = transport();
  if (!t) {
    console.warn("[email] GMAIL_USER/GMAIL_APP_PASSWORD ausentes — skipping");
    return false;
  }
  try {
    await t.sendMail({
      from: fromEmail,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      attachments: opts.attachments,
    });
    return true;
  } catch (e) {
    console.error("[email] envio falhou", e);
    return false;
  }
}

type SendInput = {
  user_name: string;
  user_email: string;
  pdfBytes: Uint8Array;
};

type AdminSendInput = SendInput & {
  receipt?: {
    buffer: Buffer;
    filename: string;
    contentType: string;
  };
};

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://bolao-copa-pu3k.vercel.app";

export async function sendAdminPixNotification(input: AdminSendInput): Promise<void> {
  const subject = `[Bolão 26] Novo Pix recebido — ${input.user_name}`;
  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto;">
      <h2 style="color: #009739; margin-bottom: 4px;">Novo Pix recebido</h2>
      <p style="color: #5a6a85; margin-top: 0;">Apostador aguardando sua aprovação no painel /admin.</p>
      <hr style="border: none; border-top: 1px solid #d2dae5; margin: 16px 0;" />
      <p style="margin: 4px 0;"><strong>Nome:</strong> ${escapeHtml(input.user_name)}</p>
      <p style="margin: 4px 0;"><strong>Email:</strong> ${escapeHtml(input.user_email)}</p>
      <p style="margin: 4px 0;"><strong>Valor:</strong> R$ ${process.env.NEXT_PUBLIC_PIX_AMOUNT ?? "50"},00</p>
      <p style="margin: 16px 0; color: #5a6a85;">Os 72 palpites estão no PDF anexo. O comprovante de pagamento também segue em anexo para conferência com sua conta.</p>
      <a href="${APP_URL}/admin" style="display:inline-block;background:#002776;color:white;padding:10px 18px;text-decoration:none;font-weight:bold;">Abrir painel admin →</a>
    </div>
  `;

  const attachments: Attachment[] = [
    {
      filename: `apostas-${slugify(input.user_name)}.pdf`,
      content: Buffer.from(input.pdfBytes),
    },
  ];

  if (input.receipt) {
    const ext = guessExt(input.receipt.contentType, input.receipt.filename);
    attachments.push({
      filename: `comprovante-${slugify(input.user_name)}${ext}`,
      content: input.receipt.buffer,
    });
  }

  await send({ to: adminEmail, subject, html, attachments });
}

function guessExt(contentType: string, filename: string): string {
  const fromName = filename.match(/\.[a-z0-9]{2,5}$/i)?.[0];
  if (fromName) return fromName.toLowerCase();
  if (contentType === "application/pdf") return ".pdf";
  if (contentType === "image/png") return ".png";
  if (contentType === "image/jpeg") return ".jpg";
  if (contentType === "image/webp") return ".webp";
  return "";
}

export async function sendUserApprovalNotification(input: SendInput): Promise<boolean> {
  const subject = `[Bolão 26] Sua participação foi aprovada 🎉`;
  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto;">
      <h2 style="color: #009739; margin-bottom: 4px;">Aposta ativa</h2>
      <p style="color: #5a6a85; margin-top: 0;">Olá, ${escapeHtml(input.user_name.split(" ")[0])}.</p>
      <p>Confirmamos seu Pix e sua participação no Bolão da Copa 2026 está ativa.</p>
      <p>Os 72 palpites que você registrou estão no PDF anexo, para sua conferência.</p>
      <hr style="border: none; border-top: 1px solid #d2dae5; margin: 16px 0;" />
      <p style="color: #5a6a85;"><strong>Lembrete:</strong> a partir de agora seus palpites estão selados e não podem mais ser editados.</p>
      <p style="color: #5a6a85;">A Copa começa em 11 de junho. Boa sorte!</p>
      <a href="${APP_URL}/apostas" style="display:inline-block;background:#002776;color:white;padding:10px 18px;text-decoration:none;font-weight:bold;margin-top:8px;">Ver minhas apostas →</a>
    </div>
  `;

  return send({
    to: input.user_email,
    subject,
    html,
    attachments: [
      {
        filename: `apostas-${slugify(input.user_name)}.pdf`,
        content: Buffer.from(input.pdfBytes),
      },
    ],
  });
}

/**
 * Aviso pros apostadores de que uma seleção do Grupo A foi corrigida
 * (Dinamarca → República Tcheca) e os jogos dela foram reabertos pra
 * eles revisarem o placar. Sem anexo — só o link de volta pra plataforma.
 */
export async function sendCzechFixNotice(input: {
  user_name: string;
  user_email: string;
}): Promise<boolean> {
  const subject = `[Bolão 26] Ajuste no seu palpite — Grupo A (República Tcheca)`;
  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto;">
      <h2 style="color: #009739; margin-bottom: 4px;">Precisamos de um ajuste rápido no seu bolão</h2>
      <p style="color: #5a6a85; margin-top: 0;">Olá, ${escapeHtml(input.user_name.split(" ")[0])}.</p>
      <p>Tivemos um erro de cadastro no <strong>Grupo A</strong>: a seleção que aparecia como
      <strong>Dinamarca</strong> na verdade é a <strong>República Tcheca</strong> — a Dinamarca
      não está nesse grupo.</p>
      <p>Como isso muda o adversário em alguns jogos, <strong>reabrimos esses jogos só pra você
      revisar o placar</strong>, mesmo com a aposta já confirmada.</p>
      <hr style="border: none; border-top: 1px solid #d2dae5; margin: 16px 0;" />
      <p style="color: #5a6a85;"><strong>O que fazer:</strong> entre na plataforma, vá no Grupo A,
      confira/ajuste o placar dos jogos marcados como reabertos e clique em
      <strong style="color:#009739;">Enviar atualizado</strong>. Não precisa reenviar comprovante —
      os demais palpites continuam do jeito que você deixou.</p>
      <a href="${APP_URL}/apostas" style="display:inline-block;background:#002776;color:white;padding:10px 18px;text-decoration:none;font-weight:bold;margin-top:8px;">Revisar meu palpite →</a>
      <p style="color: #8092ab; font-size: 12px; margin-top: 16px;">Se você concordar com o placar que já estava, é só reenviar do mesmo jeito. Qualquer dúvida, responda este email.</p>
    </div>
  `;

  return send({ to: input.user_email, subject, html });
}

/**
 * Email de contagem regressiva pra estreia da Copa, com o PDF dos palpites
 * em anexo. `daysLeft` é calculado pelo servidor (dias até o 1º jogo) e a
 * chamada adapta o tom ("faltam N dias" / "é amanhã" / "é hoje").
 */
export async function sendCountdownEmail(input: {
  user_name: string;
  user_email: string;
  pdfBytes: Uint8Array;
  daysLeft: number;
}): Promise<boolean> {
  const d = input.daysLeft;
  const phraseSubject = d <= 0 ? "É HOJE" : d === 1 ? "É amanhã" : `Faltam ${d} dias`;
  const headline =
    d <= 0 ? "É hoje! A bola vai rolar ⚽" : d === 1 ? "É amanhã! ⚽" : `Faltam ${d} dias 🏆`;
  const firstName = escapeHtml(input.user_name.split(" ")[0]);
  const subject = `⚽ ${phraseSubject} para a Copa — seus palpites estão selados!`;

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto; border: 1px solid #d2dae5;">
      <div style="background:#002776; padding:28px 24px; text-align:center;">
        <div style="font-size:12px; letter-spacing:2px; text-transform:uppercase; color:#FFDF00; font-weight:bold;">Bolão da Copa · 2026</div>
        <div style="color:#ffffff; font-size:26px; font-weight:800; margin-top:8px;">${headline}</div>
      </div>
      <div style="padding:24px;">
        <p style="margin-top:0;">Olá, ${firstName}! 👋</p>
        <p>A espera está no fim — a Copa vai começar e o seu bolão entra em campo de vez. Seus <strong>72 palpites já estão selados</strong> e guardados a sete chaves. 🔒</p>
        <p>Pra você relembrar onde apostou suas fichas, <strong>vai em anexo o PDF com todos os seus palpites</strong>. Dá uma última conferida e já começa a torcer!</p>
        <div style="background:#f4f6f9; border-left:4px solid #009739; padding:14px 16px; margin:18px 0; font-size:14px;">
          <strong style="color:#002776;">Como você pontua:</strong><br/>
          🎯 Placar exato: <strong>+3 pontos</strong><br/>
          ✅ Só o vencedor / empate certo: <strong>+1 ponto</strong><br/>
          ⬜ Errou: <strong>0</strong>
        </div>
        <p>Agora é acompanhar o <strong>ranking ao vivo</strong> a cada jogo e ver suas fichas renderem. Que vença o melhor palpiteiro!</p>
        <p style="font-weight:bold; color:#009739; font-size:16px;">Boa sorte! 🍀⚽</p>
        <a href="${APP_URL}/apostas" style="display:inline-block; background:#009739; color:white; padding:12px 20px; text-decoration:none; font-weight:bold; margin-top:6px;">Ver meus palpites e o ranking →</a>
        <p style="color:#8092ab; font-size:12px; margin-top:20px;">Você recebe este email porque sua participação no Bolão da Copa 2026 está confirmada.</p>
      </div>
    </div>
  `;

  return send({
    to: input.user_email,
    subject,
    html,
    attachments: [
      {
        filename: `palpites-${slugify(input.user_name)}.pdf`,
        content: Buffer.from(input.pdfBytes),
      },
    ],
  });
}

/**
 * Email com o PDF CONSOLIDADO (apostas de todos os participantes) em anexo.
 * Vai pra cada aprovado — todo mundo enxerga os palpites de todo mundo, pra
 * garantir a transparência do bolão antes de a bola rolar.
 */
export async function sendConsolidatedBetsEmail(input: {
  user_name: string;
  user_email: string;
  totalPlayers: number;
  pdfBytes: Uint8Array;
}): Promise<boolean> {
  const firstName = escapeHtml(input.user_name.split(" ")[0]);
  const subject = `[Bolão 26] Todas as apostas do bolão em um só PDF 🔍`;
  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto; border: 1px solid #d2dae5;">
      <div style="background:#002776; padding:28px 24px; text-align:center;">
        <div style="font-size:12px; letter-spacing:2px; text-transform:uppercase; color:#FFDF00; font-weight:bold;">Bolão da Copa · 2026</div>
        <div style="color:#ffffff; font-size:26px; font-weight:800; margin-top:8px;">Transparência total 🔍</div>
      </div>
      <div style="padding:24px;">
        <p style="margin-top:0;">Olá, ${firstName}! 👋</p>
        <p>Pra deixar o jogo limpo, <strong>todos os participantes estão recebendo este mesmo email</strong>: o PDF anexo reúne as apostas seladas de <strong>${input.totalPlayers} participante(s)</strong> do bolão — as suas e as de todo mundo.</p>
        <div style="background:#f4f6f9; border-left:4px solid #009739; padding:14px 16px; margin:18px 0; font-size:14px;">
          <strong style="color:#002776;">Por que isso?</strong><br/>
          Os palpites estão selados e ninguém consegue mais editar. Com a cópia na mão de todo mundo, qualquer um pode conferir qualquer aposta durante a Copa. 🔒
        </div>
        <p>Guarde o PDF e acompanhe o <strong>ranking ao vivo</strong> a cada rodada. Que vença o melhor palpiteiro!</p>
        <a href="${APP_URL}/apostas" style="display:inline-block; background:#009739; color:white; padding:12px 20px; text-decoration:none; font-weight:bold; margin-top:6px;">Ver o ranking →</a>
        <div style="background:#f4f6f9; padding:16px; margin-top:18px; text-align:center;">
          <p style="margin:0 0 10px; font-weight:bold; color:#002776;">A resenha da Copa rola no grupo do bolão 🍻⚽</p>
          <a href="${WHATSAPP_GROUP_URL}" style="display:inline-block; background:#25D366; color:white; padding:12px 20px; text-decoration:none; font-weight:bold;">💬 Entrar no grupo do WhatsApp →</a>
        </div>
        <p style="color:#8092ab; font-size:12px; margin-top:20px;">Você recebe este email porque sua participação no Bolão da Copa 2026 está confirmada.</p>
      </div>
    </div>
  `;

  return send({
    to: input.user_email,
    subject,
    html,
    attachments: [
      {
        filename: `bolao26-apostas-consolidadas.pdf`,
        content: Buffer.from(input.pdfBytes),
      },
    ],
  });
}

/**
 * Convite pra instalar o PWA (o "app" do bolão) com passo a passo por
 * plataforma + ativar notificação de gol + chaveamento. Sem anexo.
 */
export async function sendInstallAppEmail(input: {
  user_name: string;
  user_email: string;
}): Promise<boolean> {
  const firstName = escapeHtml(input.user_name.split(" ")[0]);
  const subject = `📲 Instale o app do Bolão — gol por gol no seu celular`;
  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto; border: 1px solid #d2dae5;">
      <div style="background:#002776; padding:28px 24px; text-align:center;">
        <div style="font-size:12px; letter-spacing:2px; text-transform:uppercase; color:#FFDF00; font-weight:bold;">Bolão da Copa · 2026</div>
        <div style="color:#ffffff; font-size:26px; font-weight:800; margin-top:8px;">O bolão virou app 📲</div>
      </div>
      <div style="padding:24px;">
        <p style="margin-top:0;">Olá, ${firstName}! 👋</p>
        <p>Agora dá pra usar o bolão <strong>como um aplicativo</strong> no seu celular: ícone na tela, abre direto, <strong>notificação a cada gol</strong> e o <strong>chaveamento do mata-mata</strong> pra acompanhar a Copa inteira. Você loga com o Google uma vez e pronto.</p>

        <div style="background:#f4f6f9; border-left:4px solid #009739; padding:14px 16px; margin:18px 0; font-size:14px;">
          <strong style="color:#002776;">📱 Android (Chrome)</strong><br/>
          1. Abra <a href="${APP_URL}/apostas" style="color:#009739; font-weight:bold;">o bolão</a> no Chrome<br/>
          2. Toque no menu <strong>⋮</strong> → <strong>"Instalar app"</strong> (ou no aviso que aparece)<br/>
          3. Abra o app e toque em <strong>🔕 Gols</strong> no topo pra ativar as notificações
        </div>

        <div style="background:#f4f6f9; border-left:4px solid #002776; padding:14px 16px; margin:18px 0; font-size:14px;">
          <strong style="color:#002776;">🍎 iPhone (Safari)</strong><br/>
          1. Abra <a href="${APP_URL}/apostas" style="color:#009739; font-weight:bold;">o bolão</a> no Safari<br/>
          2. Toque em <strong>Compartilhar</strong> (quadrado com seta) → <strong>"Adicionar à Tela de Início"</strong><br/>
          3. Abra <strong>pelo ícone novo</strong> e toque em <strong>🔕 Gols</strong> — no iPhone a notificação só funciona pelo app instalado
        </div>

        <p><strong>Novidade:</strong> aba <a href="${APP_URL}/chaveamento" style="color:#009739; font-weight:bold;">Chaveamento</a> — o mata-mata completo, atualizado em tempo real conforme os classificados forem definidos.</p>

        <a href="${APP_URL}/apostas" style="display:inline-block; background:#009739; color:white; padding:12px 20px; text-decoration:none; font-weight:bold; margin-top:6px;">Abrir o bolão →</a>

        <div style="background:#f4f6f9; padding:16px; margin-top:18px; text-align:center;">
          <p style="margin:0 0 10px; font-weight:bold; color:#002776;">A resenha da Copa rola no grupo do bolão 🍻⚽</p>
          <a href="${WHATSAPP_GROUP_URL}" style="display:inline-block; background:#25D366; color:white; padding:12px 20px; text-decoration:none; font-weight:bold;">💬 Entrar no grupo do WhatsApp →</a>
        </div>

        <p style="color:#8092ab; font-size:12px; margin-top:20px;">Você recebe este email porque sua participação no Bolão da Copa 2026 está confirmada.</p>
      </div>
    </div>
  `;

  return send({ to: input.user_email, subject, html });
}

/**
 * Envia um email de teste APENAS para o admin (adminEmail). Não usa PDF nem
 * depende de role/RLS — serve só pra provar que o transporte Gmail SMTP está
 * funcionando no ambiente de produção. Devolve o motivo exato em caso de falha
 * (credencial ausente vs. erro do servidor SMTP) pra facilitar o diagnóstico.
 */
export async function sendTestEmail(): Promise<{
  ok: boolean;
  detail: string;
  to: string;
}> {
  if (!GMAIL_USER || !GMAIL_PASS) {
    return {
      ok: false,
      detail:
        "GMAIL_USER/GMAIL_APP_PASSWORD ausentes no ambiente — confira as variáveis na Vercel e refaça o deploy.",
      to: adminEmail,
    };
  }
  const t = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });
  try {
    await t.sendMail({
      from: fromEmail,
      to: adminEmail,
      subject: "[Bolão 26] Teste de envio (Gmail SMTP)",
      html: `
    <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto;">
      <h2 style="color: #009739; margin-bottom: 4px;">Transporte de email OK ✅</h2>
      <p style="color: #5a6a85; margin-top: 0;">Se você está lendo isto, o envio via Gmail SMTP está funcionando em produção.</p>
      <hr style="border: none; border-top: 1px solid #d2dae5; margin: 16px 0;" />
      <p style="margin: 4px 0;"><strong>Remetente:</strong> ${escapeHtml(fromEmail)}</p>
      <p style="margin: 4px 0;"><strong>Destinatário:</strong> ${escapeHtml(adminEmail)}</p>
      <p style="color: #8092ab; font-size: 12px; margin-top: 16px;">Email de teste disparado pelo painel /admin → Comunicação.</p>
    </div>
  `,
    });
    return { ok: true, detail: `Email de teste enviado para ${adminEmail}.`, to: adminEmail };
  } catch (e) {
    return {
      ok: false,
      detail: `Falha no servidor SMTP: ${(e as Error).message}`,
      to: adminEmail,
    };
  }
}

// ============================================================
// FASE 2 — MATA-MATA
// ============================================================

/**
 * Avisa o admin de um novo PIX da FASE 2 (mata-mata). Sem PDF de palpites
 * (aposta-se a cada rodada, não há cartela fechada) — só os dados + o
 * comprovante anexado pra conferência.
 */
export async function sendKoPixNotification(input: {
  user_name: string;
  user_email: string;
  receipt?: { buffer: Buffer; filename: string; contentType: string };
}): Promise<void> {
  const subject = `[Bolão 26 · Mata-mata] Novo Pix — ${input.user_name}`;
  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto;">
      <h2 style="color: #009739; margin-bottom: 4px;">Novo Pix · Fase 2 (Mata-mata)</h2>
      <p style="color: #5a6a85; margin-top: 0;">Apostador aguardando aprovação da entrada do mata-mata.</p>
      <hr style="border: none; border-top: 1px solid #d2dae5; margin: 16px 0;" />
      <p style="margin: 4px 0;"><strong>Nome:</strong> ${escapeHtml(input.user_name)}</p>
      <p style="margin: 4px 0;"><strong>Email:</strong> ${escapeHtml(input.user_email)}</p>
      <p style="margin: 4px 0;"><strong>Valor:</strong> R$ ${process.env.NEXT_PUBLIC_PIX_AMOUNT ?? "50"},00</p>
      <p style="margin: 16px 0; color: #5a6a85;">Confira o comprovante anexo e aprove em /admin/mata-mata.</p>
      <a href="${APP_URL}/admin/mata-mata" style="display:inline-block;background:#002776;color:white;padding:10px 18px;text-decoration:none;font-weight:bold;">Abrir painel do mata-mata →</a>
    </div>
  `;

  const attachments: Attachment[] = [];
  if (input.receipt) {
    const ext = guessExt(input.receipt.contentType, input.receipt.filename);
    attachments.push({
      filename: `comprovante-mata-mata-${slugify(input.user_name)}${ext}`,
      content: input.receipt.buffer,
    });
  }

  await send({ to: adminEmail, subject, html, attachments });
}

/**
 * Confirma ao apostador que a entrada da FASE 2 foi aprovada. Sem anexo —
 * só o convite a palpitar cada rodada e o campeão.
 */
export async function sendKoApprovalNotification(input: {
  user_name: string;
  user_email: string;
}): Promise<boolean> {
  const firstName = escapeHtml(input.user_name.split(" ")[0]);
  const subject = `[Bolão 26] Você está no Mata-mata 🏆`;
  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto; border: 1px solid #d2dae5;">
      <div style="background:#002776; padding:28px 24px; text-align:center;">
        <div style="font-size:12px; letter-spacing:2px; text-transform:uppercase; color:#FFDF00; font-weight:bold;">Bolão da Copa · 2026</div>
        <div style="color:#ffffff; font-size:26px; font-weight:800; margin-top:8px;">Fase 2 confirmada 🏆</div>
      </div>
      <div style="padding:24px;">
        <p style="margin-top:0;">Olá, ${firstName}! 👋</p>
        <p>Confirmamos seu Pix — você está dentro do <strong>bolão do mata-mata</strong>.</p>
        <div style="background:#f4f6f9; border-left:4px solid #009739; padding:14px 16px; margin:18px 0; font-size:14px;">
          <strong style="color:#002776;">Como funciona:</strong><br/>
          ⚽ Você palpita <strong>a cada rodada</strong> (16avos → final) — cada jogo abre quando os times são definidos e fecha <strong>30 min antes do apito</strong>.<br/>
          🥅 Em cada jogo você crava o placar (normal/prorrogação) <strong>e</strong> os pênaltis.<br/>
          🏆 E aposta também no <strong>campeão</strong> — vale <strong>+5 pontos</strong> (trava antes do 1º jogo dos 16avos).
        </div>
        <div style="background:#f4f6f9; border-left:4px solid #002776; padding:14px 16px; margin:18px 0; font-size:14px;">
          <strong style="color:#002776;">Pontuação:</strong><br/>
          🎯 Placar exato: <strong>+3</strong> · ✅ Resultado certo: <strong>+1</strong><br/>
          🥅 Nos pênaltis (se houver): placar exato <strong>+3</strong> · vencedor <strong>+1</strong>
        </div>
        <a href="${APP_URL}/copa" style="display:inline-block; background:#009739; color:white; padding:12px 20px; text-decoration:none; font-weight:bold; margin-top:6px;">Fazer meus palpites →</a>
        <p style="color:#8092ab; font-size:12px; margin-top:20px;">Não perca o prazo do campeão — ele fecha quando começa o mata-mata.</p>
      </div>
    </div>
  `;

  return send({ to: input.user_email, subject, html });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}
