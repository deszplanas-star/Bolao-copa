"use client";

import { useMemo, useState, useTransition } from "react";
import type { Group, Match, Team } from "@/lib/types";
import {
  approvePayment,
  clearMatchResult,
  denyPayment,
  notifyCountdown,
  notifyCzechFix,
  resendApprovedPdfs,
  sendAdminTestEmail,
  setMatchResult,
} from "./actions";

type EnrichedPayment = {
  id: string;
  user_id: string;
  amount_cents: number;
  status: "pending" | "approved" | "denied";
  user_confirmed_at: string | null;
  approved_at: string | null;
  denied_reason: string | null;
  created_at: string;
  user: { id: string; email: string; name: string | null } | null;
};

type EnrichedMatch = Match & { home: Team; away: Team };

type Props = {
  admin: { id: string; email: string; name: string };
  payments: EnrichedPayment[];
  groups: Group[];
  matches: EnrichedMatch[];
};

const TABS = [
  { key: "pagamentos", label: "Pagamentos" },
  { key: "resultados", label: "Resultados" },
  { key: "comunicacao", label: "Comunicação" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const flagUrl = (iso: string, w = 40) => `https://flagcdn.com/w${w}/${iso}.png`;

function fmtMoney(cents: number) {
  return `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;
}
function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AdminClient({ admin, payments, groups, matches }: Props) {
  const [tab, setTab] = useState<TabKey>("pagamentos");
  const [toast, setToast] = useState<string | null>(null);
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [groupFilter, setGroupFilter] = useState<string>("all");

  const filteredPayments = useMemo(() => {
    if (filter === "pending") return payments.filter((p) => p.status === "pending");
    return payments;
  }, [payments, filter]);

  const filteredMatches = useMemo(() => {
    if (groupFilter === "all") return matches;
    const g = groups.find((x) => x.code === groupFilter);
    if (!g) return matches;
    return matches.filter((m) => m.group_id === g.id);
  }, [matches, groupFilter, groups]);

  const counts = {
    pending: payments.filter((p) => p.status === "pending").length,
    approved: payments.filter((p) => p.status === "approved").length,
    finished: matches.filter((m) => m.status === "finished").length,
    total: matches.length,
  };

  return (
    <div className="min-h-screen flex flex-col bg-paper">
      {/* TOP BAR */}
      <header className="bg-ink text-paper border-b-4 border-yellow flex-shrink-0">
        <div className="max-w-[1400px] mx-auto px-8 h-14 grid grid-cols-[auto_1fr_auto] items-center gap-6">
          <div className="flex items-center gap-2 font-anton uppercase tracking-wider text-base">
            <span className="w-2 h-2 bg-yellow rounded-full animate-pulse" />
            Bolão / 26 · Admin
          </div>
          <div className="hidden md:block text-center font-mono text-[11px] uppercase tracking-widest text-paper/70">
            painel administrativo
          </div>
          <div className="font-mono text-[11px] uppercase tracking-widest text-yellow">
            {admin.name}
          </div>
        </div>
      </header>

      {/* TABS */}
      <nav className="bg-paper border-b border-rule sticky top-0 z-20 flex-shrink-0">
        <div className="max-w-[1400px] mx-auto px-8 flex">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={[
                "px-[18px] py-[14px] font-anton text-[13px] uppercase tracking-wider whitespace-nowrap border-b-[3px] -mb-px flex items-center gap-2 transition-colors",
                tab === t.key
                  ? "text-yellow border-yellow"
                  : "text-soft border-transparent hover:text-ink",
              ].join(" ")}
            >
              {t.label}
              <span
                className={[
                  "font-mono text-[9px] px-[7px] py-[2px] tracking-wider",
                  tab === t.key ? "bg-yellow text-ink" : "bg-paper3 text-ink",
                ].join(" ")}
              >
                {t.key === "pagamentos"
                  ? `${counts.pending} pend.`
                  : t.key === "resultados"
                    ? `${counts.finished}/${counts.total}`
                    : `${counts.approved} aprov.`}
              </span>
            </button>
          ))}
          <div className="flex-1" />
          <a
            href="/apostas"
            className="px-4 py-3.5 font-mono text-[11px] uppercase tracking-widest text-soft hover:text-ink"
          >
            ← Voltar pra apostas
          </a>
        </div>
      </nav>

      <main className="flex-1 max-w-[1400px] mx-auto w-full px-8 py-8">
        {tab === "pagamentos" && (
          <PaymentsTab
            payments={filteredPayments}
            filter={filter}
            setFilter={setFilter}
            onToast={setToast}
          />
        )}
        {tab === "resultados" && (
          <ResultsTab
            matches={filteredMatches}
            groups={groups}
            groupFilter={groupFilter}
            setGroupFilter={setGroupFilter}
            onToast={setToast}
          />
        )}
        {tab === "comunicacao" && (
          <ComunicacaoTab approvedCount={counts.approved} onToast={setToast} />
        )}
      </main>

      {toast && (
        <div
          className="fixed left-1/2 -translate-x-1/2 bottom-8 bg-ink text-paper border-l-4 border-yellow px-5 py-3 font-anton text-[13px] uppercase tracking-wider z-40"
          style={{ boxShadow: "4px 4px 0 #FFDF00" }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

// ============================================================
// PAGAMENTOS
// ============================================================

function PaymentsTab({
  payments,
  filter,
  setFilter,
  onToast,
}: {
  payments: EnrichedPayment[];
  filter: "pending" | "all";
  setFilter: (v: "pending" | "all") => void;
  onToast: (msg: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [denyId, setDenyId] = useState<string | null>(null);
  const [denyReason, setDenyReason] = useState("");

  function handleApprove(id: string) {
    startTransition(async () => {
      const res = await approvePayment({ payment_id: id });
      onToast(res.ok ? "Pagamento aprovado" : res.error);
    });
  }

  function handleDeny(id: string, reason: string) {
    startTransition(async () => {
      const res = await denyPayment({ payment_id: id, reason });
      onToast(res.ok ? "Pagamento negado" : res.error);
      if (res.ok) {
        setDenyId(null);
        setDenyReason("");
      }
    });
  }

  return (
    <div>
      <div className="flex items-baseline justify-between mb-6">
        <div>
          <h1 className="font-anton text-4xl uppercase tracking-tight text-ink">
            <span className="text-yellow">►</span> Pagamentos Pix
          </h1>
          <p className="font-serif italic text-soft mt-1 text-sm">
            Cada usuário declara que pagou — você compara com o extrato e aprova ou nega.
          </p>
        </div>
        <div className="flex gap-1">
          {(["pending", "all"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setFilter(v)}
              className={[
                "px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest border",
                filter === v
                  ? "bg-ink text-paper border-ink"
                  : "bg-paper text-soft border-rule hover:border-ink",
              ].join(" ")}
            >
              {v === "pending" ? "Pendentes" : "Todos"}
            </button>
          ))}
        </div>
      </div>

      {payments.length === 0 ? (
        <div className="p-12 border-2 border-dashed border-rule bg-paper2 text-center">
          <p className="font-serif italic text-soft">
            {filter === "pending"
              ? "Nenhum pagamento pendente. Tudo em dia."
              : "Nenhum pagamento registrado ainda."}
          </p>
        </div>
      ) : (
        <div className="border border-rule overflow-hidden">
          <table className="w-full">
            <thead className="bg-paper2 border-b-2 border-ink">
              <tr>
                <th className="text-left px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-mute">
                  Usuário
                </th>
                <th className="text-left px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-mute">
                  Valor
                </th>
                <th className="text-left px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-mute">
                  Declarado em
                </th>
                <th className="text-left px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-mute">
                  Status
                </th>
                <th className="text-right px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-mute">
                  Ações
                </th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="border-b border-rule hover:bg-paper2">
                  <td className="px-4 py-3">
                    <div className="font-anton text-sm uppercase tracking-tight text-ink">
                      {p.user?.name ?? "—"}
                    </div>
                    <div className="font-mono text-[10px] text-mute">
                      {p.user?.email ?? "—"}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-sm text-ink">
                    {fmtMoney(p.amount_cents)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-soft">
                    {fmtDate(p.user_confirmed_at)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={p.status} reason={p.denied_reason} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    {p.status === "pending" && (
                      <div className="inline-flex gap-2">
                        <button
                          onClick={() => handleApprove(p.id)}
                          disabled={pending}
                          className="px-3 py-1.5 bg-green text-paper font-anton text-[11px] uppercase tracking-wider border-2 border-green hover:bg-green2 disabled:opacity-50"
                        >
                          Aprovar
                        </button>
                        <button
                          onClick={() => {
                            setDenyId(p.id);
                            setDenyReason("");
                          }}
                          disabled={pending}
                          className="px-3 py-1.5 bg-paper text-ink font-anton text-[11px] uppercase tracking-wider border-2 border-ink hover:bg-ink hover:text-paper disabled:opacity-50"
                        >
                          Negar
                        </button>
                      </div>
                    )}
                    {p.status === "denied" && (
                      <button
                        onClick={() => handleApprove(p.id)}
                        disabled={pending}
                        className="px-3 py-1.5 bg-paper text-green font-anton text-[11px] uppercase tracking-wider border-2 border-green hover:bg-green hover:text-paper disabled:opacity-50"
                      >
                        Reaprovar
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal "negar" */}
      {denyId && (
        <div
          className="fixed inset-0 bg-ink/60 z-50 grid place-items-center p-4"
          onClick={() => !pending && setDenyId(null)}
        >
          <div
            className="bg-paper border-2 border-ink max-w-md w-full"
            style={{ boxShadow: "8px 8px 0 #002776" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b-2 border-ink flex items-center justify-between">
              <h3 className="font-anton text-lg uppercase tracking-wider text-ink">
                Negar pagamento
              </h3>
              <button
                onClick={() => !pending && setDenyId(null)}
                className="w-8 h-8 grid place-items-center text-soft hover:text-ink"
              >
                ✕
              </button>
            </div>
            <div className="p-5 space-y-3">
              <label className="block font-mono text-[11px] uppercase tracking-widest text-mute">
                Motivo (vai aparecer pro usuário)
              </label>
              <textarea
                value={denyReason}
                onChange={(e) => setDenyReason(e.target.value)}
                rows={3}
                placeholder="Ex: não localizei o Pix com o valor de R$50."
                className="w-full p-3 border border-rule font-mono text-sm focus:outline-none focus:border-ink"
              />
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => !pending && setDenyId(null)}
                  className="px-4 py-2 border border-rule text-soft font-mono text-[11px] uppercase tracking-widest hover:border-ink hover:text-ink"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => handleDeny(denyId, denyReason)}
                  disabled={pending || !denyReason.trim()}
                  className="px-4 py-2 bg-ink text-paper font-anton text-[11px] uppercase tracking-wider border-2 border-ink disabled:opacity-50"
                >
                  {pending ? "Negando..." : "Confirmar negação"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({
  status,
  reason,
}: {
  status: "pending" | "approved" | "denied";
  reason: string | null;
}) {
  if (status === "approved") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-green text-paper font-mono text-[10px] uppercase tracking-widest">
        ✓ Aprovado
      </span>
    );
  }
  if (status === "denied") {
    return (
      <div>
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-ink text-paper font-mono text-[10px] uppercase tracking-widest">
          ✕ Negado
        </span>
        {reason && (
          <div className="font-serif italic text-[11px] text-mute mt-1">{reason}</div>
        )}
      </div>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-yellow text-ink font-mono text-[10px] uppercase tracking-widest">
      ⏳ Pendente
    </span>
  );
}

// ============================================================
// RESULTADOS
// ============================================================

function ResultsTab({
  matches,
  groups,
  groupFilter,
  setGroupFilter,
  onToast,
}: {
  matches: EnrichedMatch[];
  groups: Group[];
  groupFilter: string;
  setGroupFilter: (v: string) => void;
  onToast: (msg: string) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-6 flex-wrap gap-4">
        <div>
          <h1 className="font-anton text-4xl uppercase tracking-tight text-ink">
            <span className="text-yellow">►</span> Resultados oficiais
          </h1>
          <p className="font-serif italic text-soft mt-1 text-sm">
            Insira o placar final · trigger no banco recalcula pontos automaticamente.
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <button
            onClick={() => setGroupFilter("all")}
            className={[
              "px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest border",
              groupFilter === "all"
                ? "bg-ink text-paper border-ink"
                : "bg-paper text-soft border-rule hover:border-ink",
            ].join(" ")}
          >
            Todos
          </button>
          {groups.map((g) => (
            <button
              key={g.id}
              onClick={() => setGroupFilter(g.code)}
              className={[
                "px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest border",
                groupFilter === g.code
                  ? "bg-ink text-paper border-ink"
                  : "bg-paper text-soft border-rule hover:border-ink",
              ].join(" ")}
            >
              {g.code}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        {matches.map((m) => (
          <ResultRow key={m.id} match={m} onToast={onToast} />
        ))}
      </div>
    </div>
  );
}

function ResultRow({
  match,
  onToast,
}: {
  match: EnrichedMatch;
  onToast: (msg: string) => void;
}) {
  const [home, setHome] = useState<string>(
    match.home_score === null ? "" : String(match.home_score),
  );
  const [away, setAway] = useState<string>(
    match.away_score === null ? "" : String(match.away_score),
  );
  const [pending, startTransition] = useTransition();

  const finalized = match.status === "finished";

  function save() {
    const h = parseInt(home, 10);
    const a = parseInt(away, 10);
    if (Number.isNaN(h) || Number.isNaN(a) || h < 0 || a < 0 || h > 99 || a > 99) {
      onToast("Placar inválido");
      return;
    }
    startTransition(async () => {
      const res = await setMatchResult({
        match_id: match.id,
        home_score: h,
        away_score: a,
      });
      onToast(res.ok ? `Placar salvo · pontos recalculados` : res.error);
    });
  }

  function clear() {
    startTransition(async () => {
      const res = await clearMatchResult({ match_id: match.id });
      if (res.ok) {
        setHome("");
        setAway("");
        onToast("Placar removido");
      } else {
        onToast(res.error);
      }
    });
  }

  return (
    <div
      className={[
        "border bg-paper p-4",
        finalized ? "border-green/40" : "border-rule hover:border-ink",
      ].join(" ")}
    >
      <div className="flex items-center justify-between mb-3 font-mono text-[10px] uppercase tracking-widest text-mute">
        <span>
          {new Date(match.kickoff_at).toLocaleString("pt-BR", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })}
          {match.stadium ? ` · ${match.stadium}` : ""}
        </span>
        {finalized && <span className="text-green">✓ finalizado</span>}
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-3">
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
            disabled={pending}
            onChange={(e) => setHome(e.target.value.replace(/\D/g, "").slice(0, 2))}
            onFocus={(e) => e.currentTarget.select()}
            placeholder="–"
            className="w-12 h-12 text-center font-anton text-2xl border-2 border-rule bg-paper outline-none focus:border-ink focus:bg-yellow/20 disabled:opacity-50"
          />
          <span className="font-anton text-xl text-mute">×</span>
          <input
            type="text"
            inputMode="numeric"
            value={away}
            disabled={pending}
            onChange={(e) => setAway(e.target.value.replace(/\D/g, "").slice(0, 2))}
            onFocus={(e) => e.currentTarget.select()}
            placeholder="–"
            className="w-12 h-12 text-center font-anton text-2xl border-2 border-rule bg-paper outline-none focus:border-ink focus:bg-yellow/20 disabled:opacity-50"
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
        <div className="flex gap-2">
          <button
            onClick={save}
            disabled={pending || home === "" || away === ""}
            className="px-3 py-2 bg-green text-paper font-anton text-[11px] uppercase tracking-wider border-2 border-green hover:bg-green2 disabled:opacity-50"
          >
            Salvar
          </button>
          {finalized && (
            <button
              onClick={clear}
              disabled={pending}
              className="px-3 py-2 bg-paper text-ink font-anton text-[11px] uppercase tracking-wider border-2 border-ink hover:bg-ink hover:text-paper disabled:opacity-50"
            >
              Limpar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// COMUNICAÇÃO (disparos em massa)
// ============================================================

function ComunicacaoTab({
  approvedCount,
  onToast,
}: {
  approvedCount: number;
  onToast: (msg: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState<null | "pdf" | "czech" | "countdown">(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [testing, startTestTransition] = useTransition();

  function runTest() {
    startTestTransition(async () => {
      const res = await sendAdminTestEmail();
      if (res.ok) {
        onToast(`✅ ${res.detail} Confira sua caixa (e o spam).`);
      } else {
        onToast(`❌ ${res.error}`);
      }
    });
  }

  function run(kind: "pdf" | "czech" | "countdown") {
    startTransition(async () => {
      const res =
        kind === "pdf"
          ? await resendApprovedPdfs()
          : kind === "czech"
            ? await notifyCzechFix()
            : await notifyCountdown();
      setConfirm(null);
      if (!res.ok) {
        onToast(res.error);
        return;
      }
      const msg =
        `${res.sent} enviado(s)` +
        (res.failed ? ` · ${res.failed} falha(s)` : "") +
        ` de ${res.total}`;
      setLastResult(msg);
      onToast(`Concluído — ${msg}`);
    });
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-anton text-4xl uppercase tracking-tight text-ink">
          <span className="text-yellow">►</span> Comunicação
        </h1>
        <p className="font-serif italic text-soft mt-1 text-sm">
          Disparos de email em massa. Cada clique envia de verdade — confirme antes.
        </p>
      </div>

      {lastResult && (
        <div className="mb-6 border-l-4 border-green bg-green/10 px-4 py-3 font-mono text-[12px] uppercase tracking-widest text-ink">
          Último disparo: {lastResult}
        </div>
      )}

      {/* Teste de transporte — envia só pro admin, sem PDF nem role */}
      <div className="mb-4 border-2 border-yellow bg-yellow/10 p-5 flex flex-col md:flex-row md:items-center gap-4">
        <div className="flex-1">
          <div className="font-anton text-xl uppercase tracking-tight text-ink mb-1">
            Testar envio (só pra mim)
          </div>
          <p className="font-serif italic text-sm text-soft">
            Dispara um email de teste apenas pra <b>você</b> (admin). Não envia pra
            ninguém mais, não usa PDF nem depende de aprovação — serve só pra confirmar
            que o Gmail está funcionando. A própria tela avisa se deu certo ou o motivo da falha.
          </p>
        </div>
        <button
          onClick={runTest}
          disabled={testing}
          className="px-4 py-2.5 bg-ink text-paper font-anton text-[12px] uppercase tracking-wider border-2 border-ink hover:bg-yellow hover:text-ink hover:border-yellow disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
        >
          {testing ? "Enviando..." : "Enviar teste pra mim"}
        </button>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {/* Contagem regressiva + palpites */}
        <div className="border-2 border-green p-5 flex flex-col">
          <div className="font-anton text-xl uppercase tracking-tight text-ink mb-1">
            Contagem regressiva pra estreia
          </div>
          <p className="font-serif italic text-sm text-soft flex-1">
            Envia pra todos os aprovados o email de hype da estreia (&quot;faltam X
            dias&quot;, calculado automático) com o PDF dos palpites em anexo e &quot;boa
            sorte&quot;.
          </p>
          <div className="font-mono text-[11px] uppercase tracking-widest text-mute my-3">
            Destinatários: <b className="text-ink">{approvedCount}</b> aprovado(s)
          </div>
          <button
            onClick={() => setConfirm("countdown")}
            disabled={pending || approvedCount === 0}
            className="px-4 py-2.5 bg-green text-paper font-anton text-[12px] uppercase tracking-wider border-2 border-green hover:bg-green2 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {pending ? "Processando..." : "Enviar contagem regressiva"}
          </button>
        </div>

        {/* Reenviar PDFs */}
        <div className="border-2 border-ink p-5 flex flex-col">
          <div className="font-anton text-xl uppercase tracking-tight text-ink mb-1">
            Reenviar PDF aos aprovados
          </div>
          <p className="font-serif italic text-sm text-soft flex-1">
            Reenvia o PDF de confirmação para todos os apostadores com pagamento
            aprovado. Use pra cobrir quem não recebeu o email de confirmação.
          </p>
          <div className="font-mono text-[11px] uppercase tracking-widest text-mute my-3">
            Destinatários: <b className="text-ink">{approvedCount}</b> aprovado(s)
          </div>
          <button
            onClick={() => setConfirm("pdf")}
            disabled={pending || approvedCount === 0}
            className="px-4 py-2.5 bg-ink text-paper font-anton text-[12px] uppercase tracking-wider border-2 border-ink hover:bg-green hover:border-green disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {pending ? "Processando..." : "Reenviar PDFs"}
          </button>
        </div>

        {/* Aviso Dinamarca/Tcheca */}
        <div className="border-2 border-ink p-5 flex flex-col">
          <div className="font-anton text-xl uppercase tracking-tight text-ink mb-1">
            Avisar sobre ajuste do Grupo A
          </div>
          <p className="font-serif italic text-sm text-soft flex-1">
            Envia o email da correção (Dinamarca → República Tcheca) com o link
            pra revisar o placar, para todos que têm palpite nos jogos reabertos.
          </p>
          <div className="font-mono text-[11px] uppercase tracking-widest text-mute my-3">
            Destinatários: quem palpitou nos jogos reabertos
          </div>
          <button
            onClick={() => setConfirm("czech")}
            disabled={pending}
            className="px-4 py-2.5 bg-ink text-paper font-anton text-[12px] uppercase tracking-wider border-2 border-ink hover:bg-green hover:border-green disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {pending ? "Processando..." : "Enviar aviso"}
          </button>
        </div>
      </div>

      {confirm && (
        <div
          className="fixed inset-0 bg-ink/60 z-50 grid place-items-center p-4"
          onClick={() => !pending && setConfirm(null)}
        >
          <div
            className="bg-paper border-2 border-ink max-w-md w-full"
            style={{ boxShadow: "8px 8px 0 #002776" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b-2 border-ink">
              <h3 className="font-anton text-lg uppercase tracking-wider text-ink">
                Confirmar disparo
              </h3>
            </div>
            <div className="p-5">
              <p className="font-serif text-sm text-ink mb-4">
                {confirm === "pdf"
                  ? `Reenviar o PDF de confirmação para ${approvedCount} apostador(es) aprovado(s)? Eles vão receber o email novamente.`
                  : confirm === "countdown"
                    ? `Enviar o email de contagem regressiva pra estreia, com o PDF dos palpites em anexo, para ${approvedCount} apostador(es) aprovado(s)?`
                    : "Enviar o aviso de correção do Grupo A para todos que têm palpite nos jogos reabertos? Cada pessoa recebe um email."}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => !pending && setConfirm(null)}
                  className="px-4 py-2 border border-rule text-soft font-mono text-[11px] uppercase tracking-widest hover:border-ink hover:text-ink"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => run(confirm)}
                  disabled={pending}
                  className="px-4 py-2 bg-green text-paper font-anton text-[11px] uppercase tracking-wider border-2 border-green disabled:opacity-50"
                >
                  {pending ? "Enviando..." : "Confirmar e enviar"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
