import nodemailer from "nodemailer";

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
