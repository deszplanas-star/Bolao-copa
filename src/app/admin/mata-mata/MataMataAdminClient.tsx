"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { KoPaymentRow } from "./page";
import { approveKoPayment, denyKoPayment, recomputeKo, setChampionDeadline } from "./actions";

type FinalMatch = {
  home_name: string | null;
  away_name: string | null;
  home_score: number | null;
  away_score: number | null;
  pen_home: number | null;
  pen_away: number | null;
  status: string;
} | null;

function fmt(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

// Para o input datetime-local: converte ISO → "YYYY-MM-DDTHH:mm" em BRT.
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(new Date(iso).getTime() - 3 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 16);
}

export default function MataMataAdminClient({
  adminName,
  payments,
  championLockAt,
  championCount,
  finalMatch,
}: {
  adminName: string;
  payments: KoPaymentRow[];
  championLockAt: string | null;
  championCount: number;
  finalMatch: FinalMatch;
}) {
  const router = useRouter();
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // datetime-local guarda o horário em BRT; mandamos com o offset -03:00.
  const [deadline, setDeadline] = useState<string>(() => toLocalInput(championLockAt));

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }

  async function run(key: string, fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) {
    setBusy(key);
    try {
      const res = await fn();
      flash(res.ok ? okMsg : res.error ?? "Falhou");
      if (res.ok) router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const pending = payments.filter((p) => p.status === "pending");
  const approved = payments.filter((p) => p.status === "approved");

  return (
    <div className="min-h-screen bg-paper">
      <header className="bg-ink text-paper border-b-4 border-yellow">
        <div className="max-w-[1080px] mx-auto px-8 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2 font-anton uppercase tracking-wider text-base">
            <span className="w-2 h-2 bg-yellow rounded-full animate-pulse" />
            Admin · Mata-mata
          </div>
          <div className="flex items-center gap-4">
            <Link href="/admin" className="font-mono text-[10px] uppercase tracking-widest text-paper/70 hover:text-yellow">
              ← Fase de grupos
            </Link>
            <span className="font-mono text-[11px] uppercase tracking-widest text-yellow">{adminName}</span>
          </div>
        </div>
      </header>

      <main className="max-w-[1080px] mx-auto px-8 py-8 space-y-10">
        {/* PRAZO DO CAMPEÃO */}
        <section className="border-2 border-ink">
          <div className="px-5 py-3 border-b-2 border-ink bg-ink text-paper font-anton uppercase tracking-wider text-sm">
            🏆 Prazo do palpite de campeão
          </div>
          <div className="p-5">
            <p className="font-serif italic text-sm text-soft mb-3">
              O palpite de campeão trava neste horário (recomendado: apito do 1º jogo dos 16avos).
              Atual: <b className="text-ink not-italic">{fmt(championLockAt)}</b> · {championCount} palpite(s) salvos.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="font-mono text-[10px] uppercase tracking-widest text-mute">
                Trava (horário de Brasília)
                <input
                  type="datetime-local"
                  value={deadline}
                  onChange={(e) => setDeadline(e.target.value)}
                  className="block mt-1 border-2 border-rule px-3 py-2 font-mono text-sm text-ink bg-paper focus:border-ink outline-none"
                />
              </label>
              <button
                disabled={busy === "deadline"}
                onClick={() =>
                  run(
                    "deadline",
                    () => setChampionDeadline({ champion_lock_at: deadline ? `${deadline}:00-03:00` : "" }),
                    "Prazo atualizado",
                  )
                }
                className="px-4 py-2 bg-yellow text-ink font-anton text-[13px] uppercase tracking-wider border-2 border-yellow disabled:opacity-50"
              >
                {busy === "deadline" ? "Salvando..." : "Salvar prazo"}
              </button>
              <button
                disabled={busy === "deadline-clear"}
                onClick={() => {
                  setDeadline("");
                  run("deadline-clear", () => setChampionDeadline({ champion_lock_at: "" }), "Prazo limpo (aberto)");
                }}
                className="px-4 py-2 bg-paper text-soft font-mono text-[11px] uppercase tracking-widest border-2 border-rule hover:border-ink hover:text-ink disabled:opacity-50"
              >
                Deixar aberto
              </button>
            </div>
          </div>
        </section>

        {/* APURAÇÃO */}
        <section className="border-2 border-ink">
          <div className="px-5 py-3 border-b-2 border-ink bg-ink text-paper font-anton uppercase tracking-wider text-sm">
            🧮 Apuração
          </div>
          <div className="p-5">
            <p className="font-serif italic text-sm text-soft mb-3">
              A pontuação roda automática quando o ingest fecha cada placar. Use o botão abaixo só
              pra reapurar tudo à mão (ex.: após corrigir um placar).
              {finalMatch && (
                <>
                  {" "}Final:{" "}
                  <b className="text-ink not-italic">
                    {finalMatch.home_name ?? "?"} {finalMatch.home_score ?? "–"} × {finalMatch.away_score ?? "–"} {finalMatch.away_name ?? "?"}
                    {finalMatch.pen_home != null && ` (pen ${finalMatch.pen_home}×${finalMatch.pen_away})`}
                    {finalMatch.status === "finished" ? " · ENCERRADA" : ""}
                  </b>
                </>
              )}
            </p>
            <button
              disabled={busy === "recompute"}
              onClick={() => run("recompute", recomputeKo, "Reapuração concluída")}
              className="px-4 py-2 bg-green text-paper font-anton text-[13px] uppercase tracking-wider border-2 border-green disabled:opacity-50"
            >
              {busy === "recompute" ? "Apurando..." : "Reapurar tudo (jogos + campeão)"}
            </button>
          </div>
        </section>

        {/* PAGAMENTOS */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-anton text-2xl uppercase tracking-tight text-ink">Entradas (Pix)</h2>
            <span className="font-mono text-[10px] uppercase tracking-widest text-mute">
              {pending.length} pendente(s) · {approved.length} aprovada(s)
            </span>
          </div>

          {payments.length === 0 ? (
            <div className="border-2 border-dashed border-rule p-8 text-center font-serif italic text-soft">
              Nenhum Pix da fase 2 recebido ainda.
            </div>
          ) : (
            <div className="border-2 border-ink">
              <table className="w-full border-collapse">
                <thead className="bg-ink text-paper">
                  <tr>
                    <th className="text-left font-mono text-[10px] uppercase tracking-widest py-2.5 px-3">Apostador</th>
                    <th className="text-left font-mono text-[10px] uppercase tracking-widest py-2.5 px-3">Enviado</th>
                    <th className="text-left font-mono text-[10px] uppercase tracking-widest py-2.5 px-3">Status</th>
                    <th className="text-right font-mono text-[10px] uppercase tracking-widest py-2.5 px-3">Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id} className="border-b border-rule last:border-b-0">
                      <td className="py-3 px-3">
                        <div className="font-anton uppercase tracking-tight text-sm text-ink">{p.user?.name ?? "Sem nome"}</div>
                        <div className="font-mono text-[11px] text-mute">{p.user?.email ?? p.user_id}</div>
                      </td>
                      <td className="py-3 px-3 font-mono text-[11px] text-soft">{fmt(p.user_confirmed_at)}</td>
                      <td className="py-3 px-3">
                        <span
                          className={[
                            "font-anton text-[11px] px-2 py-0.5 uppercase tracking-wider",
                            p.status === "approved" ? "bg-green text-paper" : p.status === "pending" ? "bg-yellow text-ink" : "bg-paper2 text-mute",
                          ].join(" ")}
                        >
                          {p.status === "approved" ? "aprovado" : p.status === "pending" ? "pendente" : "negado"}
                        </span>
                        {p.denied_reason && <div className="font-serif italic text-[11px] text-soft mt-1">{p.denied_reason}</div>}
                      </td>
                      <td className="py-3 px-3 text-right whitespace-nowrap">
                        {p.status !== "approved" && (
                          <button
                            disabled={busy === `ap-${p.id}`}
                            onClick={() => run(`ap-${p.id}`, () => approveKoPayment({ payment_id: p.id }), "Aprovado")}
                            className="px-3 py-1.5 bg-green text-paper font-anton text-[11px] uppercase tracking-wider border border-green disabled:opacity-50 mr-1.5"
                          >
                            ✓ Aprovar
                          </button>
                        )}
                        {p.status !== "denied" && (
                          <button
                            disabled={busy === `dn-${p.id}`}
                            onClick={() => {
                              const reason = window.prompt("Motivo da recusa (opcional):") ?? undefined;
                              run(`dn-${p.id}`, () => denyKoPayment({ payment_id: p.id, reason }), "Negado");
                            }}
                            className="px-3 py-1.5 bg-paper text-red-700 font-anton text-[11px] uppercase tracking-wider border border-red-300 hover:border-red-600 disabled:opacity-50"
                          >
                            ✕ Negar
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      {toast && (
        <div
          className="fixed left-1/2 -translate-x-1/2 bottom-10 bg-ink text-paper border-l-4 border-yellow px-5 py-3 font-anton text-[13px] uppercase tracking-wider z-40"
          style={{ boxShadow: "4px 4px 0 #FFDF00" }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
