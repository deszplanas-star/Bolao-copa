import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from "pdf-lib";
import type { PDFPage, PDFRef } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { LOGO_COPA_PNG_B64 } from "./logo-copa";
import { ANTON_TTF_B64 } from "./font-anton";

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

const YELLOW = rgb(1, 0.875, 0); // #FFDF00 — amarelo da bandeira (site)

// Grupo do bolão no WhatsApp — usado no CTA da capa e no corpo dos emails
export const WHATSAPP_GROUP_URL =
  "https://chat.whatsapp.com/LOOWCWnA57Z23HOEcdqAqk?s=cl&p=i&ilr=4";

/**
 * PDF consolidado, na ordem: capa clean no estilo do hero do site (fundo
 * branco, título azul/verde, logo United 2026) → página de regras + divisão
 * da premiação (réplica da seção "As regras" do site) → lista de
 * participantes com âncoras clicáveis (cada nome pula pra aposta da pessoa)
 * → as apostas de TODOS, uma atrás da outra. Cada aposta é gerada pelo
 * `buildBetsPdf` de sempre e as páginas são copiadas pro documento final —
 * o layout individual não muda.
 */
export async function buildConsolidatedPdf(
  inputs: PdfInput[],
  generatedAt: string,
): Promise<Uint8Array> {
  const merged = await PDFDocument.create();
  merged.registerFontkit(fontkit);
  const bold = await merged.embedFont(StandardFonts.HelveticaBold);
  const reg = await merged.embedFont(StandardFonts.Helvetica);
  // Anton = fonte dos títulos do site; subset embute só os glifos usados
  const anton = await merged.embedFont(ANTON_TTF_B64, { subset: true });
  const logo = await merged.embedPng(LOGO_COPA_PNG_B64);

  const A4 = { w: 595.28, h: 841.89 };
  const margin = 40;

  // Pré-gera os PDFs individuais ANTES das páginas de abertura: é preciso
  // saber em qual página a aposta de cada um vai cair pra ancorar os nomes
  // da lista de participantes.
  const userDocs: PDFDocument[] = [];
  for (const input of inputs) {
    userDocs.push(await PDFDocument.load(await buildBetsPdf(input)));
  }

  // ---------- CAPA (clean, como o hero do site) ----------
  const cover = merged.addPage([A4.w, A4.h]);

  // barra verde acima do título, como no site
  cover.drawRectangle({ x: margin, y: A4.h - 64, width: 215, height: 10, color: GREEN });

  let y = A4.h - 142;
  cover.drawText("O BOLÃO", { x: margin, y, size: 68, font: anton, color: INK });
  y -= 70;
  cover.drawText("DA", { x: margin, y, size: 68, font: anton, color: INK });
  cover.drawText("COPA", {
    x: margin + anton.widthOfTextAtSize("DA ", 68),
    y,
    size: 68,
    font: anton,
    color: GREEN,
  });
  y -= 70;
  cover.drawText("2026", { x: margin, y, size: 68, font: anton, color: GREEN });

  // logo United 2026 à direita, na altura do título
  const logoW = 235;
  const logoH = (logo.height / logo.width) * logoW;
  cover.drawImage(logo, {
    x: A4.w - margin - logoW,
    y: A4.h - 175 - logoH / 2,
    width: logoW,
    height: logoH,
  });

  y -= 64;
  cover.drawText("APOSTAS CONSOLIDADAS", { x: margin, y, size: 18, font: anton, color: INK });
  y -= 16;
  cover.drawText("Todos os palpites de todos os participantes, para conferência geral.", {
    x: margin,
    y,
    size: 10,
    font: reg,
    color: SOFT,
  });
  y -= 32;
  cover.drawText("72 JOGOS  ·  FASE DE GRUPOS", { x: margin, y, size: 11, font: bold, color: SOFT });
  y -= 18;
  cover.drawText("ESTREIA: 11 DE JUNHO", { x: margin, y, size: 11, font: bold, color: SOFT });
  y -= 18;
  cover.drawText(
    `${inputs.length} ${inputs.length === 1 ? "PARTICIPANTE" : "PARTICIPANTES"}  ·  APOSTAS SELADAS`,
    { x: margin, y, size: 11, font: bold, color: GREEN },
  );

  // CTA: grupo do WhatsApp do bolão (botão clicável)
  y -= 70;
  const ctaText = "ENTRAR NO GRUPO DO WHATSAPP";
  const ctaSize = 15;
  const ctaW = anton.widthOfTextAtSize(ctaText, ctaSize) + 56;
  const ctaH = 46;
  const ctaY = y - ctaH;
  cover.drawRectangle({ x: margin, y: ctaY, width: ctaW, height: ctaH, color: GREEN });
  cover.drawText(ctaText, {
    x: margin + 28,
    y: ctaY + 16,
    size: ctaSize,
    font: anton,
    color: rgb(1, 1, 1),
  });
  cover.drawText("A resenha da Copa rola lá — clique no botão e entre no grupo.", {
    x: margin,
    y: ctaY - 16,
    size: 9,
    font: reg,
    color: SOFT,
  });
  const waAnnot = merged.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [margin, ctaY, margin + ctaW, ctaY + ctaH],
    Border: [0, 0, 0],
    A: { Type: "Action", S: "URI", URI: PDFString.of(WHATSAPP_GROUP_URL) },
  });
  cover.node.set(PDFName.of("Annots"), merged.context.obj([merged.context.register(waAnnot)]));

  // fineprint do rodapé, como no hero
  cover.drawText(
    `GERADO EM ${fmt(generatedAt)}  ·  SEM EDIÇÃO APÓS O SELO  ·  TRANSPARÊNCIA TOTAL`,
    { x: margin, y: 56, size: 8, font: bold, color: SOFT },
  );

  // ---------- REGRAS + PREMIAÇÃO ----------
  const rules = merged.addPage([A4.w, A4.h]);
  y = A4.h - 70;
  rules.drawSvgPath("M 0 0 L 11 7 L 0 14 Z", { x: margin, y: y + 15, color: GREEN });
  rules.drawText("AS REGRAS", { x: margin + 22, y, size: 22, font: bold, color: INK });
  y -= 16;
  rules.drawText("Pontuação · Premiação · Modelo simples e transparente", {
    x: margin + 22,
    y,
    size: 10,
    font: reg,
    color: SOFT,
  });
  y -= 16;
  rules.drawLine({
    start: { x: margin, y },
    end: { x: A4.w - margin, y },
    thickness: 1.2,
    color: INK,
  });

  // pontuação — 3 caixas lado a lado, como no site
  y -= 30;
  rules.drawText("PONTUAÇÃO", { x: margin, y, size: 12, font: bold, color: GREEN });
  y -= 14;
  const boxes = [
    { top: "ACERTO CRAVADO", num: "+3", label: "Placar exato", eg: "apostou 2×1 · saiu 2×1", hot: true },
    { top: "ACERTO PARCIAL", num: "+1", label: "Vencedor / empate", eg: "apostou 1×0 · saiu 2×1", hot: false },
    { top: "ERROU", num: "0", label: "Resultado errado", eg: "apostou 1×1 · saiu 2×1", hot: false },
  ];
  const gap = 12;
  const boxW = (A4.w - 2 * margin - 2 * gap) / 3;
  const boxH = 92;
  const boxTop = y;
  boxes.forEach((b, i) => {
    const bx = margin + i * (boxW + gap);
    const by = boxTop - boxH;
    rules.drawRectangle({
      x: bx,
      y: by,
      width: boxW,
      height: boxH,
      borderWidth: 1.5,
      borderColor: b.hot ? GREEN : RULE,
      color: rgb(1, 1, 1),
    });
    rules.drawText(b.top, { x: bx + 12, y: by + boxH - 22, size: 8, font: bold, color: SOFT });
    rules.drawText(b.num, {
      x: bx + 12,
      y: by + boxH - 52,
      size: 26,
      font: bold,
      color: b.hot ? GREEN : INK,
    });
    rules.drawText(b.label, { x: bx + 12, y: by + 24, size: 10, font: bold, color: INK });
    rules.drawText(b.eg, { x: bx + 12, y: by + 10, size: 8, font: reg, color: SOFT });
  });
  y = boxTop - boxH - 34;

  // premiação — escada 70/20/10 + reembolso, como no site
  rules.drawText("PREMIAÇÃO", { x: margin, y, size: 12, font: bold, color: GREEN });
  y -= 15;
  rules.drawText("O bolo se divide em quatro.", { x: margin, y, size: 11, font: reg, color: SOFT });
  y -= 14;
  const rungs = [
    { pos: "1º", name: "CAMPEÃO", pct: "70%", side: "Maior pontuação", gold: true },
    { pos: "2º", name: "VICE", pct: "20%", side: "Segunda maior", gold: false },
    { pos: "3º", name: "PÓDIO", pct: "10%", side: "Terceira maior", gold: false },
    { pos: "—", name: "LANTERNA", pct: "REEMBOLSO", side: "Última colocação", gold: false },
  ];
  const rungH = 32;
  for (const r of rungs) {
    const ry = y - rungH;
    rules.drawRectangle({
      x: margin,
      y: ry,
      width: A4.w - 2 * margin,
      height: rungH,
      color: r.gold ? YELLOW : rgb(1, 1, 1),
      borderWidth: 1.2,
      borderColor: r.gold ? YELLOW : RULE,
    });
    const ty = ry + 11;
    rules.drawText(r.pos, { x: margin + 14, y: ty, size: 12, font: bold, color: INK });
    rules.drawText(r.name, { x: margin + 52, y: ty, size: 12, font: bold, color: INK });
    const pctW = bold.widthOfTextAtSize(r.pct, 14);
    rules.drawText(r.pct, {
      x: A4.w - margin - 150 - pctW,
      y: ty,
      size: 14,
      font: bold,
      color: r.gold ? INK : GREEN,
    });
    const sideW = reg.widthOfTextAtSize(r.side, 8);
    rules.drawText(r.side, {
      x: A4.w - margin - 12 - sideW,
      y: ty + 2,
      size: 8,
      font: reg,
      color: SOFT,
    });
    y = ry - 6;
  }
  y -= 8;
  rules.drawText(
    "O último colocado recupera o valor da aposta. O resto se distribui entre os três",
    { x: margin, y, size: 9, font: reg, color: SOFT },
  );
  y -= 12;
  rules.drawText(
    "primeiros, calculado automaticamente sobre o pool aprovado. Aposta única: R$ 50.",
    { x: margin, y, size: 9, font: reg, color: SOFT },
  );

  // participantes — duas colunas; cada nome é um link (azul + sublinhado)
  // que pula direto pra página da aposta daquele participante
  y -= 30;
  rules.drawText(`PARTICIPANTES (${inputs.length})`, {
    x: margin,
    y,
    size: 12,
    font: bold,
    color: GREEN,
  });
  y -= 14;
  rules.drawText("Clique em um nome para ir direto à aposta.", {
    x: margin,
    y,
    size: 9,
    font: reg,
    color: SOFT,
  });
  y -= 20;
  const linkSpots: { page: PDFPage; x: number; y: number; w: number; userIdx: number }[] = [];
  let listPage: PDFPage = rules;
  const colW = (A4.w - 2 * margin) / 2;
  let col = 0;
  let rowY = y;
  for (let i = 0; i < inputs.length; i++) {
    if (rowY < 50) {
      if (col === 0) {
        col = 1;
        rowY = y;
      } else {
        listPage = merged.addPage([A4.w, A4.h]);
        col = 0;
        y = A4.h - margin;
        rowY = y;
      }
    }
    const lx = margin + col * colW;
    const label = `${i + 1}. ${inputs[i].user_name}`;
    const lw = reg.widthOfTextAtSize(label, 9);
    listPage.drawText(label, { x: lx, y: rowY, size: 9, font: reg, color: INK });
    listPage.drawLine({
      start: { x: lx, y: rowY - 2.5 },
      end: { x: lx + lw, y: rowY - 2.5 },
      thickness: 0.7,
      color: INK,
    });
    linkSpots.push({ page: listPage, x: lx, y: rowY, w: lw, userIdx: i });
    rowY -= 15;
  }

  // ---------- APOSTAS (cada participante começa em página nova) ----------
  const startPage: number[] = [];
  let cursor = merged.getPageCount();
  for (const src of userDocs) {
    startPage.push(cursor);
    const pages = await merged.copyPages(src, src.getPageIndices());
    for (const p of pages) merged.addPage(p);
    cursor += src.getPageCount();
  }

  // âncoras: anotação de link sobre cada nome, apontando pra página da aposta
  const all = merged.getPages();
  const annotsByPage = new Map<PDFPage, PDFRef[]>();
  for (const s of linkSpots) {
    const target = all[startPage[s.userIdx]];
    const annot = merged.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [s.x, s.y - 4, s.x + s.w, s.y + 9],
      Border: [0, 0, 0],
      Dest: merged.context.obj([target.ref, "Fit"]),
    });
    const ref = merged.context.register(annot);
    const arr = annotsByPage.get(s.page) ?? [];
    arr.push(ref);
    annotsByPage.set(s.page, arr);
  }
  annotsByPage.forEach((refs, pg) => {
    pg.node.set(PDFName.of("Annots"), merged.context.obj(refs));
  });

  return await merged.save();
}
