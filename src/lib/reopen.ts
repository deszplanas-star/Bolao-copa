// ============================================================
// Janela de reedição de jogos reabertos
// ------------------------------------------------------------
// Jogos marcados como `reopened` só podem ser reeditados ENQUANTO esta
// janela estiver aberta. Depois do corte, eles voltam a ficar travados
// automaticamente — é arriscado deixar palpites editáveis com a Copa
// em andamento. Não depende de cron nem de ação manual.
//
// Para mudar o prazo, ajuste APENAS a constante abaixo.
// Fuso -03:00 = horário de Brasília (BRT).
// ============================================================

// Fecha no fim do dia 10/06 (ou seja, quando começa o dia 11/06, BRT),
// logo antes do primeiro jogo da Copa.
export const REOPEN_CUTOFF_ISO = "2026-06-11T00:00:00-03:00";

export function isReopenWindowOpen(nowMs: number = Date.now()): boolean {
  return nowMs < new Date(REOPEN_CUTOFF_ISO).getTime();
}
