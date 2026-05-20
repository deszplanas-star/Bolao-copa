import { Resend } from "resend";

const resendKey = process.env.RESEND_API_KEY;
const fromEmail = process.env.RESEND_FROM_EMAIL ?? "Bolão 26 <onboarding@resend.dev>";
const adminEmail =
  process.env.ADMIN_NOTIFICATION_EMAIL ??
  process.env.ADMIN_EMAILS?.split(",")[0]?.trim() ??
  "deszplanas@gmail.com";

function client(): Resend | null {
  if (!resendKey) return null;
  return new Resend(resendKey);
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

export async function sendAdminPixNotification(input: AdminSendInput): Promise<void> {
  const r = client();
  if (!r) {
    console.warn("[email] RESEND_API_KEY ausente — skipping admin notification");
    return;
  }

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
      <a href="https://bolao-copa-pu3k.vercel.app/admin" style="display:inline-block;background:#002776;color:white;padding:10px 18px;text-decoration:none;font-weight:bold;">Abrir painel admin →</a>
    </div>
  `;

  const attachments: Array<{ filename: string; content: Buffer }> = [
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

  try {
    await r.emails.send({
      from: fromEmail,
      to: [adminEmail],
      subject,
      html,
      attachments,
    });
  } catch (e) {
    console.error("[email] sendAdminPixNotification falhou", e);
  }
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

export async function sendUserApprovalNotification(input: SendInput): Promise<void> {
  const r = client();
  if (!r) {
    console.warn("[email] RESEND_API_KEY ausente — skipping user notification");
    return;
  }

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
      <a href="https://bolao-copa-pu3k.vercel.app/apostas" style="display:inline-block;background:#002776;color:white;padding:10px 18px;text-decoration:none;font-weight:bold;margin-top:8px;">Ver minhas apostas →</a>
    </div>
  `;

  try {
    await r.emails.send({
      from: fromEmail,
      to: [input.user_email],
      subject,
      html,
      attachments: [
        {
          filename: `apostas-${slugify(input.user_name)}.pdf`,
          content: Buffer.from(input.pdfBytes),
        },
      ],
    });
  } catch (e) {
    console.error("[email] sendUserApprovalNotification falhou", e);
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
