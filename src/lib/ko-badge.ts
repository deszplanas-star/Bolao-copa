// Badge de pontos do MATA-MATA.
// Pedido do Davidson (03/07): mostrar a DECOMPOSIÇÃO das camadas ("0+1 = 1 pt")
// e cor DISCRETA — fundo suave + texto colorido; zero fica neutro. A única
// exceção barulhenta é o 9 (cravou as 3 camadas), que ganha o dourado sólido.
// Totais possíveis: 16avos (2 camadas) 0/1/2/3/4/6 · oitavas+ (3 camadas)
// 0 a 7 e 9 (8 é impossível: nenhuma combinação de 0/1/3 soma 8).
export function koPtsBadge(pts: number): string {
  if (pts >= 9) return "bg-gradient-to-r from-yellow to-[#FFA500] text-ink border border-ink"; // 9 · cravada tripla
  if (pts >= 7) return "bg-ink/10 text-ink border border-ink"; // 7 · quase perfeito
  if (pts >= 6) return "bg-[#0B5AC2]/10 text-[#0B5AC2] border border-[#0B5AC2]"; // 6 · teto dos 16avos
  if (pts >= 5) return "bg-[#0E7490]/10 text-[#0E7490] border border-[#0E7490]"; // 5
  if (pts >= 4) return "bg-[#006B2D]/10 text-[#006B2D] border border-[#006B2D]"; // 4
  if (pts >= 3) return "bg-green/10 text-green border border-green"; // 3 · 1 cravada
  if (pts >= 2) return "bg-yellow/40 text-ink border border-yellow"; // 2
  if (pts >= 1) return "bg-yellow/15 text-ink border border-yellow/60"; // 1
  return "bg-paper2 text-mute"; // 0 · sem cor
}

// "normal+pênaltis = N pts" nos 16avos · "normal+prorrogação+pênaltis = N pts"
// nas oitavas em diante. Ex.: "0+1 = 1 pt", "3+0+1 = 4 pts".
export function koPtsLabel(
  p: { normal_points: number; prorrog_points: number; pen_points: number; points: number },
  newModel: boolean,
): string {
  const parts = newModel
    ? [p.normal_points, p.prorrog_points, p.pen_points]
    : [p.normal_points, p.pen_points];
  return `${parts.join("+")} = ${p.points} pt${p.points === 1 ? "" : "s"}`;
}
