"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Group, MatchView, RankingRow, Team } from "@/lib/types";
import { computeStandings } from "@/lib/standings";
import { isReopenWindowOpen } from "@/lib/reopen";
import { deletePrediction, upsertPrediction } from "./actions";
import { submitPayment } from "./payment-actions";
import PushBell from "@/components/PushBell";

type Draft = { home: string; away: string; saving?: boolean; error?: string | null };
type DraftMap = Record<string, Draft>;

type Props = {
  user: { email: string; name: string };
  groups: Group[];
  teams: Team[];
  matches: MatchView[];
  paymentStatus: "pending" | "approved" | "denied" | null;
  rankings: RankingRow[];
  currentUserId: string;
  editsUnlocked: boolean;
};

const TABS = [
  { key: "apostas", label: "Apostas" },
  { key: "ranking", label: "Ranking" },
  { key: "resultados", label: "Resultados" },
  { key: "minhas", label: "Minhas apostas" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const flagUrl = (iso: string, w = 80) => `https://flagcdn.com/w${w}/${iso}.png`;

function parseScore(v: string): number | null {
  if (v === "") return null;
  const n = parseInt(v, 10);
  if (Number.isNaN(n) || n < 0 || n > 99) return null;
  return n;
}

function fmtKickoff(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtCountdown(iso: string) {
  const ms = new Date(iso).getTime() - Date.now() - 5 * 60 * 1000;
  if (ms <= 0) return null;
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `cutoff em ${days}d ${hours}h`;
  if (hours > 0) return `cutoff em ${hours}h ${mins}min`;
  return `cutoff em ${mins}min`;
}

export default function ApostasClient({
  user,
  groups,
  teams,
  matches,
  paymentStatus,
  rankings,
  currentUserId,
  editsUnlocked,
}: Props) {
  const sealed = paymentStatus === "pending" || paymentStatus === "approved";
  // Aba inicial pode vir da URL (?tab=resultados) — é pra onde a notificação
  // de gol aponta, direto no jogo ao vivo.
  const [tab, setTab] = useState<TabKey>(() => {
    if (typeof window !== "undefined") {
      const t = new URLSearchParams(window.location.search).get("tab");
      if (TABS.some((x) => x.key === t)) return t as TabKey;
    }
    return "apostas";
  });
  const initialGroup = groups[0]?.code ?? "A";
  const [currentGroup, setCurrentGroup] = useState<string>(initialGroup);
  const [drafts, setDrafts] = useState<DraftMap>(() => {
    const init: DraftMap = {};
    for (const m of matches) {
      if (m.prediction) {
        init[m.id] = {
          home: String(m.prediction.home_score),
          away: String(m.prediction.away_score),
        };
      }
    }
    return init;
  });
  const [toast, setToast] = useState<string | null>(null);
  const router = useRouter();

  // Placar/ranking ao vivo: nas abas Resultados e Ranking, recarrega os
  // dados do servidor a cada 30s, sem refresh manual.
  useEffect(() => {
    if (tab !== "resultados" && tab !== "ranking") return;
    const id = setInterval(() => router.refresh(), 30_000);
    return () => clearInterval(id);
  }, [tab, router]);
  const [showPixModal, setShowPixModal] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [submittingPayment, setSubmittingPayment] = useState(false);
  const [reopenSaving, setReopenSaving] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(() => Date.now());

  const reopenedCount = useMemo(
    () => matches.reduce((s, m) => (m.reopened ? s + 1 : s), 0),
    [matches],
  );
  // Janela de reedição (fecha automaticamente antes da Copa). Reavalia a
  // cada tick de `now`, então a tela se trava sozinha quando o prazo passa.
  const reopenWindowOpen = isReopenWindowOpen(now);

  // Tick a cada minuto pra atualizar countdowns
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // ===== Index helpers =====
  const teamsByGroup = useMemo(() => {
    const m = new Map<string, Team[]>();
    for (const g of groups) m.set(g.id, []);
    for (const t of teams) {
      const arr = m.get(t.group_id);
      if (arr) arr.push(t);
    }
    return m;
  }, [groups, teams]);

  const matchesByGroup = useMemo(() => {
    const m = new Map<string, MatchView[]>();
    for (const g of groups) m.set(g.id, []);
    for (const mv of matches) {
      const arr = m.get(mv.group_id);
      if (arr) arr.push(mv);
    }
    return m;
  }, [groups, matches]);

  const groupByCode = useMemo(
    () => new Map(groups.map((g) => [g.code, g])),
    [groups],
  );

  const currentGroupObj = groupByCode.get(currentGroup) ?? groups[0];
  const currentMatches = currentGroupObj
    ? matchesByGroup.get(currentGroupObj.id) ?? []
    : [];
  const currentTeams = currentGroupObj
    ? teamsByGroup.get(currentGroupObj.id) ?? []
    : [];

  // ===== Counts =====
  function isMatchFilled(matchId: string) {
    const d = drafts[matchId];
    if (!d) return false;
    // Palpite cujo salvamento FALHOU não conta: contar o texto digitado
    // mascarava o problema (tela mostrava 72/72 com 71 salvos no banco) e
    // deixava o apostador tentar ativar a aposta com palpite faltando.
    if (d.error) return false;
    return parseScore(d.home) !== null && parseScore(d.away) !== null;
  }

  const totalFilled = matches.reduce((s, m) => (isMatchFilled(m.id) ? s + 1 : s), 0);

  // Total EXIGIDO pra ativar: jogos ainda abertos + os que a pessoa já
  // preencheu. Quem entra depois de um jogo travado (ex.: entrou durante a
  // abertura) participa com um palpite a menos — o jogo perdido vale 0.
  const CUTOFF_CLIENT_MS = 5 * 60 * 1000;
  const requiredTotal = matches.reduce((s, m) => {
    const open = new Date(m.kickoff_at).getTime() - now > CUTOFF_CLIENT_MS;
    return open || isMatchFilled(m.id) ? s + 1 : s;
  }, 0);
  const groupFilledCount = (groupId: string) =>
    (matchesByGroup.get(groupId) ?? []).reduce(
      (s, m) => (isMatchFilled(m.id) ? s + 1 : s),
      0,
    );

  // ===== Drafts → standings =====
  const draftPredictions = useMemo(() => {
    const out: Record<string, { home_score: number; away_score: number } | null> = {};
    for (const id of Object.keys(drafts)) {
      const d = drafts[id];
      const h = parseScore(d.home);
      const a = parseScore(d.away);
      out[id] = h !== null && a !== null ? { home_score: h, away_score: a } : null;
    }
    return out;
  }, [drafts]);

  const standings = useMemo(
    () => computeStandings(currentTeams, currentMatches, draftPredictions),
    [currentTeams, currentMatches, draftPredictions],
  );

  // ===== Persistência (debounce por jogo) =====
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const persist = useCallback(
    (matchId: string, home: string, away: string) => {
      if (timers.current[matchId]) clearTimeout(timers.current[matchId]);
      timers.current[matchId] = setTimeout(async () => {
        const h = parseScore(home);
        const a = parseScore(away);

        setDrafts((prev) => ({
          ...prev,
          [matchId]: { ...prev[matchId], saving: true, error: null },
        }));

        try {
          if (h === null || a === null) {
            // Limpar palpite parcial: se havia palpite, deleta; senão, ignora.
            const original = matches.find((m) => m.id === matchId)?.prediction;
            if (original) {
              const res = await deletePrediction({ match_id: matchId });
              if (!res.ok) throw new Error(res.error);
            }
          } else {
            const res = await upsertPrediction({
              match_id: matchId,
              home_score: h,
              away_score: a,
            });
            if (!res.ok) throw new Error(res.error);
            setToast("Salvo");
          }
          setDrafts((prev) => ({
            ...prev,
            [matchId]: { ...prev[matchId], saving: false, error: null },
          }));
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Erro ao salvar";
          setDrafts((prev) => ({
            ...prev,
            [matchId]: { ...prev[matchId], saving: false, error: msg },
          }));
          setToast(msg);
        }
      }, 500);
    },
    [matches],
  );

  useEffect(() => {
    const t = timers.current;
    return () => {
      Object.values(t).forEach((id) => clearTimeout(id));
    };
  }, []);

  function updateScore(matchId: string, side: "home" | "away", raw: string) {
    const cleaned = raw.replace(/\D/g, "").slice(0, 2);
    setDrafts((prev) => {
      const next = { ...prev };
      const cur = next[matchId] ?? { home: "", away: "" };
      next[matchId] = { ...cur, [side]: cleaned };
      return next;
    });
    const cur = drafts[matchId] ?? { home: "", away: "" };
    const nextHome = side === "home" ? cleaned : cur.home;
    const nextAway = side === "away" ? cleaned : cur.away;
    persist(matchId, nextHome, nextAway);
  }

  // ===== Reedição de jogo reaberto (aposta já selada) =====
  // Diferente do fluxo normal: NÃO salva a cada tecla. A pessoa digita e
  // confirma no botão "Enviar atualizado". Sem modal de Pix, sem comprovante.
  function updateScoreLocal(matchId: string, side: "home" | "away", raw: string) {
    const cleaned = raw.replace(/\D/g, "").slice(0, 2);
    setDrafts((prev) => {
      const next = { ...prev };
      const cur = next[matchId] ?? { home: "", away: "" };
      next[matchId] = { ...cur, [side]: cleaned };
      return next;
    });
  }

  const submitReopened = useCallback(
    async (matchId: string) => {
      const d = drafts[matchId];
      const h = parseScore(d?.home ?? "");
      const a = parseScore(d?.away ?? "");
      if (h === null || a === null) {
        setToast("Preencha os dois placares.");
        return;
      }
      setReopenSaving((p) => ({ ...p, [matchId]: true }));
      const res = await upsertPrediction({
        match_id: matchId,
        home_score: h,
        away_score: a,
      });
      setReopenSaving((p) => ({ ...p, [matchId]: false }));
      setToast(res.ok ? "Palpite atualizado" : res.error);
    },
    [drafts],
  );

  // ===== Toast auto-hide =====
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(id);
  }, [toast]);

  // ===== Group navigation =====
  const orderedCodes = groups.map((g) => g.code);
  function navGroup(delta: number) {
    const idx = orderedCodes.indexOf(currentGroup);
    const next = orderedCodes[idx + delta];
    if (next) setCurrentGroup(next);
  }

  // ===== Render =====
  return (
    <div className="min-h-screen flex flex-col bg-paper">
      {/* TOP BAR */}
      <header className="bg-ink text-paper border-b-4 border-green flex-shrink-0">
        <div className="max-w-[1280px] mx-auto px-8 h-14 grid grid-cols-[auto_1fr_auto] items-center gap-6">
          <div className="flex items-center gap-2 font-anton uppercase tracking-wider text-base">
            <span className="w-2 h-2 bg-green rounded-full animate-pulse" />
            Bolão do Planinhas
          </div>
          <div className="hidden md:block text-center font-mono text-[11px] uppercase tracking-widest text-paper/70">
            bolaocopa26.com <span className="opacity-40 mx-1.5">/</span> apostas{" "}
            <span className="opacity-40 mx-1.5">/</span>
            <span className="text-yellow">grupo-{currentGroup.toLowerCase()}</span>
          </div>
          <div className="flex items-center gap-3 justify-end">
            <PushBell onToast={setToast} />
            <span className="hidden sm:block font-mono text-[11px] uppercase tracking-widest text-green">
              {user.name}
            </span>
          </div>
        </div>
      </header>

      {/* TABS */}
      <nav className="bg-paper border-b border-rule sticky top-0 z-20 overflow-x-auto flex-shrink-0">
        <div className="max-w-[1280px] mx-auto px-8 flex">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={[
                "px-[18px] py-[14px] font-anton text-[13px] uppercase tracking-wider whitespace-nowrap border-b-[3px] -mb-px flex items-center gap-2 transition-colors",
                tab === t.key
                  ? "text-green border-green"
                  : "text-soft border-transparent hover:text-ink",
              ].join(" ")}
            >
              {t.label}
              {t.key === "apostas" && (
                <span
                  className={[
                    "font-mono text-[9px] px-[7px] py-[2px] tracking-wider",
                    tab === "apostas" ? "bg-green text-paper" : "bg-paper3 text-ink",
                  ].join(" ")}
                >
                  {totalFilled}/{requiredTotal}
                </span>
              )}
            </button>
          ))}
          <a
            href="/chaveamento"
            className="px-[18px] py-[14px] font-anton text-[13px] uppercase tracking-wider whitespace-nowrap border-b-[3px] -mb-px text-soft border-transparent hover:text-ink transition-colors"
          >
            Chaveamento
          </a>
          <a
            href="/copa"
            className="px-[18px] py-[14px] font-anton text-[13px] uppercase tracking-wider whitespace-nowrap border-b-[3px] -mb-px text-yellow border-transparent hover:border-yellow transition-colors"
          >
            🏆 Mata-mata
          </a>
          <div className="flex-1" />
          {tab === "apostas" && (
            <div className="flex gap-0.5 items-center pr-4">
              <button
                onClick={() => navGroup(-1)}
                disabled={orderedCodes.indexOf(currentGroup) === 0}
                className="w-7 h-7 bg-paper border border-rule text-soft grid place-items-center font-anton text-sm hover:bg-ink hover:text-paper hover:border-ink disabled:opacity-30 disabled:hover:bg-paper disabled:hover:text-soft disabled:hover:border-rule"
                title="Grupo anterior"
              >
                ▲
              </button>
              <button
                onClick={() => navGroup(1)}
                disabled={orderedCodes.indexOf(currentGroup) === orderedCodes.length - 1}
                className="w-7 h-7 bg-paper border border-rule text-soft grid place-items-center font-anton text-sm hover:bg-ink hover:text-paper hover:border-ink disabled:opacity-30 disabled:hover:bg-paper disabled:hover:text-soft disabled:hover:border-rule"
                title="Próximo grupo"
              >
                ▼
              </button>
            </div>
          )}
        </div>
      </nav>

      {/* GROUP NAV (apenas aba apostas) */}
      {tab === "apostas" && (
        <div className="bg-paper2 border-b border-rule overflow-x-auto flex-shrink-0">
          <div className="max-w-[1280px] mx-auto px-8 py-2.5 flex items-center gap-2">
            <span className="font-mono text-[10px] tracking-widest uppercase text-mute pr-2.5 border-r border-rule mr-1 whitespace-nowrap">
              Grupos
            </span>
            {groups.map((g) => {
              const filled = groupFilledCount(g.id);
              const status =
                filled === 6 ? "full" : filled > 0 ? "some" : "empty";
              const dotColor =
                status === "full"
                  ? "bg-green"
                  : status === "some"
                    ? "bg-yellow"
                    : "bg-rule2";
              const isActive = g.code === currentGroup;
              return (
                <button
                  key={g.id}
                  onClick={() => setCurrentGroup(g.code)}
                  className={[
                    "px-3 py-1.5 border flex items-center gap-2 whitespace-nowrap transition-colors font-anton text-xs uppercase tracking-wider",
                    isActive
                      ? "bg-ink text-paper border-ink"
                      : "bg-paper text-soft border-rule hover:border-ink hover:text-ink",
                  ].join(" ")}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
                  {g.code}
                  <span className="opacity-60 font-mono text-[10px] tracking-normal normal-case">
                    {filled}/6
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* CONTEÚDO */}
      <main className="flex-1 pb-32">
        {tab === "apostas" && sealed && (
          <div className="max-w-[1280px] mx-auto px-8 pt-6">
            <div
              className={[
                "border-l-4 px-5 py-4 flex items-center gap-3",
                paymentStatus === "approved"
                  ? "border-green bg-green/10"
                  : "border-yellow bg-yellow/10",
              ].join(" ")}
            >
              <span className="font-anton text-2xl">
                {paymentStatus === "approved" ? "✓" : "⏳"}
              </span>
              <div className="flex-1">
                <div className="font-anton uppercase tracking-wider text-sm text-ink">
                  {paymentStatus === "approved"
                    ? "Aposta ativa · palpites travados"
                    : "Pix enviado · palpites travados"}
                </div>
                <div className="font-serif italic text-xs text-soft mt-0.5">
                  {paymentStatus === "approved"
                    ? "Seus 72 palpites estão selados. Boa sorte na Copa."
                    : "Aguardando aprovação do admin. Edição liberada se o Pix for negado."}
                </div>
              </div>
            </div>
          </div>
        )}
        {tab === "apostas" && editsUnlocked && (
          <div className="max-w-[1280px] mx-auto px-8 pt-4">
            <div className="border-l-4 border-yellow bg-yellow/10 px-5 py-4">
              <div className="font-anton uppercase tracking-wider text-sm text-ink">
                ✎ Edição liberada pra você
              </div>
              <div className="font-serif italic text-xs text-soft mt-0.5">
                O admin reabriu seus palpites pra ajuste. Altere o placar dos jogos que
                quiser e clique em{" "}
                <b className="text-green not-italic">Enviar atualizado</b> em cada um.
                Jogos que já começaram seguem travados.
              </div>
            </div>
          </div>
        )}
        {tab === "apostas" && sealed && reopenedCount > 0 && reopenWindowOpen && (
          <div className="max-w-[1280px] mx-auto px-8 pt-4">
            <div className="border-l-4 border-green bg-green/10 px-5 py-4">
              <div className="font-anton uppercase tracking-wider text-sm text-ink">
                ► {reopenedCount} jogo{reopenedCount > 1 ? "s" : ""} reaberto
                {reopenedCount > 1 ? "s" : ""} para correção
              </div>
              <div className="font-serif italic text-xs text-soft mt-0.5">
                Corrigimos uma seleção do Grupo A (Dinamarca → República Tcheca).
                Revise o placar nesses jogos e clique em{" "}
                <b className="text-green not-italic">Enviar atualizado</b>. Não
                precisa reenviar comprovante — os demais palpites seguem travados.
              </div>
            </div>
          </div>
        )}
        {tab === "apostas" && (
          <div className="max-w-[1280px] mx-auto px-8 py-8 grid lg:grid-cols-[1fr_360px] gap-8">
            {/* Matches pane */}
            <div className="space-y-3">
              {currentMatches.map((m, idx) => (
                <MatchRow
                  key={m.id}
                  match={m}
                  draft={drafts[m.id]}
                  index={idx}
                  now={now}
                  sealed={sealed}
                  reopenMode={editsUnlocked || (sealed && m.reopened && reopenWindowOpen)}
                  reopenSaving={!!reopenSaving[m.id]}
                  onChange={updateScore}
                  onLocalChange={updateScoreLocal}
                  onSubmitReopen={submitReopened}
                />
              ))}
              {currentMatches.length === 0 && (
                <div className="p-8 border-2 border-dashed border-rule bg-paper2 text-center font-mono text-xs uppercase tracking-widest text-mute">
                  Nenhum jogo cadastrado neste grupo.
                </div>
              )}
            </div>

            {/* Standings pane */}
            <aside className="lg:sticky lg:top-14 lg:self-start">
              <div className="border-2 border-ink p-5">
                <div className="flex items-baseline justify-between mb-1">
                  <h2 className="font-anton text-2xl uppercase tracking-tight text-ink">
                    Grupo <span className="text-green">{currentGroup}</span>
                  </h2>
                  <span className="font-mono text-[10px] uppercase tracking-widest text-green flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 bg-green rounded-full animate-pulse" />
                    ao vivo
                  </span>
                </div>
                <div className="font-serif italic text-xs text-soft mb-4">
                  recalcula a cada palpite digitado ·{" "}
                  {currentGroupObj ? groupFilledCount(currentGroupObj.id) : 0}/6 jogos
                </div>

                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b-2 border-ink">
                      <th className="text-left font-mono text-[10px] uppercase tracking-widest text-mute py-2">
                        Pos
                      </th>
                      <th className="text-left font-mono text-[10px] uppercase tracking-widest text-mute py-2">
                        Seleção
                      </th>
                      <th className="text-right font-mono text-[10px] uppercase tracking-widest text-mute py-2">
                        P
                      </th>
                      <th className="text-right font-mono text-[10px] uppercase tracking-widest text-mute py-2">
                        SG
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {standings.map((row) => (
                      <tr
                        key={row.team.id}
                        className={[
                          "border-b border-rule",
                          row.pos <= 2 ? "bg-green/5" : "",
                        ].join(" ")}
                      >
                        <td className="py-2.5 font-anton text-sm">
                          <span className={row.pos <= 2 ? "text-green" : "text-mute"}>
                            {row.pos}ª
                          </span>
                        </td>
                        <td className="py-2.5">
                          <div className="flex items-center gap-2">
                            <img
                              src={flagUrl(row.team.iso_code, 20)}
                              alt={row.team.name}
                              className="w-5 h-3.5 object-cover border border-rule"
                            />
                            <strong className="text-sm text-ink">{row.team.name}</strong>
                          </div>
                        </td>
                        <td className="py-2.5 text-right font-mono font-semibold text-ink">
                          {row.p}
                        </td>
                        <td className="py-2.5 text-right font-mono text-soft">
                          {row.sg > 0 ? "+" : ""}
                          {row.sg}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="mt-5 pt-4 border-t border-rule space-y-2">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-ink mb-2">
                    ► Regra de pontuação
                  </div>
                  <div className="text-xs text-soft">
                    <b className="text-green">+3</b> placar exato
                  </div>
                  <div className="text-xs text-soft">
                    <b className="text-green">+1</b> vencedor / empate
                  </div>
                  <div className="text-xs text-soft">
                    <b className="text-mute">0</b> errou
                  </div>
                </div>

                <div className="flex gap-2 mt-4">
                  <button
                    onClick={() => navGroup(-1)}
                    disabled={orderedCodes.indexOf(currentGroup) === 0}
                    className="flex-1 px-3 py-2 border border-rule text-soft font-mono text-[11px] uppercase tracking-widest hover:bg-ink hover:text-paper hover:border-ink disabled:opacity-30 disabled:hover:bg-paper disabled:hover:text-soft disabled:hover:border-rule"
                  >
                    ◂ Anterior
                  </button>
                  <button
                    onClick={() => navGroup(1)}
                    disabled={
                      orderedCodes.indexOf(currentGroup) === orderedCodes.length - 1
                    }
                    className="flex-1 px-3 py-2 border border-rule text-soft font-mono text-[11px] uppercase tracking-widest hover:bg-ink hover:text-paper hover:border-ink disabled:opacity-30 disabled:hover:bg-paper disabled:hover:text-soft disabled:hover:border-rule"
                  >
                    Próximo ▸
                  </button>
                </div>
              </div>
            </aside>
          </div>
        )}

        {tab === "ranking" && (
          <RankingTab
            rankings={rankings}
            currentUserId={currentUserId}
            totalMatches={matches.length}
          />
        )}
        {tab === "resultados" && <ResultadosTab matches={matches} />}
        {tab === "minhas" && <MinhasApostasTab matches={matches} />}
      </main>

      {/* STICKY FOOT CTA */}
      <footer className="fixed bottom-0 left-0 right-0 bg-ink text-paper border-t-4 border-green z-30">
        <div className="max-w-[1280px] mx-auto px-8 py-3 flex items-center gap-4">
          <div className="flex-1 flex items-center gap-3 font-mono text-[11px] uppercase tracking-widest">
            <span>
              <span className="text-yellow font-anton text-base mr-1">{totalFilled}</span>
              / {matches.length} palpites
            </span>
            <div className="hidden sm:block flex-1 h-1 bg-paper/15 max-w-[200px]">
              <div
                className="h-full bg-green transition-all"
                style={{ width: `${(totalFilled / Math.max(matches.length, 1)) * 100}%` }}
              />
            </div>
            <span className="hidden sm:inline text-paper/60">
              {((totalFilled / Math.max(matches.length, 1)) * 100).toFixed(0)}%
            </span>
          </div>
          <CTAButton
            totalFilled={totalFilled}
            totalMatches={requiredTotal}
            paymentStatus={paymentStatus}
            onClick={() => setShowPixModal(true)}
          />
        </div>
      </footer>

      {/* MODAL PIX */}
      {showPixModal && (
        <PixModal
          receiptFile={receiptFile}
          setReceiptFile={setReceiptFile}
          submitting={submittingPayment}
          error={paymentError}
          onClose={() => {
            if (submittingPayment) return;
            setShowPixModal(false);
            setPaymentError(null);
          }}
          onCopy={() => setToast("Chave Pix copiada")}
          onConfirm={async () => {
            if (!receiptFile) return;
            setSubmittingPayment(true);
            setPaymentError(null);
            try {
              const fd = new FormData();
              fd.append("receipt", receiptFile);
              const res = await submitPayment(fd);
              if (res.ok) {
                setShowPixModal(false);
                setReceiptFile(null);
                setToast("Pagamento enviado · aguardando aprovação");
              } else {
                // Erro fica FIXO dentro do modal — no toast ele sumia em
                // segundos e o apostador ficava achando que travou.
                setPaymentError(res.error);
              }
            } catch (e) {
              // Sem isto, uma exceção (ex.: comprovante maior que o limite
              // do servidor) deixava o botão preso em "Enviando..." pra sempre.
              console.error("[pix] submit falhou", e);
              setPaymentError(
                "O envio falhou no caminho — pode ser o tamanho do comprovante ou a conexão. Tente um arquivo menor (print da tela resolve) ou tente de novo.",
              );
            } finally {
              setSubmittingPayment(false);
            }
          }}
        />
      )}

      {/* TOAST */}
      {toast && (
        <div
          className="fixed left-1/2 -translate-x-1/2 bottom-24 bg-ink text-paper border-l-4 border-green px-5 py-3 font-anton text-[13px] uppercase tracking-wider z-40"
          style={{ boxShadow: "4px 4px 0 #009739" }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

function CTAButton({
  totalFilled,
  totalMatches,
  paymentStatus,
  onClick,
}: {
  totalFilled: number;
  totalMatches: number;
  paymentStatus: "pending" | "approved" | "denied" | null;
  onClick: () => void;
}) {
  if (paymentStatus === "approved") {
    return (
      <span className="inline-flex items-center gap-2 px-4 py-2.5 bg-green text-paper font-anton text-[13px] uppercase tracking-wider">
        ✓ Aposta ativa
      </span>
    );
  }
  if (paymentStatus === "pending") {
    return (
      <span className="inline-flex items-center gap-2 px-4 py-2.5 bg-yellow text-ink font-anton text-[13px] uppercase tracking-wider">
        ⏳ Aguardando aprovação
      </span>
    );
  }
  const ready = totalFilled === totalMatches && totalMatches > 0;
  return (
    <button
      onClick={ready ? onClick : undefined}
      disabled={!ready}
      className={[
        "px-4 py-2.5 font-anton text-[13px] uppercase tracking-wider border-2 transition-colors",
        ready
          ? "bg-green text-paper border-green hover:bg-green2 hover:border-green2 cursor-pointer"
          : "bg-paper/10 text-paper/40 border-paper/10 cursor-not-allowed",
      ].join(" ")}
    >
      {ready ? "Ativar aposta · R$ 50" : `Faltam ${totalMatches - totalFilled} palpites`}
    </button>
  );
}

function MatchRow({
  match,
  draft,
  index,
  now,
  sealed,
  reopenMode,
  reopenSaving,
  onChange,
  onLocalChange,
  onSubmitReopen,
}: {
  match: MatchView;
  draft: Draft | undefined;
  index: number;
  now: number;
  sealed: boolean;
  reopenMode: boolean;
  reopenSaving: boolean;
  onChange: (matchId: string, side: "home" | "away", val: string) => void;
  onLocalChange: (matchId: string, side: "home" | "away", val: string) => void;
  onSubmitReopen: (matchId: string) => void;
}) {
  const home = draft?.home ?? "";
  const away = draft?.away ?? "";
  const filled = parseScore(home) !== null && parseScore(away) !== null;

  // Trava de tempo (apito) — vale para todos, inclusive jogos reabertos.
  const timeLocked =
    match.status !== "scheduled" ||
    new Date(match.kickoff_at).getTime() - now <= 5 * 60 * 1000;
  // Editável se ainda não travou no tempo E (não está selado OU foi reaberto).
  const locked = timeLocked || (sealed && !reopenMode);
  const reopenEditable = reopenMode && !timeLocked;

  const countdown = !locked ? fmtCountdown(match.kickoff_at) : null;
  const showCountdown = countdown && new Date(match.kickoff_at).getTime() - now < 24 * 3600 * 1000;

  const status = reopenEditable ? (
    <span className="font-mono text-[10px] uppercase tracking-widest text-green">
      reaberto · atualize o placar
    </span>
  ) : sealed ? (
    <span className="font-mono text-[10px] uppercase tracking-widest text-green">
      aposta selada
    </span>
  ) : locked ? (
    <span className="font-mono text-[10px] uppercase tracking-widest text-red-600">
      apostas fechadas
    </span>
  ) : draft?.saving ? (
    <span className="font-mono text-[10px] uppercase tracking-widest text-mute">
      salvando…
    </span>
  ) : draft?.error ? (
    <span className="font-mono text-[10px] uppercase tracking-widest text-red-600">
      {draft.error}
    </span>
  ) : filled ? (
    <span className="font-mono text-[10px] uppercase tracking-widest text-green">
      aposta salva
    </span>
  ) : showCountdown ? (
    <span className="font-mono text-[10px] uppercase tracking-widest text-yellow-600">
      {countdown}
    </span>
  ) : (
    <span className="font-mono text-[10px] uppercase tracking-widest text-mute">
      sem palpite
    </span>
  );

  const inputCls = [
    "w-12 h-12 text-center font-anton text-2xl border-2 outline-none transition-colors",
    filled ? "border-green text-ink bg-paper" : "border-rule text-mute bg-paper",
    "focus:border-ink focus:bg-yellow/20",
    locked ? "opacity-60 cursor-not-allowed" : "",
  ].join(" ");

  return (
    <div className="border border-rule bg-paper p-4 hover:border-ink transition-colors">
      <div className="flex items-center justify-between mb-3 font-mono text-[10px] uppercase tracking-widest text-mute">
        <span>
          jogo {index + 1} · {fmtKickoff(match.kickoff_at)}
          {match.stadium ? ` · ${match.stadium}` : ""}
        </span>
        {status}
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <img
            src={flagUrl(match.home.iso_code, 80)}
            alt={match.home.name}
            className="w-9 h-6 object-cover border border-rule flex-shrink-0"
          />
          <span className="font-anton uppercase tracking-tight text-base truncate">
            {match.home.name}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            inputMode="numeric"
            value={home}
            disabled={locked}
            placeholder="–"
            onChange={(e) =>
              (reopenMode ? onLocalChange : onChange)(match.id, "home", e.target.value)
            }
            onFocus={(e) => e.currentTarget.select()}
            className={inputCls}
          />
          <span className="font-anton text-xl text-mute">×</span>
          <input
            type="text"
            inputMode="numeric"
            value={away}
            disabled={locked}
            placeholder="–"
            onChange={(e) =>
              (reopenMode ? onLocalChange : onChange)(match.id, "away", e.target.value)
            }
            onFocus={(e) => e.currentTarget.select()}
            className={inputCls}
          />
        </div>
        <div className="flex items-center gap-2.5 justify-end min-w-0">
          <span className="font-anton uppercase tracking-tight text-base truncate text-right">
            {match.away.name}
          </span>
          <img
            src={flagUrl(match.away.iso_code, 80)}
            alt={match.away.name}
            className="w-9 h-6 object-cover border border-rule flex-shrink-0"
          />
        </div>
      </div>
      {reopenEditable && (
        <div className="mt-3 pt-3 border-t border-rule flex justify-end">
          <button
            onClick={() => onSubmitReopen(match.id)}
            disabled={!filled || reopenSaving}
            className={[
              "px-4 py-2 font-anton text-[13px] uppercase tracking-wider border-2 transition-colors",
              !filled || reopenSaving
                ? "bg-paper2 text-mute border-rule cursor-not-allowed"
                : "bg-green text-paper border-green hover:bg-green2 hover:border-green2 cursor-pointer",
            ].join(" ")}
          >
            {reopenSaving ? "Enviando..." : "Enviar atualizado"}
          </button>
        </div>
      )}
    </div>
  );
}

function EmptyTab({ title, text }: { title: React.ReactNode; text: string }) {
  return (
    <div className="max-w-[700px] mx-auto px-8 py-24 text-center">
      <h2 className="font-anton text-4xl uppercase tracking-tight text-ink mb-4">
        {title}
      </h2>
      <p className="font-serif italic text-soft leading-relaxed">{text}</p>
    </div>
  );
}

const ENTRY_CENTS = 50_00; // R$50 por apostador

function calcPrizes(rankings: RankingRow[]): Map<string, number> {
  const n = rankings.length;
  if (n < 1) return new Map();

  const pool = n * ENTRY_CENTS;
  const lastPrize = ENTRY_CENTS;
  const remaining = pool - lastPrize;
  const TOP_PCT = [0.70, 0.20, 0.10];

  const maxPos = Math.max(...rankings.map((r) => r.position));
  const lastPlayers = rankings.filter((r) => r.position === maxPos);

  const prizes = new Map<string, number>();

  // Último(s): dividem R$50 igualmente
  const lastShare = Math.floor(lastPrize / lastPlayers.length);
  for (const p of lastPlayers) prizes.set(p.user_id, lastShare);

  // Top 3: empates agrupam as fatias combinadas
  let slot = 0;
  while (slot < 3 && remaining > 0) {
    const pos = slot + 1;
    const tied = rankings.filter((r) => r.position === pos);
    if (tied.length === 0) { slot++; continue; }

    const slotsUsed = Math.min(tied.length, 3 - slot);
    let combined = 0;
    for (let i = slot; i < slot + slotsUsed; i++) combined += Math.floor(TOP_PCT[i] * remaining);
    const share = Math.floor(combined / tied.length);
    for (const p of tied) if (!prizes.has(p.user_id)) prizes.set(p.user_id, share);
    slot += slotsUsed;
  }

  return prizes;
}

function fmtPrize(cents: number): string {
  if (cents === 0) return "—";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function RankingTab({
  rankings,
  currentUserId,
  totalMatches,
}: {
  rankings: RankingRow[];
  currentUserId: string;
  totalMatches: number;
}) {
  const prizes = calcPrizes(rankings);
  const maxPos = rankings.length > 0 ? Math.max(...rankings.map((r) => r.position)) : 0;

  // Tooltip dos badges (punição/entrada tardia): ancorado ACIMA, some em 4s
  const [tipFor, setTipFor] = useState<string | null>(null);
  useEffect(() => {
    if (!tipFor) return;
    const t = setTimeout(() => setTipFor(null), 4000);
    return () => clearTimeout(t);
  }, [tipFor]);

  if (rankings.length === 0) {
    return (
      <EmptyTab
        title={
          <>
            Ranking <span className="text-green">geral</span> aguardando
          </>
        }
        text="O ranking aparece aqui quando o admin lançar o primeiro resultado oficial. Só apostas com Pix aprovado entram na disputa."
      />
    );
  }

  return (
    <div className="max-w-[860px] mx-auto px-8 py-10">
      <div className="flex items-baseline justify-between mb-6">
        <h2 className="font-anton text-3xl uppercase tracking-tight text-ink">
          Ranking <span className="text-green">geral</span>
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-widest text-mute">
          {rankings.length} {rankings.length === 1 ? "participante" : "participantes"}
        </span>
      </div>

      <div className="border-2 border-ink">
        <table className="w-full border-collapse">
          <thead className="bg-ink text-paper">
            <tr>
              <th className="text-left font-mono text-[10px] uppercase tracking-widest py-2.5 px-3 w-12">
                #
              </th>
              <th className="text-left font-mono text-[10px] uppercase tracking-widest py-2.5 px-3">
                Jogador
              </th>
              <th className="hidden sm:table-cell text-right font-mono text-[10px] uppercase tracking-widest py-2.5 px-3 w-14">
                Exatos
              </th>
              <th className="hidden sm:table-cell text-right font-mono text-[10px] uppercase tracking-widest py-2.5 px-3 w-14">
                Parciais
              </th>
              <th className="text-right font-mono text-[10px] uppercase tracking-widest py-2.5 px-3 w-14">
                Pts
              </th>
              <th className="text-right font-mono text-[10px] uppercase tracking-widest py-2.5 px-3 w-20">
                Prêmio
              </th>
            </tr>
          </thead>
          <tbody>
            {rankings.map((r) => {
              const isMe = r.user_id === currentUserId;
              return (
                <tr
                  key={r.user_id}
                  className={[
                    "border-b border-rule last:border-b-0",
                    isMe ? "bg-green/10" : "",
                  ].join(" ")}
                >
                  <td className="py-3 px-3 font-anton text-base">
                    <span className={r.position <= 3 ? "text-green" : "text-mute"}>
                      {r.position}º
                    </span>
                  </td>
                  <td className="py-3 px-3">
                    <div className="flex items-center gap-2.5">
                      {r.avatar_url ? (
                        <img
                          src={r.avatar_url}
                          alt=""
                          className="w-6 h-6 rounded-full border border-rule object-cover"
                        />
                      ) : (
                        <span className="w-6 h-6 rounded-full bg-paper2 border border-rule grid place-items-center font-mono text-[10px] text-mute">
                          {(r.name ?? "?").slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      <span className="font-anton uppercase tracking-tight text-sm text-ink flex items-center flex-wrap gap-x-1.5 min-w-0">
                        {r.position === 1 && (
                          <span className="relative inline-flex flex-shrink-0">
                            <button type="button" className="cursor-help text-base leading-none" onClick={() => setTipFor(tipFor === `${r.user_id}:crown` ? null : `${r.user_id}:crown`)}>👑</button>
                            {tipFor === `${r.user_id}:crown` && (
                              <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-max max-w-[200px] bg-ink text-paper font-serif normal-case tracking-normal text-[11px] leading-snug px-3 py-2 text-center z-30 shadow-lg">
                                Rei do pitaco 🏆
                                <span className="absolute top-full left-1/2 -translate-x-1/2 border-[5px] border-transparent border-t-ink" />
                              </span>
                            )}
                          </span>
                        )}
                        {r.position === maxPos && rankings.length > 1 && (
                          <span className="relative inline-flex flex-shrink-0">
                            <button type="button" className="cursor-help text-base leading-none" onClick={() => setTipFor(tipFor === `${r.user_id}:clown` ? null : `${r.user_id}:clown`)}>🤡</button>
                            {tipFor === `${r.user_id}:clown` && (
                              <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-max max-w-[200px] bg-ink text-paper font-serif normal-case tracking-normal text-[11px] leading-snug px-3 py-2 text-center z-30 shadow-lg">
                                Parabéns pela participação 🎉
                                <span className="absolute top-full left-1/2 -translate-x-1/2 border-[5px] border-transparent border-t-ink" />
                              </span>
                            )}
                          </span>
                        )}
                        <Link href={`/apostas/${r.user_id}`} className="hover:text-green transition-colors">{r.name ?? "Sem nome"}</Link>
                        {(r.penalty_points ?? 0) > 0 && (
                          <span className="relative inline-flex flex-shrink-0">
                            <button
                              type="button"
                              className="cursor-help grid place-items-center"
                              title={
                                r.penalty_reason ??
                                `Punição: -${r.penalty_points} ponto(s) aplicado(s) pelo admin`
                              }
                              onClick={() =>
                                setTipFor(
                                  tipFor === `${r.user_id}:pen` ? null : `${r.user_id}:pen`,
                                )
                              }
                            >
                              {/* martelo de juiz (gavel) — não existe como emoji */}
                              <svg
                                viewBox="0 0 24 24"
                                className="w-3.5 h-3.5 fill-amber-700"
                                aria-label="Punição do juiz"
                              >
                                <path d="M2 21v-2h12v2H2zm4.3-7.7L2.05 9.05l2.1-2.1 4.25 4.25-2.1 2.1zm6.4-6.4L8.45 2.65l2.1-2.1 4.25 4.25-2.1 2.1zm7.7 14.05L7.1 7.65l2.1-2.1 13.3 13.3-2.1 2.1z" />
                              </svg>
                            </button>
                            {tipFor === `${r.user_id}:pen` && (
                              <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-max max-w-[230px] bg-ink text-paper font-serif normal-case tracking-normal text-[11px] leading-snug px-3 py-2 text-center z-30 shadow-lg">
                                {r.penalty_reason ??
                                  `-${r.penalty_points} ponto(s) por punição do admin`}
                                <span className="absolute top-full left-1/2 -translate-x-1/2 border-[5px] border-transparent border-t-ink" />
                              </span>
                            )}
                          </span>
                        )}
                        {(r.bet_count ?? totalMatches) < totalMatches && (
                          <span className="relative inline-flex flex-shrink-0">
                            <button
                              type="button"
                              className="cursor-help w-4 h-4 rounded-full border border-soft text-soft grid place-items-center font-serif italic text-[10px] leading-none hover:border-ink hover:text-ink"
                              title={`Entrou no bolão com a Copa em andamento — ${totalMatches - (r.bet_count ?? 0)} jogo(s) já realizados ficam fora da pontuação dele.`}
                              onClick={() =>
                                setTipFor(
                                  tipFor === `${r.user_id}:late` ? null : `${r.user_id}:late`,
                                )
                              }
                            >
                              i
                            </button>
                            {tipFor === `${r.user_id}:late` && (
                              <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-max max-w-[240px] bg-ink text-paper font-serif normal-case tracking-normal text-[11px] leading-snug px-3 py-2 text-center z-30 shadow-lg">
                                Entrou no bolão com a Copa em andamento —{" "}
                                {totalMatches - (r.bet_count ?? 0)} jogo(s) já realizados ficam
                                fora da pontuação dele.
                                <span className="absolute top-full left-1/2 -translate-x-1/2 border-[5px] border-transparent border-t-ink" />
                              </span>
                            )}
                          </span>
                        )}
                        {isMe && (
                          <span className="font-mono text-[9px] tracking-widest text-green">
                            VOCÊ
                          </span>
                        )}
                      </span>
                    </div>
                  </td>
                  <td className="hidden sm:table-cell py-3 px-3 text-right font-mono text-sm text-soft">
                    {r.exact_hits}
                  </td>
                  <td className="hidden sm:table-cell py-3 px-3 text-right font-mono text-sm text-soft">
                    {r.partial_hits}
                  </td>
                  <td className="py-3 px-3 text-right font-anton text-lg text-ink">
                    {r.total_points}
                  </td>
                  <td className="py-3 px-3 text-right font-mono text-xs whitespace-nowrap">
                    <span className={
                      (prizes.get(r.user_id) ?? 0) > 0
                        ? r.position === maxPos ? "text-amber-600 font-bold" : "text-green font-bold"
                        : "text-mute"
                    }>
                      {fmtPrize(prizes.get(r.user_id) ?? 0)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-4 font-serif italic text-xs text-soft">
        <b className="text-green">+3</b> placar exato · <b className="text-green">+1</b> acertou o vencedor · <b className="text-mute">0</b> errou feio.
        {" "}Empates no ranking dividem o prêmio — ninguém fica de fora.
      </p>
      <p className="mt-1 font-serif italic text-xs text-soft">
        💰 <b className="text-green">1º fatura 70%</b> · 2º leva 20% · 3º fica com 10% — tudo calculado em cima do que entrou no caixão.
        {" "}🤡 <b className="text-amber-600">Lanterna ganha R$50 de volta</b> — pelo menos não vai de graça.
      </p>
    </div>
  );
}

// Relógio ESTIMADO pelo horário nominal do apito (a fonte gratuita não dá o
// minuto oficial): 45' + 15 de intervalo + 2º tempo. O "~" avisa que é aproximado.
function liveClock(kickoffIso: string, nowMs: number): string {
  const min = Math.floor((nowMs - new Date(kickoffIso).getTime()) / 60000);
  if (min < 1) return "apita o árbitro";
  if (min <= 47) return `~${Math.min(45, min)}' 1ºT`;
  if (min <= 62) return "intervalo";
  if (min <= 112) return `~${Math.min(90, min - 17)}' 2ºT`;
  return "acréscimos";
}

type MatchPred = { userId: string; name: string; avatar_url: string | null; home_score: number; away_score: number; points: number; computed: boolean };

/**
 * Popup com o palpite e a pontuação de TODOS os apostadores de um jogo.
 * Reaproveitado nas abas Resultados e Minhas apostas. Busca os palpites
 * sozinho a partir do match.id. Para jogos que ainda não começaram (sem
 * placar) mostra "-" na pontuação, em vez de "0".
 */
function MatchPredictionsModal({ match, onClose }: { match: MatchView | null; onClose: () => void }) {
  const [preds, setPreds] = useState<MatchPred[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!match) { setPreds(null); return; }
    setLoading(true);
    fetch(`/api/match-predictions/${match.id}`)
      .then((r) => r.json())
      .then((d) => { setPreds(d.predictions ?? []); setLoading(false); })
      .catch(() => { setPreds([]); setLoading(false); });
  }, [match]);

  if (!match) return null;

  const hasScore = match.home_score !== null && match.away_score !== null;
  const notStarted = !hasScore;
  const live = match.status !== "finished";

  return (
    <div className="fixed inset-0 bg-ink/60 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-paper w-full sm:max-w-sm max-h-[80vh] overflow-y-auto border-t-4 sm:border-4 border-ink" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-rule flex items-center justify-between sticky top-0 bg-paper z-10">
          <div>
            <p className="font-anton uppercase text-base text-ink">
              {notStarted ? "Palpites · não começou" : live ? "Palpites · ao vivo" : "Palpites do jogo"}
            </p>
            <p className="font-mono text-[10px] uppercase tracking-widest text-mute">
              {match.home.name} {hasScore ? `${match.home_score} × ${match.away_score}` : "×"} {match.away.name}
            </p>
            {live && !notStarted && (
              <p className="font-mono text-[9px] uppercase tracking-widest text-green font-bold mt-0.5">
                ● pontuação parcial — o jogo ainda está rolando
              </p>
            )}
          </div>
          <button type="button" className="font-anton text-xl text-mute hover:text-ink leading-none" onClick={onClose}>×</button>
        </div>
        <div className="divide-y divide-rule">
          {loading && <div className="p-6 text-center font-mono text-xs text-mute">carregando...</div>}
          {!loading && preds && preds.length === 0 && (
            <div className="p-6 text-center font-mono text-xs text-mute">ninguém palpitou nesse jogo 😅</div>
          )}
          {!loading && preds && preds.map((p, i) => (
            <div key={p.userId} className="px-4 py-2.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-anton text-xs text-mute w-5 text-right flex-shrink-0 tabular-nums">{i + 1}</span>
                {p.avatar_url ? (
                  <img src={p.avatar_url} alt="" className="w-6 h-6 rounded-full border border-rule object-cover flex-shrink-0" />
                ) : (
                  <span className="w-6 h-6 rounded-full bg-paper2 border border-rule grid place-items-center font-mono text-[10px] text-mute flex-shrink-0">
                    {(p.name ?? "?").slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="font-anton uppercase tracking-tight text-sm truncate">{p.name ?? "?"}</span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="font-mono text-sm whitespace-nowrap">{p.home_score} × {p.away_score}</span>
                <span className={[
                  "font-anton text-[10px] px-1.5 py-0.5 whitespace-nowrap",
                  notStarted ? "bg-paper2 text-mute"
                    : p.points === 3 ? "bg-green text-paper"
                      : p.points === 1 ? "bg-yellow text-ink"
                        : "bg-paper2 text-mute",
                ].join(" ")}>
                  {notStarted ? "–" : p.points === 3 ? "🎯 +3" : p.points === 1 ? "+1" : "0"}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ResultadosTab({ matches }: { matches: MatchView[] }) {
  const nowMs = Date.now();
  const [openMatchId, setOpenMatchId] = useState<string | null>(null);
  const openMatch = openMatchId ? matches.find((m) => m.id === openMatchId) ?? null : null;

  const live = matches.filter((m) => {
    if (m.status === "finished") return false;
    const ko = new Date(m.kickoff_at).getTime();
    return nowMs >= ko && nowMs <= ko + 3 * 3600_000;
  });
  const finished = matches.filter(
    (m) => m.status === "finished" && m.home_score !== null && m.away_score !== null,
  );

  if (finished.length === 0 && live.length === 0) {
    return (
      <EmptyTab
        title={
          <>
            Aguardando o <span className="text-green">apito inicial</span>
          </>
        }
        text="Os resultados oficiais aparecem aqui conforme os jogos vão acabando. Sua pontuação é calculada automaticamente sobre cada placar inserido pelo admin."
      />
    );
  }

  const list = [
    ...live.map((m) => ({ m, isLive: true })),
    ...finished.map((m) => ({ m, isLive: false })),
  ];

  return (
    <div className="max-w-[860px] mx-auto px-8 py-10">
      <div className="flex items-baseline justify-between mb-6">
        <h2 className="font-anton text-3xl uppercase tracking-tight text-ink">
          <span className="text-green">Resultados</span> oficiais
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-widest text-mute">
          {live.length > 0 && (
            <b className="text-green mr-2">● {live.length} ao vivo</b>
          )}
          {finished.length} {finished.length === 1 ? "jogo encerrado" : "jogos encerrados"}
        </span>
      </div>

      <div className="space-y-3">
        {list.map(({ m, isLive }) => {
          const hit = m.prediction
            ? m.prediction.points === 3
              ? "exact"
              : m.prediction.points === 1
                ? "partial"
                : "miss"
            : "none";
          return (
            <div
              key={m.id}
              className={[
                "border border-rule bg-paper p-4 grid grid-cols-[1fr_auto_1fr] items-center gap-3",
                "cursor-pointer hover:border-ink transition-colors",
              ].join(" ")}
              onClick={() => setOpenMatchId(m.id)}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <img
                  src={flagUrl(m.home.iso_code, 80)}
                  alt=""
                  className="w-9 h-6 object-cover border border-rule flex-shrink-0"
                />
                <span className="font-anton uppercase tracking-tight text-base truncate">
                  {m.home.name}
                </span>
              </div>
              <div className="flex flex-col items-center gap-1">
                {isLive && m.home_score === null ? (
                  <div className="font-mono text-[9px] uppercase tracking-widest text-green font-bold text-center leading-tight">
                    APITA O<br />ÁRBITRO
                  </div>
                ) : (
                  <div className="font-anton text-2xl text-ink">
                    {m.home_score ?? 0} <span className="text-mute text-base mx-1">×</span>{" "}
                    {m.away_score ?? 0}
                  </div>
                )}
                {isLive ? (
                  <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-widest text-green font-bold">
                    <span className="w-1.5 h-1.5 bg-green rounded-full animate-pulse" />
                    Ao vivo · {liveClock(m.kickoff_at, nowMs)}
                  </div>
                ) : (
                  <div className="font-mono text-[9px] uppercase tracking-widest text-mute">
                    {fmtKickoff(m.kickoff_at)}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2.5 justify-end min-w-0">
                <span className="font-anton uppercase tracking-tight text-base truncate text-right">
                  {m.away.name}
                </span>
                <img
                  src={flagUrl(m.away.iso_code, 80)}
                  alt=""
                  className="w-9 h-6 object-cover border border-rule flex-shrink-0"
                />
              </div>
              {m.prediction && (
                <div className="col-span-3 pt-3 mt-1 border-t border-rule flex items-center justify-between font-mono text-[11px] uppercase tracking-widest">
                  <span className="text-mute">
                    seu palpite{" "}
                    <b className="text-ink ml-1">
                      {m.prediction.home_score} × {m.prediction.away_score}
                    </b>
                  </span>
                  <span
                    className={[
                      "px-2 py-1 font-anton text-[10px]",
                      hit === "exact"
                        ? "bg-green text-paper"
                        : hit === "partial"
                          ? "bg-yellow text-ink"
                          : "bg-paper2 text-mute",
                    ].join(" ")}
                  >
                    {hit === "exact"
                      ? "+3 placar exato"
                      : hit === "partial"
                        ? "+1 vencedor"
                        : "0 errou"}
                  </span>
                </div>
              )}
              {!m.prediction && (
                <div className="col-span-3 pt-3 mt-1 border-t border-rule font-mono text-[10px] uppercase tracking-widest text-mute">
                  você não palpitou neste jogo
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-4 font-serif italic text-xs text-soft">Toque em qualquer jogo — ao vivo ou encerrado — para ver o palpite e a pontuação de todos.</p>

      <MatchPredictionsModal match={openMatch} onClose={() => setOpenMatchId(null)} />
    </div>
  );
}

function MinhasApostasTab({ matches }: { matches: MatchView[] }) {
  const [openMatchId, setOpenMatchId] = useState<string | null>(null);
  const openMatch = openMatchId ? matches.find((m) => m.id === openMatchId) ?? null : null;
  const withPrediction = matches.filter((m) => m.prediction !== null);
  const totalPoints = withPrediction.reduce(
    (s, m) => s + (m.prediction?.points ?? 0),
    0,
  );
  const resolved = withPrediction.filter((m) => m.prediction?.computed_at);
  const exactHits = resolved.filter((m) => m.prediction?.points === 3).length;
  const partialHits = resolved.filter((m) => m.prediction?.points === 1).length;

  if (withPrediction.length === 0) {
    return (
      <EmptyTab
        title={
          <>
            Sem <span className="text-green">apostas</span> ainda
          </>
        }
        text="Volte na aba Apostas e preencha seus palpites jogo a jogo. Eles ficam salvos automaticamente."
      />
    );
  }

  return (
    <div className="max-w-[860px] mx-auto px-8 py-10">
      <div className="flex items-baseline justify-between mb-6">
        <h2 className="font-anton text-3xl uppercase tracking-tight text-ink">
          Minhas <span className="text-green">apostas</span>
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-widest text-mute">
          {withPrediction.length}/{matches.length} palpites
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        <Stat label="Pontos" value={totalPoints} accent />
        <Stat label="Apurados" value={resolved.length} />
        <Stat label="Exatos" value={exactHits} />
        <Stat label="Parciais" value={partialHits} />
      </div>

      <div className="space-y-2">
        {withPrediction.map((m) => {
          const computed = !!m.prediction?.computed_at;
          const pts = m.prediction?.points ?? 0;
          return (
            <div
              key={m.id}
              className="border border-rule bg-paper p-3 grid grid-cols-[1fr_auto_1fr_auto] items-center gap-3 cursor-pointer hover:border-ink transition-colors"
              onClick={() => setOpenMatchId(m.id)}
            >
              <div className="flex items-center gap-2 min-w-0">
                <img
                  src={flagUrl(m.home.iso_code, 80)}
                  alt=""
                  className="w-7 h-5 object-cover border border-rule flex-shrink-0"
                />
                <span className="font-anton uppercase tracking-tight text-sm truncate">
                  {m.home.name}
                </span>
              </div>
              <div className="font-anton text-lg text-ink whitespace-nowrap">
                {m.prediction?.home_score} <span className="text-mute mx-0.5">×</span>{" "}
                {m.prediction?.away_score}
              </div>
              <div className="flex items-center gap-2 justify-end min-w-0">
                <span className="font-anton uppercase tracking-tight text-sm truncate text-right">
                  {m.away.name}
                </span>
                <img
                  src={flagUrl(m.away.iso_code, 80)}
                  alt=""
                  className="w-7 h-5 object-cover border border-rule flex-shrink-0"
                />
              </div>
              <div className="text-right min-w-[80px]">
                {computed ? (
                  <span
                    className={[
                      "inline-block px-2 py-1 font-anton text-[11px] uppercase tracking-wider",
                      pts === 3
                        ? "bg-green text-paper"
                        : pts === 1
                          ? "bg-yellow text-ink"
                          : "bg-paper2 text-mute",
                    ].join(" ")}
                  >
                    +{pts} pt{pts !== 1 ? "s" : ""}
                  </span>
                ) : (
                  <span className="font-mono text-[9px] uppercase tracking-widest text-mute">
                    {fmtKickoff(m.kickoff_at)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-4 font-serif italic text-xs text-soft">Toque em qualquer jogo para ver o palpite e a pontuação de todos.</p>

      <MatchPredictionsModal match={openMatch} onClose={() => setOpenMatchId(null)} />
    </div>
  );
}

function Stat({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div
      className={[
        "border-2 p-3",
        accent ? "border-ink bg-ink text-paper" : "border-rule bg-paper",
      ].join(" ")}
    >
      <div
        className={[
          "font-mono text-[10px] uppercase tracking-widest mb-1",
          accent ? "text-green" : "text-mute",
        ].join(" ")}
      >
        {label}
      </div>
      <div className="font-anton text-3xl leading-none">{value}</div>
    </div>
  );
}

function PixModal({
  receiptFile,
  setReceiptFile,
  submitting,
  error,
  onClose,
  onCopy,
  onConfirm,
}: {
  receiptFile: File | null;
  setReceiptFile: (f: File | null) => void;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onCopy: () => void;
  onConfirm: () => void;
}) {
  const pixKey = process.env.NEXT_PUBLIC_PIX_KEY ?? "Configure NEXT_PUBLIC_PIX_KEY";
  const amount = process.env.NEXT_PUBLIC_PIX_AMOUNT ?? "50";

  function copy() {
    navigator.clipboard.writeText(pixKey).then(onCopy).catch(() => onCopy());
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    if (!f) {
      setReceiptFile(null);
      return;
    }
    if (f.size > 5 * 1024 * 1024) {
      alert("Arquivo muito grande (máx 5MB).");
      e.target.value = "";
      setReceiptFile(null);
      return;
    }
    setReceiptFile(f);
  }

  return (
    <div
      className="fixed inset-0 bg-ink/60 z-50 grid place-items-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-paper border-2 border-ink max-w-md w-full"
        style={{ boxShadow: "8px 8px 0 #009739" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b-2 border-ink">
          <h3 className="font-anton text-lg uppercase tracking-wider text-ink">
            ► Ativar aposta · Pix
          </h3>
          <button
            onClick={onClose}
            className="w-8 h-8 grid place-items-center text-soft hover:text-ink"
          >
            ✕
          </button>
        </div>
        <div className="p-6 text-center">
          <div className="font-anton text-5xl text-ink mb-1">R$ {amount},00</div>
          <div className="font-mono text-[11px] uppercase tracking-widest text-mute mb-6">
            aposta única · 72 palpites
          </div>

          <div className="text-left mb-4">
            <div className="font-mono text-[10px] uppercase tracking-widest text-mute mb-2">
              ► 1. Pague o Pix
            </div>
            <button
              onClick={copy}
              className="w-full font-mono text-xs bg-paper2 px-4 py-3 border-2 border-dashed border-rule hover:bg-green/5 hover:border-green hover:text-green transition-colors break-all"
            >
              {pixKey}
            </button>
            <div className="font-serif italic text-[11px] text-soft mt-1.5">
              Chave Pix CPF · clique para copiar
            </div>
          </div>

          <div className="text-left">
            <div className="font-mono text-[10px] uppercase tracking-widest text-mute mb-2">
              ► 2. Anexe o comprovante
            </div>
            <label
              className={[
                "block p-4 border-2 border-dashed cursor-pointer transition-colors",
                receiptFile
                  ? "border-green bg-green/5 text-green"
                  : "border-rule bg-paper2 text-soft hover:border-ink hover:text-ink",
              ].join(" ")}
            >
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,application/pdf"
                onChange={onPick}
                className="hidden"
                disabled={submitting}
              />
              <div className="font-anton text-sm uppercase tracking-wider">
                {receiptFile ? "✓ " + truncate(receiptFile.name, 32) : "Selecionar arquivo"}
              </div>
              <div className="font-serif italic text-[11px] mt-1 opacity-80">
                PNG, JPG, WEBP ou PDF · até 5 MB
              </div>
            </label>
          </div>

          {error && (
            <div className="mt-4 text-left border-l-4 border-red-600 bg-red-50 px-4 py-3">
              <div className="font-anton text-[12px] uppercase tracking-wider text-red-700">
                Não foi possível ativar
              </div>
              <p className="font-serif text-[13px] text-ink mt-1">{error}</p>
            </div>
          )}

          <button
            onClick={onConfirm}
            disabled={!receiptFile || submitting}
            className="w-full mt-5 px-4 py-3.5 bg-green text-paper font-anton text-sm uppercase tracking-wider border-2 border-green disabled:bg-rule disabled:border-rule disabled:text-mute disabled:cursor-not-allowed"
          >
            {submitting ? "Enviando..." : "Confirmar pagamento"}
          </button>
        </div>
      </div>
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
