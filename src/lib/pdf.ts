import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export type PdfMatch = {
  group_code: string;
  home_name: string;
  away_name: string;
  home_score: number;
  away_score: number;
  kickoff_at: string;
};

export type PdfInput = {
  user_name: string;
  user_email: string;
  submitted_at: string;
  matches: PdfMatch[];
};

const GREEN = rgb(0, 0.59, 0.22);
const INK = rgb(0, 0.15, 0.46);
const SOFT = rgb(0.35, 0.42, 0.52);
const RULE = rgb(0.82, 0.85, 0.9);

function fmt(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export async function buildBetsPdf(input: PdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg = await doc.embedFont(StandardFonts.Helvetica);

  const A4 = { w: 595.28, h: 841.89 };
  const margin = 40;
  let page = doc.addPage([A4.w, A4.h]);
  let y = A4.h - margin;

  const drawText = (
    txt: string,
    x: number,
    yy: number,
    size: number,
    font = reg,
    color = INK,
  ) => page.drawText(txt, { x, y: yy, size, font, color });

  // header
  drawText("BOLÃO 26", margin, y, 22, bold, GREEN);
  drawText("FIFA WORLD CUP 2026", margin + 110, y + 4, 9, bold, SOFT);
  y -= 30;
  drawText(input.user_name, margin, y, 14, bold, INK);
  y -= 16;
  drawText(input.user_email, margin, y, 10, reg, SOFT);
  y -= 14;
  drawText(`Submetido em ${fmt(input.submitted_at)}`, margin, y, 9, reg, SOFT);
  y -= 20;
  page.drawLine({
    start: { x: margin, y },
    end: { x: A4.w - margin, y },
    thickness: 1.2,
    color: INK,
  });
  y -= 18;

  // agrupar por grupo
  const byGroup = new Map<string, PdfMatch[]>();
  for (const m of input.matches) {
    const list = byGroup.get(m.group_code) ?? [];
    list.push(m);
    byGroup.set(m.group_code, list);
  }
  const groupCodes = Array.from(byGroup.keys()).sort();

  for (const code of groupCodes) {
    if (y < 80) {
      page = doc.addPage([A4.w, A4.h]);
      y = A4.h - margin;
    }
    drawText(`GRUPO ${code}`, margin, y, 12, bold, GREEN);
    y -= 14;
    page.drawLine({
      start: { x: margin, y: y + 2 },
      end: { x: A4.w - margin, y: y + 2 },
      thickness: 0.5,
      color: RULE,
    });
    y -= 6;

    const list = byGroup.get(code) ?? [];
    list.sort((a, b) => a.kickoff_at.localeCompare(b.kickoff_at));
    for (const m of list) {
      if (y < 50) {
        page = doc.addPage([A4.w, A4.h]);
        y = A4.h - margin;
      }
      const date = fmt(m.kickoff_at);
      drawText(date, margin, y, 8, reg, SOFT);
      const center = A4.w / 2;
      const homeText = m.home_name;
      const awayText = m.away_name;
      const score = `${m.home_score} × ${m.away_score}`;
      const homeWidth = bold.widthOfTextAtSize(homeText, 10);
      drawText(homeText, center - 90 - homeWidth, y, 10, bold, INK);
      drawText(score, center - 18, y, 11, bold, GREEN);
      drawText(awayText, center + 30, y, 10, bold, INK);
      y -= 14;
    }
    y -= 8;
  }

  // footer
  page.drawText(
    `Bolão 26 · ${input.matches.length} palpites · Cópia para conferência`,
    {
      x: margin,
      y: 20,
      size: 8,
      font: reg,
      color: SOFT,
    },
  );

  return await doc.save();
}
