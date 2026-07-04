"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  ChampionCandidate,
  ChampionPick,
  KoMatchView,
  KoRankingRow,
} from "@/lib/types";
import { upsertChampion, upsertKoPrediction } from "./actions";
import { submitKoPayment } from "./payment-actions";
import PushBell from "@/components/PushBell";

// Trava de tempo da fase 2: 1h antes do apito (no cliente, só pra UI; o
// servidor revalida).
const KO_CUTOFF_MS = 60 * 60 * 1000;

const STAGES: { key: string; label: string }[] = [
  { key: "LAST_32", label: "16 avos de final" },
  { key: "LAST_16", label: "Oitavas de final" },
  { key: "QUARTER_FINALS", label: "Quartas de final" },
  { key: "SEMI_FINALS", label: "Semifinais" },
  { key: "THIRD_PLACE", label: "Disputa de 3º lugar" },
  { key: "FINAL", label: "Final" },
];

const TABS = [
  { key: "apostas", label: "Minhas apostas" },
  { key: "ranking", label: "Ranking" },
  { key: "resultado", label: "Resultados" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const flagUrl = (iso: string, w = 80) => `https://flagcdn.com/w${w}/${iso}.png`;

function parseScore(v: string): number | null {
  if (v === "") return null;
  const n = parseInt(v, 10);
  if (Number.isNaN(n) || n < 0 || n > 99) return null;
  return n;
}

function fmtKickoff(iso: string | null) {
  if (!iso) return "a definir";
  return new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type Draft = {
  rh: string; // tempo normal 90 min (oitavas+)
  ra: string;
  h: string; // 16avos: normal+prorrog · oitavas+: placar pós-prorrogação
  a: string;
  ph: string;
  pa: string;
  saving?: boolean;
  error?: string | null;
};
type DraftMap = Record<string, Draft>;

// A partir das oitavas o jogo tem 3 camadas (tempo normal + prorrogação + pênaltis).
// Os 16avos (LAST_32) seguem no modelo de 2 camadas.
const isNewModel = (stage: string) => stage !== "LAST_32";

type Props = {
  user: { email: string; name: string };
  currentUserId: string;
  matches: KoMatchView[];
  paymentStatus: "pending" | "approved" | "denied" | null;
  rankings: KoRankingRow[];
  champion: ChampionPick;
  championLockAt: string | null;
  candidates: ChampionCandidate[];
  isAdmin: boolean;
  championByUser: Record<string, { iso: string; name: string }>;
};

export default function CopaClient({
  user,
  currentUserId,
  matches,
  paymentStatus,
  rankings,
  champion,
  championLockAt,
  candidates,
  isAdmin,
  championByUser,
}: Props) {
  const router = useRouter();
  // Login cai no Mata-mata; primeira tela = Ranking.
  const [tab, setTab] = useState<TabKey>("ranking");
  const [now, setNow] = useState(() => Date.now());
  const [toast, setToast] = useState<string | null>(null);

  const [drafts, setDrafts] = useState<DraftMap>(() => {
    const init: DraftMap = {};
    for (const m of matches) {
      if (m.prediction) {
        init[m.id] = {
          rh: m.prediction.reg_home != null ? String(m.prediction.reg_home) : "",
          ra: m.prediction.reg_away != null ? String(m.prediction.reg_away) : "",
          h: String(m.prediction.home_score),
          a: String(m.prediction.away_score),
          ph: String(m.prediction.pen_home),
          pa: String(m.prediction.pen_away),
        };
      }
    }
    return init;
  });

  // Tick por minuto pra reavaliar travas/contagens.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Ao vivo: recarrega do servidor a cada 30s nas abas ranking e resultados.
  useEffect(() => {
    if (tab !== "ranking" && tab !== "resultado") return;
    const id = setInterval(() => router.refresh(), 30_000);
    return () => clearInterval(id);
  }, [tab, router]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(id);
  }, [toast]);

  // ===== Persistência (debounce por jogo) =====
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => {
    const t = timers.current;
    return () => Object.values(t).forEach((id) => clearTimeout(id));
  }, []);

  const matchById = useMemo(() => new Map(matches.map((m) => [m.id, m])), [matches]);

  const persist = useCallback(
    (matchId: string, d: Draft, newModel: boolean) => {
      if (timers.current[matchId]) clearTimeout(timers.current[matchId]);
      timers.current[matchId] = setTimeout(async () => {
        const h = parseScore(d.h);
        const a = parseScore(d.a);
        const ph = parseScore(d.ph);
        const pa = parseScore(d.pa);
        // Pênalti é obrigatório ("seguro"). Oitavas+ exigem também o tempo normal.
        if (h === null || a === null || ph === null || pa === null) return;
        let reg: { reg_home?: number; reg_away?: number } = {};
        if (newModel) {
          const rh = parseScore(d.rh);
          const ra = parseScore(d.ra);
          if (rh === null || ra === null) return; // espera os 3 placares
          reg = { reg_home: rh, reg_away: ra };
        }

        setDrafts((prev) => ({ ...prev, [matchId]: { ...prev[matchId], saving: true, error: null } }));
        try {
          const res = await upsertKoPrediction({
            ko_match_id: matchId,
            home_score: h,
            away_score: a,
            ...reg,
            pen_home: ph,
            pen_away: pa,
          });
          if (!res.ok) throw new Error(res.error);
          setDrafts((prev) => ({ ...prev, [matchId]: { ...prev[matchId], saving: false, error: null } }));
          setToast("Palpite salvo");
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Erro ao salvar";
          setDrafts((prev) => ({ ...prev, [matchId]: { ...prev[matchId], saving: false, error: msg } }));
          setToast(msg);
        }
      }, 600);
    },
    [],
  );

  function updateField(matchId: string, field: "rh" | "ra" | "h" | "a" | "ph" | "pa", raw: string) {
    const cleaned = raw.replace(/\D/g, "").slice(0, 2);
    const cur = drafts[matchId] ?? { rh: "", ra: "", h: "", a: "", ph: "", pa: "" };
    const next = { ...cur, [field]: cleaned };
    setDrafts((prev) => ({ ...prev, [matchId]: { ...(prev[matchId] ?? cur), [field]: cleaned } }));
    const newModel = isNewModel(matchById.get(matchId)?.stage ?? "");
    persist(matchId, next, newModel);
  }

  // ===== Campeão =====
  const championLocked = !!championLockAt && now >= new Date(championLockAt).getTime();
  const [champSaving, setChampSaving] = useState(false);
  const [champIso, setChampIso] = useState(champion?.team_iso ?? "");

  async function pickChampion(iso: string) {
    const cand = candidates.find((c) => c.iso === iso);
    if (!cand) return;
    setChampIso(iso);
    setChampSaving(true);
    const res = await upsertChampion({ team_iso: cand.iso, team_name: cand.name });
    setChampSaving(false);
    setToast(res.ok ? `Campeão: ${cand.name}` : res.error);
    if (res.ok) router.refresh();
  }

  // ===== Contagens / agrupamento =====
  const byStage = useMemo(() => {
    const m = new Map<string, KoMatchView[]>();
    for (const mt of matches) {
      const arr = m.get(mt.stage) ?? [];
      arr.push(mt);
      m.set(mt.stage, arr);
    }
    return m;
  }, [matches]);

  function isOpen(m: KoMatchView) {
    if (!m.home_name || !m.away_name) return false; // confronto não definido
    if (!m.kickoff_at) return true;
    if (m.status !== "scheduled") return false;
    return new Date(m.kickoff_at).getTime() - now > KO_CUTOFF_MS;
  }
  function isFilled(m: KoMatchView) {
    const d = drafts[m.id];
    if (!d || d.error) return false;
    const base =
      parseScore(d.h) !== null &&
      parseScore(d.a) !== null &&
      parseScore(d.ph) !== null &&
      parseScore(d.pa) !== null;
    if (!base) return false;
    if (isNewModel(m.stage)) return parseScore(d.rh) !== null && parseScore(d.ra) !== null;
    return true;
  }

  const openMatches = matches.filter(isOpen);
  const openFilled = openMatches.filter(isFilled).length;

  // ===== PIX =====
  const [showPix, setShowPix] = useState(false);
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [submittingPix, setSubmittingPix] = useState(false);
  const [pixError, setPixError] = useState<string | null>(null);
  const sealed = paymentStatus === "pending" || paymentStatus === "approved";

  const noKo = matches.length === 0;

  return (
    <div className="min-h-screen flex flex-col bg-paper">
      {/* TOP BAR */}
      <header className="bg-ink text-paper border-b-4 border-yellow flex-shrink-0">
        <div className="max-w-[1280px] mx-auto px-8 h-14 grid grid-cols-[auto_1fr_auto] items-center gap-6">
          <div className="flex items-center gap-2 font-anton uppercase tracking-wider text-base">
            <span className="w-2 h-2 bg-yellow rounded-full animate-pulse" />
            Mata-mata · Copa 26
          </div>
          <div className="hidden md:block text-center font-mono text-[11px] uppercase tracking-widest text-paper/70">
            bolaocopa26.com <span className="opacity-40 mx-1.5">/</span>
            <span className="text-yellow">mata-mata</span>
          </div>
          <div className="flex items-center gap-3 justify-end">
            <PushBell onToast={setToast} />
            {isAdmin && (
              <Link
                href="/admin/mata-mata"
                className="font-mono text-[10px] uppercase tracking-widest text-yellow hover:underline"
              >
                admin
              </Link>
            )}
            <span className="hidden sm:block font-mono text-[11px] uppercase tracking-widest text-yellow">
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
                tab === t.key ? "text-yellow border-yellow" : "text-soft border-transparent hover:text-ink",
              ].join(" ")}
            >
              {t.label}
              {t.key === "apostas" && openMatches.length > 0 && (
                <span
                  className={[
                    "font-mono text-[9px] px-[7px] py-[2px] tracking-wider",
                    tab === "apostas" ? "bg-yellow text-ink" : "bg-paper3 text-ink",
                  ].join(" ")}
                >
                  {openFilled}/{openMatches.length}
                </span>
              )}
            </button>
          ))}
          <a
            href="/"
            className="px-[18px] py-[14px] font-anton text-[13px] uppercase tracking-wider whitespace-nowrap border-b-[3px] -mb-px text-soft border-transparent hover:text-ink transition-colors"
          >
            ‹ Início
          </a>
        </div>
      </nav>

      <main className="flex-1 pb-32">
        {tab === "apostas" && (
          <div className="max-w-[1080px] mx-auto px-8 py-8">
            {/* STATUS DA ENTRADA */}
            {sealed && (
              <div
                className={[
                  "border-l-4 px-5 py-4 mb-6 flex items-center gap-3",
                  paymentStatus === "approved" ? "border-green bg-green/10" : "border-yellow bg-yellow/10",
                ].join(" ")}
              >
                <span className="font-anton text-2xl">{paymentStatus === "approved" ? "✓" : "⏳"}</span>
                <div>
                  <div className="font-anton uppercase tracking-wider text-sm text-ink">
                    {paymentStatus === "approved" ? "Entrada confirmada" : "Pix enviado · aguardando aprovação"}
                  </div>
                  <div className="font-serif italic text-xs text-soft mt-0.5">
                    {paymentStatus === "approved"
                      ? "Você está no ranking do mata-mata. Palpite cada rodada e o campeão."
                      : "Pode palpitar normalmente — você entra no ranking assim que o admin aprovar."}
                  </div>
                </div>
              </div>
            )}

            {/* PALPITE DE CAMPEÃO */}
            <section className="border-2 border-ink mb-8">
              <div className="flex items-center justify-between px-5 py-3 border-b-2 border-ink bg-ink text-paper">
                <h2 className="font-anton text-lg uppercase tracking-wider">🏆 Campeão · +5 pts</h2>
                <span className="font-mono text-[10px] uppercase tracking-widest text-yellow">
                  {championLocked ? "fechado" : championLockAt ? `fecha ${fmtKickoff(championLockAt)}` : "prazo a definir"}
                </span>
              </div>
              <div className="p-5">
                {candidates.length === 0 ? (
                  <p className="font-serif italic text-sm text-soft">
                    Os classificados aparecem aqui quando a fase de grupos terminar. Volte pra
                    cravar o campeão antes do 1º jogo dos 16avos.
                  </p>
                ) : championLocked ? (
                  <p className="font-anton uppercase tracking-wide text-ink">
                    Seu campeão:{" "}
                    <span className="text-green">{champion?.team_name ?? "não escolhido"}</span>
                    {champion?.computed_at != null && (
                      <span className="ml-2 font-mono text-xs text-mute">
                        ({champion.points > 0 ? "✓ +5 acertou!" : "não foi dessa vez"})
                      </span>
                    )}
                  </p>
                ) : (
                  <>
                    <p className="font-serif italic text-xs text-soft mb-3">
                      Escolha quem você acha que levanta a taça. Dá pra trocar até o mata-mata começar.
                    </p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                      {candidates.map((c) => {
                        const active = champIso === c.iso;
                        return (
                          <button
                            key={c.iso}
                            disabled={champSaving}
                            onClick={() => pickChampion(c.iso)}
                            className={[
                              "flex items-center gap-2 px-3 py-2 border-2 font-anton text-sm uppercase tracking-wide transition-colors disabled:opacity-50",
                              active
                                ? "border-green bg-green/10 text-green"
                                : "border-rule bg-paper text-ink hover:border-ink",
                            ].join(" ")}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={flagUrl(c.iso, 40)} alt="" className="w-5 h-auto border border-rule" />
                            <span className="truncate">{c.name}</span>
                            {active && <span className="ml-auto">✓</span>}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </section>

            {/* JOGOS POR FASE */}
            {noKo && (
              <div className="border-2 border-dashed border-rule p-8 text-center font-serif italic text-soft">
                Os confrontos do mata-mata aparecem aqui assim que a FIFA definir os classificados
                (fim da fase de grupos). Atualiza sozinho.
              </div>
            )}

            <div className="space-y-10">
              {STAGES.map(({ key, label }) => {
                const list = byStage.get(key) ?? [];
                if (list.length === 0) return null;
                return (
                  <section key={key}>
                    <h3 className="font-anton text-xl uppercase tracking-tight text-yellow mb-3">{label}</h3>
                    <div className="space-y-3">
                      {list.map((m) => (
                        <KoMatchRow
                          key={m.id}
                          match={m}
                          draft={drafts[m.id]}
                          now={now}
                          onChange={updateField}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        )}

        {tab === "resultado" && <KoResultadoTab matches={matches} />}
        {tab === "ranking" && (
          <KoRankingTab rankings={rankings} currentUserId={currentUserId} championByUser={championByUser} />
        )}
      </main>

      {/* FOOTER CTA */}
      {!sealed && (
        <footer className="fixed bottom-0 left-0 right-0 bg-ink text-paper border-t-4 border-yellow z-30">
          <div className="max-w-[1080px] mx-auto px-8 py-3 flex items-center gap-4">
            <div className="flex-1 font-mono text-[11px] uppercase tracking-widest text-paper/80">
              Entre no mata-mata · aposta independente da fase de grupos
            </div>
            <button
              onClick={() => setShowPix(true)}
              className="px-4 py-2.5 bg-yellow text-ink font-anton text-[13px] uppercase tracking-wider border-2 border-yellow hover:bg-yellow/90"
            >
              Entrar · R$ 50
            </button>
          </div>
        </footer>
      )}

      {showPix && (
        <KoPixModal
          receiptFile={receiptFile}
          setReceiptFile={setReceiptFile}
          submitting={submittingPix}
          error={pixError}
          onClose={() => {
            if (submittingPix) return;
            setShowPix(false);
            setPixError(null);
          }}
          onCopy={() => setToast("Chave Pix copiada")}
          onConfirm={async () => {
            if (!receiptFile) return;
            setSubmittingPix(true);
            setPixError(null);
            try {
              const fd = new FormData();
              fd.append("receipt", receiptFile);
              const res = await submitKoPayment(fd);
              if (res.ok) {
                setShowPix(false);
                setReceiptFile(null);
                setToast("Pagamento enviado · aguardando aprovação");
                router.refresh();
              } else {
                setPixError(res.error);
              }
            } catch (e) {
              console.error("[ko-pix] submit falhou", e);
              setPixError(
                "O envio falhou no caminho — pode ser o tamanho do comprovante ou a conexão. Tente um arquivo menor (print resolve) ou tente de novo.",
              );
            } finally {
              setSubmittingPix(false);
            }
          }}
        />
      )}

      {toast && (
        <div
          className="fixed left-1/2 -translate-x-1/2 bottom-24 bg-ink text-paper border-l-4 border-yellow px-5 py-3 font-anton text-[13px] uppercase tracking-wider z-40"
          style={{ boxShadow: "4px 4px 0 #FFDF00" }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

function ScoreBox({
  value,
  filled,
  locked,
  onChange,
}: {
  value: string;
  filled: boolean;
  locked: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <input
      type="text"
      inputMode="numeric"
      value={value}
      disabled={locked}
      placeholder="–"
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      className={[
        "w-11 h-11 text-center font-anton text-xl border-2 outline-none transition-colors",
        filled ? "border-green text-ink bg-paper" : "border-rule text-mute bg-paper",
        "focus:border-ink focus:bg-yellow/20",
        locked ? "opacity-60 cursor-not-allowed" : "",
      ].join(" ")}
    />
  );
}

// Linha rotulada com um par de placares (esquerda × direita) + dica à direita.
function ScoreLine({
  label,
  hint,
  left,
  right,
  leftFilled,
  rightFilled,
  locked,
  onLeft,
  onRight,
}: {
  label: ReactNode;
  hint: ReactNode;
  left: string;
  right: string;
  leftFilled: boolean;
  rightFilled: boolean;
  locked: boolean;
  onLeft: (v: string) => void;
  onRight: (v: string) => void;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
      <div className="text-right font-mono text-[10px] uppercase tracking-widest text-mute pr-1">{label}</div>
      <div className="flex items-center gap-2">
        <ScoreBox value={left} filled={leftFilled} locked={locked} onChange={onLeft} />
        <span className="font-anton text-xl text-mute">×</span>
        <ScoreBox value={right} filled={rightFilled} locked={locked} onChange={onRight} />
      </div>
      <div className="font-serif italic text-[11px] text-soft pl-1">{hint}</div>
    </div>
  );
}

function KoMatchRow({
  match,
  draft,
  now,
  onChange,
}: {
  match: KoMatchView;
  draft: Draft | undefined;
  now: number;
  onChange: (matchId: string, field: "rh" | "ra" | "h" | "a" | "ph" | "pa", val: string) => void;
}) {
  const undefinedMatch = !match.home_name || !match.away_name;
  const played = match.home_score !== null && match.away_score !== null;
  const hadPens = match.pen_home !== null && match.pen_away !== null;
  const newModel = isNewModel(match.stage);

  const timeLocked =
    !undefinedMatch &&
    !!match.kickoff_at &&
    (match.status !== "scheduled" || new Date(match.kickoff_at).getTime() - now <= KO_CUTOFF_MS);
  const locked = undefinedMatch || timeLocked;

  const rh = draft?.rh ?? "";
  const ra = draft?.ra ?? "";
  const h = draft?.h ?? "";
  const a = draft?.a ?? "";
  const ph = draft?.ph ?? "";
  const pa = draft?.pa ?? "";
  const baseComplete =
    parseScore(h) !== null && parseScore(a) !== null && parseScore(ph) !== null && parseScore(pa) !== null;
  const complete = baseComplete && (!newModel || (parseScore(rh) !== null && parseScore(ra) !== null));

  const pts = match.prediction?.computed_at != null ? match.prediction.points : null;

  const status = undefinedMatch ? (
    <span className="font-mono text-[10px] uppercase tracking-widest text-mute">confronto a definir</span>
  ) : pts != null ? (
    <span
      className={[
        "font-anton text-[11px] px-2 py-0.5 uppercase tracking-wider",
        pts >= 3 ? "bg-green text-paper" : pts >= 1 ? "bg-yellow text-ink" : "bg-paper2 text-mute",
      ].join(" ")}
    >
      +{pts} pt{pts !== 1 ? "s" : ""}
    </span>
  ) : timeLocked ? (
    <span className="font-mono text-[10px] uppercase tracking-widest text-red-600">apostas fechadas</span>
  ) : draft?.saving ? (
    <span className="font-mono text-[10px] uppercase tracking-widest text-mute">salvando…</span>
  ) : draft?.error ? (
    <span className="font-mono text-[10px] uppercase tracking-widest text-red-600">{draft.error}</span>
  ) : complete ? (
    <span className="font-mono text-[10px] uppercase tracking-widest text-green">palpite salvo</span>
  ) : (
    <span className="font-mono text-[10px] uppercase tracking-widest text-yellow-600">
      {newModel ? "preencha os 3 placares" : "preencha os 4 placares"}
    </span>
  );

  const homeName = match.home_name ?? "A definir";
  const awayName = match.away_name ?? "A definir";

  // Valores exibidos quando o jogo já tem resultado (inputs travados mostram o placar real).
  const regResult = newModel && played ? `${match.reg_home ?? match.home_score}` : null;
  const regResultAway = newModel && played ? `${match.reg_away ?? match.away_score}` : null;

  return (
    <div className="border border-rule bg-paper p-4 hover:border-ink transition-colors">
      <div className="flex items-center justify-between mb-3 font-mono text-[10px] uppercase tracking-widest text-mute">
        <span>{fmtKickoff(match.kickoff_at)}{match.status === "live" ? " · ● AO VIVO" : ""}</span>
        {status}
      </div>

      {/* Times */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          {match.home_iso && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={flagUrl(match.home_iso, 80)} alt="" className="w-9 h-6 object-cover border border-rule flex-shrink-0" />
          )}
          <span className="font-anton uppercase tracking-tight text-base truncate">{homeName}</span>
        </div>
        {/* Modelo antigo (16avos): placar inline na linha dos times. */}
        {!newModel ? (
          <div className="flex items-center gap-2">
            <ScoreBox
              value={played ? String(match.home_score) : h}
              filled={parseScore(h) !== null}
              locked={locked}
              onChange={(v) => onChange(match.id, "h", v)}
            />
            <span className="font-anton text-xl text-mute">×</span>
            <ScoreBox
              value={played ? String(match.away_score) : a}
              filled={parseScore(a) !== null}
              locked={locked}
              onChange={(v) => onChange(match.id, "a", v)}
            />
          </div>
        ) : (
          <span className="font-anton text-mute text-sm">×</span>
        )}
        <div className="flex items-center gap-2.5 justify-end min-w-0">
          <span className="font-anton uppercase tracking-tight text-base truncate text-right">{awayName}</span>
          {match.away_iso && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={flagUrl(match.away_iso, 80)} alt="" className="w-9 h-6 object-cover border border-rule flex-shrink-0" />
          )}
        </div>
      </div>

      {/* Oitavas em diante: 3 camadas (tempo normal + prorrogação + pênaltis). */}
      {newModel && (
        <div className="space-y-3 mb-3">
          <ScoreLine
            label="⏱ tempo normal"
            hint="placar dos 90 minutos"
            left={played ? (regResult ?? "") : rh}
            right={played ? (regResultAway ?? "") : ra}
            leftFilled={parseScore(rh) !== null}
            rightFilled={parseScore(ra) !== null}
            locked={locked}
            onLeft={(v) => onChange(match.id, "rh", v)}
            onRight={(v) => onChange(match.id, "ra", v)}
          />
          {played && !match.went_to_et ? (
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
              <div className="text-right font-mono text-[10px] uppercase tracking-widest text-mute pr-1">
                ⏱+ prorrogação
              </div>
              <div className="text-center font-serif italic text-[11px] text-soft">não houve</div>
              <div />
            </div>
          ) : (
            <ScoreLine
              label="⏱+ prorrogação"
              hint="placar TOTAL ao fim da prorrogação (já inclui os gols dos 90 min) · só conta se o jogo for à prorrogação"
              left={played ? String(match.home_score) : h}
              right={played ? String(match.away_score) : a}
              leftFilled={parseScore(h) !== null}
              rightFilled={parseScore(a) !== null}
              locked={locked}
              onLeft={(v) => onChange(match.id, "h", v)}
              onRight={(v) => onChange(match.id, "a", v)}
            />
          )}
        </div>
      )}

      {/* Pênaltis (obrigatório — "seguro") */}
      <div className={newModel ? "pt-3 border-t border-dashed border-rule" : "mt-3 pt-3 border-t border-dashed border-rule"}>
        <ScoreLine
          label="🥅 pênaltis"
          hint="só conta se o jogo for pra pênaltis"
          left={played && hadPens ? String(match.pen_home) : ph}
          right={played && hadPens ? String(match.pen_away) : pa}
          leftFilled={parseScore(ph) !== null}
          rightFilled={parseScore(pa) !== null}
          locked={locked}
          onLeft={(v) => onChange(match.id, "ph", v)}
          onRight={(v) => onChange(match.id, "pa", v)}
        />
      </div>
    </div>
  );
}

function KoResultadoTab({ matches }: { matches: KoMatchView[] }) {
  const [openMatchId, setOpenMatchId] = useState<string | null>(null);
  const openMatch = openMatchId ? matches.find((m) => m.id === openMatchId) ?? null : null;
  const playable = matches.filter((m) => m.home_name && m.away_name);
  const live = playable.filter((m) => m.status === "live");
  const finished = playable.filter(
    (m) => m.status === "finished" && m.home_score !== null && m.away_score !== null,
  );
  if (live.length === 0 && finished.length === 0) {
    return (
      <div className="max-w-[700px] mx-auto px-8 py-24 text-center">
        <h2 className="font-anton text-4xl uppercase tracking-tight text-ink mb-4">
          Mata-mata <span className="text-yellow">ainda não começou</span>
        </h2>
        <p className="font-serif italic text-soft leading-relaxed">
          Os resultados aparecem aqui conforme os jogos acontecem. As Oitavas começam dia 28/06 — atualiza sozinho.
        </p>
      </div>
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
          <span className="text-yellow">Resultados</span> · mata-mata
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-widest text-mute">
          {live.length > 0 && <b className="text-green mr-2">● {live.length} ao vivo</b>}
          {finished.length} {finished.length === 1 ? "jogo encerrado" : "jogos encerrados"}
        </span>
      </div>
      <div className="space-y-3">
        {list.map(({ m, isLive }) => {
          const hasPen = m.pen_home !== null && m.pen_away !== null;
          const newModel = isNewModel(m.stage);
          return (
            <div
              key={m.id}
              onClick={() => setOpenMatchId(m.id)}
              className="border border-rule bg-paper p-4 grid grid-cols-[1fr_auto_1fr] items-center gap-3 cursor-pointer hover:border-ink transition-colors"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                {m.home_iso && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={flagUrl(m.home_iso, 80)} alt="" className="w-9 h-6 object-cover border border-rule flex-shrink-0" />
                )}
                <span className="font-anton uppercase tracking-tight text-base truncate">{m.home_name}</span>
              </div>
              <div className="flex flex-col items-center gap-1">
                <div className="font-anton text-2xl text-ink">
                  {m.home_score ?? 0} <span className="text-mute text-base mx-1">×</span> {m.away_score ?? 0}
                </div>
                {newModel && m.went_to_et && m.reg_home !== null && (
                  <div className="font-mono text-[9px] uppercase tracking-widest text-mute">
                    90′ {m.reg_home} × {m.reg_away}
                  </div>
                )}
                {hasPen && (
                  <div className="font-mono text-[9px] uppercase tracking-widest text-mute">
                    pên {m.pen_home} × {m.pen_away}
                  </div>
                )}
                {isLive ? (
                  <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-widest text-green font-bold">
                    <span className="w-1.5 h-1.5 bg-green rounded-full animate-pulse" /> Ao vivo
                  </div>
                ) : (
                  <div className="font-mono text-[9px] uppercase tracking-widest text-mute">{fmtKickoff(m.kickoff_at)}</div>
                )}
              </div>
              <div className="flex items-center gap-2.5 justify-end min-w-0">
                <span className="font-anton uppercase tracking-tight text-base truncate text-right">{m.away_name}</span>
                {m.away_iso && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={flagUrl(m.away_iso, 80)} alt="" className="w-9 h-6 object-cover border border-rule flex-shrink-0" />
                )}
              </div>
              {m.prediction && (
                <div className="col-span-3 pt-3 mt-1 border-t border-rule flex items-center justify-between font-mono text-[11px] uppercase tracking-widest">
                  <span className="text-mute">
                    seu palpite{" "}
                    {newModel ? (
                      <b className="text-ink ml-1">
                        90′ {m.prediction.reg_home ?? "–"} × {m.prediction.reg_away ?? "–"}
                        <span className="font-normal text-mute">
                          {" "}· prorr {m.prediction.home_score} × {m.prediction.away_score}
                        </span>
                      </b>
                    ) : (
                      <b className="text-ink ml-1">
                        {m.prediction.home_score} × {m.prediction.away_score}
                      </b>
                    )}
                    {m.prediction.pen_home !== null && m.prediction.pen_away !== null
                      ? ` (pên ${m.prediction.pen_home}-${m.prediction.pen_away})`
                      : ""}
                  </span>
                  <span
                    className={[
                      "px-2 py-1 font-anton text-[10px]",
                      (m.prediction.points ?? 0) >= 3
                        ? "bg-green text-paper"
                        : (m.prediction.points ?? 0) >= 1
                          ? "bg-yellow text-ink"
                          : "bg-paper2 text-mute",
                    ].join(" ")}
                  >
                    +{m.prediction.points ?? 0} pts
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-4 font-serif italic text-xs text-soft">Toque num jogo para ver o palpite de todos.</p>
      <KoMatchPredictionsModal match={openMatch} onClose={() => setOpenMatchId(null)} />
    </div>
  );
}

type KoPredRow = {
  userId: string;
  name: string;
  avatar_url: string | null;
  home_score: number;
  away_score: number;
  reg_home: number | null;
  reg_away: number | null;
  pen_home: number | null;
  pen_away: number | null;
  normal_points: number;
  prorrog_points: number;
  pen_points: number;
  points: number;
  computed: boolean;
};

function KoMatchPredictionsModal({
  match,
  onClose,
}: {
  match: KoMatchView | null;
  onClose: () => void;
}) {
  const [preds, setPreds] = useState<KoPredRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!match) {
      setPreds(null);
      return;
    }
    setLoading(true);
    fetch(`/api/ko-match-predictions/${match.id}`)
      .then((r) => r.json())
      .then((d) => {
        setPreds(d.predictions ?? []);
        setLoading(false);
      })
      .catch(() => {
        setPreds([]);
        setLoading(false);
      });
  }, [match]);

  if (!match) return null;
  const hasScore = match.home_score !== null && match.away_score !== null;

  return (
    <div
      className="fixed inset-0 bg-ink/60 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-paper w-full sm:max-w-sm max-h-[80vh] overflow-y-auto border-t-4 sm:border-4 border-ink"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-rule flex items-center justify-between sticky top-0 bg-paper z-10">
          <div>
            <p className="font-anton uppercase text-base text-ink">Palpites do jogo</p>
            <p className="font-mono text-[10px] uppercase tracking-widest text-mute">
              {match.home_name} {hasScore ? `${match.home_score} × ${match.away_score}` : "×"} {match.away_name}
            </p>
          </div>
          <button type="button" className="font-anton text-xl text-mute hover:text-ink leading-none" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="divide-y divide-rule">
          {loading && <div className="p-6 text-center font-mono text-xs text-mute">carregando...</div>}
          {!loading && preds && preds.length === 0 && (
            <div className="p-6 text-center font-mono text-xs text-mute">ninguém palpitou nesse jogo 😅</div>
          )}
          {!loading &&
            preds &&
            preds.map((p, i) => {
              const pen =
                p.pen_home !== null && p.pen_away !== null ? ` (pên ${p.pen_home}-${p.pen_away})` : "";
              const newModel = isNewModel(match.stage);
              return (
                <div key={p.userId} className="px-4 py-2.5 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-anton text-xs text-mute w-5 text-right flex-shrink-0 tabular-nums">{i + 1}</span>
                    {p.avatar_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.avatar_url} alt="" className="w-6 h-6 rounded-full border border-rule object-cover flex-shrink-0" />
                    ) : (
                      <span className="w-6 h-6 rounded-full bg-paper2 border border-rule grid place-items-center font-mono text-[10px] text-mute flex-shrink-0">
                        {(p.name ?? "?").slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <span className="font-anton uppercase tracking-tight text-sm truncate">{p.name}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {newModel ? (
                      <span className="font-mono text-right whitespace-nowrap leading-tight">
                        <span className="text-sm">
                          {p.reg_home ?? "–"} × {p.reg_away ?? "–"}
                        </span>
                        <span className="block text-[10px] text-mute">
                          prorr {p.home_score} × {p.away_score}
                          {pen}
                        </span>
                      </span>
                    ) : (
                      <span className="font-mono text-sm whitespace-nowrap">
                        {p.home_score} × {p.away_score}
                        <span className="text-mute">{pen}</span>
                      </span>
                    )}
                    <span
                      className={[
                        "font-anton text-[10px] px-1.5 py-0.5 whitespace-nowrap",
                        !hasScore
                          ? "bg-paper2 text-mute"
                          : p.points >= 3
                            ? "bg-green text-paper"
                            : p.points >= 1
                              ? "bg-yellow text-ink"
                              : "bg-paper2 text-mute",
                      ].join(" ")}
                    >
                      {!hasScore ? "–" : `+${p.points}`}
                    </span>
                  </div>
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}

function KoRankingTab({
  rankings,
  currentUserId,
  championByUser,
}: {
  rankings: KoRankingRow[];
  currentUserId: string;
  championByUser: Record<string, { iso: string; name: string }>;
}) {
  if (rankings.length === 0) {
    return (
      <div className="max-w-[700px] mx-auto px-8 py-24 text-center">
        <h2 className="font-anton text-4xl uppercase tracking-tight text-ink mb-4">
          Ranking <span className="text-yellow">do mata-mata</span>
        </h2>
        <p className="font-serif italic text-soft leading-relaxed">
          O ranking aparece quando o primeiro jogo do mata-mata for pontuado. Só entradas com Pix
          aprovado disputam.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-[860px] mx-auto px-8 py-10">
      <div className="flex items-baseline justify-between mb-6">
        <h2 className="font-anton text-3xl uppercase tracking-tight text-ink">
          Ranking <span className="text-yellow">do mata-mata</span>
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-widest text-mute">
          {rankings.length} {rankings.length === 1 ? "participante" : "participantes"}
        </span>
      </div>

      <div className="border-2 border-ink">
        <table className="w-full border-collapse">
          <thead className="bg-ink text-paper">
            <tr>
              <th className="text-left font-mono text-[10px] uppercase tracking-widest py-2.5 px-3 w-12">#</th>
              <th className="text-left font-mono text-[10px] uppercase tracking-widest py-2.5 px-3">Jogador</th>
              <th className="hidden sm:table-cell text-left font-mono text-[10px] uppercase tracking-widest py-2.5 px-3">Campeão</th>
              <th className="hidden sm:table-cell text-right font-mono text-[10px] uppercase tracking-widest py-2.5 px-3 w-14">Exatos</th>
              <th className="text-right font-mono text-[10px] uppercase tracking-widest py-2.5 px-3 w-14">Pts</th>
            </tr>
          </thead>
          <tbody>
            {rankings.map((r) => {
              const isMe = r.user_id === currentUserId;
              return (
                <tr key={r.user_id} className={["border-b border-rule last:border-b-0", isMe ? "bg-yellow/10" : ""].join(" ")}>
                  <td className="py-3 px-3 font-anton text-base">
                    <span className={r.position <= 3 ? "text-yellow" : "text-mute"}>{r.position}º</span>
                  </td>
                  <td className="py-3 px-3">
                    <div className="flex items-center gap-2.5">
                      {r.avatar_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={r.avatar_url} alt="" className="w-6 h-6 rounded-full border border-rule object-cover" />
                      ) : (
                        <span className="w-6 h-6 rounded-full bg-paper2 border border-rule grid place-items-center font-mono text-[10px] text-mute">
                          {(r.name ?? "?").slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      {championByUser[r.user_id] && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={flagUrl(championByUser[r.user_id].iso, 20)}
                          alt={championByUser[r.user_id].name}
                          title={`Acha que ${championByUser[r.user_id].name} é campeã`}
                          className="w-5 h-3.5 object-cover border border-rule flex-shrink-0"
                        />
                      )}
                      <span className="font-anton uppercase tracking-tight text-sm text-ink">
                        <Link href={`/copa/${r.user_id}`} className="hover:text-yellow transition-colors">
                          {r.name ?? "Sem nome"}
                        </Link>
                        {isMe && <span className="ml-1.5 font-mono text-[9px] tracking-widest text-yellow">VOCÊ</span>}
                      </span>
                    </div>
                  </td>
                  <td className="hidden sm:table-cell py-3 px-3 font-mono text-xs text-soft">
                    {r.champion_pick ?? "—"}
                    {r.champion_points > 0 && <span className="ml-1 text-green">✓</span>}
                  </td>
                  <td className="hidden sm:table-cell py-3 px-3 text-right font-mono text-sm text-soft">{r.exact_hits}</td>
                  <td className="py-3 px-3 text-right font-anton text-lg text-ink">{r.total_points}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-4 font-serif italic text-xs text-soft">
        Tempo normal: <b className="text-green">+3</b> placar exato · <b className="text-green">+1</b> resultado.
        {" "}<b>Das oitavas em diante</b>, a prorrogação vale outros <b className="text-green">+3</b>/<b className="text-green">+1</b>
        {" "}(placar ao fim da prorrogação — só conta se o jogo for à prorrogação).
        {" "}Pênaltis (quando há): <b className="text-green">+3</b> exato · <b className="text-green">+1</b> vencedor.
        {" "}🏆 Acertar o campeão vale <b className="text-green">+5</b>.
      </p>
    </div>
  );
}

function KoPixModal({
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
    if (f && f.size > 5 * 1024 * 1024) {
      alert("Arquivo muito grande (máx 5MB).");
      e.target.value = "";
      setReceiptFile(null);
      return;
    }
    setReceiptFile(f);
  }

  return (
    <div className="fixed inset-0 bg-ink/60 z-50 grid place-items-center p-4" onClick={onClose}>
      <div
        className="bg-paper border-2 border-ink max-w-md w-full"
        style={{ boxShadow: "8px 8px 0 #FFDF00" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b-2 border-ink">
          <h3 className="font-anton text-lg uppercase tracking-wider text-ink">🏆 Entrar no mata-mata · Pix</h3>
          <button onClick={onClose} className="w-8 h-8 grid place-items-center text-soft hover:text-ink">✕</button>
        </div>
        <div className="p-6 text-center">
          <div className="font-anton text-5xl text-ink mb-1">R$ {amount},00</div>
          <div className="font-mono text-[11px] uppercase tracking-widest text-mute mb-6">
            entrada da fase 2 · independente da fase de grupos
          </div>

          <div className="text-left mb-4">
            <div className="font-mono text-[10px] uppercase tracking-widest text-mute mb-2">► 1. Pague o Pix</div>
            <button
              onClick={copy}
              className="w-full font-mono text-xs bg-paper2 px-4 py-3 border-2 border-dashed border-rule hover:bg-yellow/10 hover:border-yellow hover:text-ink transition-colors break-all"
            >
              {pixKey}
            </button>
            <div className="font-serif italic text-[11px] text-soft mt-1.5">Chave Pix CPF · clique para copiar</div>
          </div>

          <div className="text-left">
            <div className="font-mono text-[10px] uppercase tracking-widest text-mute mb-2">► 2. Anexe o comprovante</div>
            <label
              className={[
                "block p-4 border-2 border-dashed cursor-pointer transition-colors",
                receiptFile ? "border-green bg-green/5 text-green" : "border-rule bg-paper2 text-soft hover:border-ink hover:text-ink",
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
                {receiptFile ? "✓ " + (receiptFile.name.length > 32 ? receiptFile.name.slice(0, 31) + "…" : receiptFile.name) : "Selecionar arquivo"}
              </div>
              <div className="font-serif italic text-[11px] mt-1 opacity-80">PNG, JPG, WEBP ou PDF · até 5 MB</div>
            </label>
          </div>

          {error && (
            <div className="mt-4 text-left border-l-4 border-red-600 bg-red-50 px-4 py-3">
              <div className="font-anton text-[12px] uppercase tracking-wider text-red-700">Não foi possível enviar</div>
              <p className="font-serif text-[13px] text-ink mt-1">{error}</p>
            </div>
          )}

          <button
            onClick={onConfirm}
            disabled={!receiptFile || submitting}
            className="w-full mt-5 px-4 py-3.5 bg-yellow text-ink font-anton text-sm uppercase tracking-wider border-2 border-yellow disabled:bg-rule disabled:border-rule disabled:text-mute disabled:cursor-not-allowed"
          >
            {submitting ? "Enviando..." : "Confirmar pagamento"}
          </button>
        </div>
      </div>
    </div>
  );
}
