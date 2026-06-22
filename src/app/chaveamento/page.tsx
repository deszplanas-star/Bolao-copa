import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { computeStandings } from "@/lib/standings";
import type { MatchView, Team } from "@/lib/types";

export const dynamic = "force-dynamic";

type KoMatch = {
  id: string;
  stage: string;
  home_name: string | null;
  away_name: string | null;
  home_iso: string | null;
  away_iso: string | null;
  kickoff_at: string | null;
  home_score: number | null;
  away_score: number | null;
  pen_home: number | null;
  pen_away: number | null;
  status: string;
};

const STAGES: { key: string; label: string }[] = [
  { key: "LAST_32", label: "16 avos de final" },
  { key: "LAST_16", label: "Oitavas de final" },
  { key: "QUARTER_FINALS", label: "Quartas de final" },
  { key: "SEMI_FINALS", label: "Semifinais" },
  { key: "THIRD_PLACE", label: "Disputa de 3º lugar" },
  { key: "FINAL", label: "Final" },
];

const flagUrl = (iso: string) => `https://flagcdn.com/w40/${iso}.png`;

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

export default async function ChaveamentoPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/chaveamento");

  const [groupsRes, teamsRes, matchesRes, predsRes, koRes] = await Promise.all([
    supabase.from("groups").select("id, code").order("code"),
    supabase.from("teams").select("*"),
    supabase.from("matches").select("*"),
    supabase
      .from("predictions")
      .select("match_id, home_score, away_score")
      .eq("user_id", user.id),
    // Defensivo: antes da migration 0005 / do 1º ingest, pode não existir
    supabase.from("ko_matches").select("*").order("kickoff_at", { ascending: true }),
  ]);

  const groups = groupsRes.data ?? [];
  const teams = (teamsRes.data ?? []) as Team[];
  const matches = matchesRes.data ?? [];
  const preds = predsRes.data ?? [];
  const ko = (koRes.error ? [] : (koRes.data ?? [])) as KoMatch[];

  const predByMatch = new Map(preds.map((p) => [p.match_id as string, p]));

  // Classificação por grupo: usa o RESULTADO REAL quando o jogo já tem placar
  // oficial; nos jogos restantes, usa O PALPITE do usuário. Quando o grupo
  // termina de verdade, a projeção converge pro que realmente classificou.
  type GroupView = {
    code: string;
    rows: ReturnType<typeof computeStandings>;
    realCount: number;
    palpiteCount: number;
  };
  const groupViews: GroupView[] = [];
  const thirds: { code: string; row: ReturnType<typeof computeStandings>[number] }[] = [];

  for (const g of groups) {
    const gTeams = teams.filter((t) => t.group_id === g.id);
    const gMatches = matches.filter((m) => m.group_id === g.id);
    const drafts: Record<string, { home_score: number; away_score: number } | null> = {};
    let realCount = 0;
    let palpiteCount = 0;
    for (const m of gMatches) {
      const finished = m.home_score !== null && m.away_score !== null;
      const p = predByMatch.get(m.id as string);
      if (finished) {
        drafts[m.id as string] = {
          home_score: m.home_score as number,
          away_score: m.away_score as number,
        };
        realCount++;
      } else if (p) {
        drafts[m.id as string] = {
          home_score: p.home_score as number,
          away_score: p.away_score as number,
        };
        palpiteCount++;
      } else {
        drafts[m.id as string] = null;
      }
    }
    const rows = computeStandings(gTeams, gMatches as unknown as MatchView[], drafts);
    groupViews.push({ code: g.code as string, rows, realCount, palpiteCount });
    if (rows[2]) thirds.push({ code: g.code as string, row: rows[2] });
  }

  // 8 melhores terceiros (mesmo critério: pontos, saldo, gols pró)
  const bestThirds = new Set(
    thirds
      .sort(
        (a, b) =>
          b.row.p - a.row.p || b.row.sg - a.row.sg || b.row.gp - a.row.gp,
      )
      .slice(0, 8)
      .map((t) => t.code),
  );

  const byStage = new Map<string, KoMatch[]>();
  for (const m of ko) {
    const arr = byStage.get(m.stage) ?? [];
    arr.push(m);
    byStage.set(m.stage, arr);
  }

  const anyPalpite = preds.length > 0;

  return (
    <div className="min-h-screen bg-paper">
      <header className="bg-ink text-paper border-b-4 border-green">
        <div className="max-w-[1280px] mx-auto px-8 h-14 flex items-center">
          <div className="flex items-center gap-2 font-anton uppercase tracking-wider text-base">
            <span className="w-2 h-2 bg-green rounded-full animate-pulse" />
            Bolão do Planinhas
          </div>
        </div>
      </header>

      <nav className="bg-paper border-b border-rule sticky top-0 z-20 overflow-x-auto">
        <div className="max-w-[1280px] mx-auto px-8 flex">
          {[
            { href: "/apostas?tab=apostas", label: "Apostas" },
            { href: "/apostas?tab=ranking", label: "Ranking" },
            { href: "/apostas?tab=resultados", label: "Resultados" },
            { href: "/apostas?tab=minhas", label: "Minhas apostas" },
          ].map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className="flex-shrink-0 px-4 py-3 font-mono text-[11px] uppercase tracking-widest text-mute hover:text-ink border-b-2 border-transparent hover:border-ink transition-colors"
            >
              {t.label}
            </Link>
          ))}
          <span className="flex-shrink-0 px-4 py-3 font-mono text-[11px] uppercase tracking-widest text-green border-b-2 border-green">
            Chaveamento
          </span>
          <Link
            href="/copa"
            className="flex-shrink-0 px-4 py-3 font-mono text-[11px] uppercase tracking-widest text-yellow hover:border-yellow border-b-2 border-transparent transition-colors"
          >
            🏆 Mata-mata
          </Link>
        </div>
      </nav>

      <main className="max-w-[1280px] mx-auto px-8 py-8">
        <h1 className="font-anton text-4xl uppercase tracking-tight text-ink">
          <span className="text-yellow">►</span> Chaveamento
        </h1>
        <p className="font-serif italic text-soft mt-1 text-sm mb-8">
          A classificação abaixo mistura <b>resultados reais</b> (jogos já encerrados) com{" "}
          <b>os seus palpites</b> nos jogos que faltam — conforme a Copa anda, ela converge
          pra classificação real. O mata-mata oficial se preenche sozinho no fim da fase de
          grupos.
        </p>

        {/* ===== CLASSIFICAÇÃO PROJETADA ===== */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-anton text-2xl uppercase tracking-tight text-ink">
            Grupos — projeção
          </h2>
          <div className="font-mono text-[10px] uppercase tracking-widest text-mute">
            <span className="inline-block w-3 h-3 bg-green/20 border border-green align-middle mr-1" />
            classifica (top 2)
            <span className="inline-block w-3 h-3 bg-yellow/30 border border-yellow align-middle ml-3 mr-1" />
            3º entre os 8 melhores
          </div>
        </div>

        {!anyPalpite && (
          <div className="mb-6 border-l-4 border-yellow bg-yellow/10 px-4 py-3 font-serif italic text-sm text-ink">
            Você ainda não tem palpites salvos — a projeção considera só os resultados
            reais por enquanto. Preencha seus palpites em{" "}
            <Link href="/apostas" className="text-green font-bold underline">
              /apostas
            </Link>
            .
          </div>
        )}

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 mb-12">
          {groupViews.map((g) => (
            <div key={g.code} className="border-2 border-rule bg-paper">
              <div className="flex items-center justify-between px-3 py-2 border-b-2 border-ink">
                <span className="font-anton text-sm uppercase tracking-wider text-ink">
                  Grupo {g.code}
                </span>
                <span className="font-mono text-[9px] uppercase tracking-widest text-mute">
                  {g.realCount > 0 ? `${g.realCount} real · ` : ""}
                  {g.palpiteCount} palpite
                </span>
              </div>
              <table className="w-full">
                <tbody>
                  {g.rows.map((r) => {
                    const qualif = r.pos <= 2;
                    const third = r.pos === 3 && bestThirds.has(g.code);
                    return (
                      <tr
                        key={r.team.id}
                        className={[
                          "border-b border-rule last:border-0",
                          qualif ? "bg-green/10" : third ? "bg-yellow/20" : "",
                        ].join(" ")}
                      >
                        <td className="px-2 py-1.5 font-mono text-[10px] text-mute w-6">
                          {r.pos}º
                        </td>
                        <td className="py-1.5">
                          <span className="flex items-center gap-1.5 font-anton text-[12px] uppercase tracking-wide text-ink">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={flagUrl(r.team.iso_code)}
                              alt=""
                              className="w-4 h-auto border border-rule"
                            />
                            {r.team.name}
                          </span>
                        </td>
                        <td className="px-1 py-1.5 font-mono text-[11px] text-ink text-right w-8">
                          {r.p}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-[10px] text-mute text-right w-10">
                          {r.sg > 0 ? `+${r.sg}` : r.sg}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        {/* ===== MATA-MATA REAL ===== */}
        <h2 className="font-anton text-2xl uppercase tracking-tight text-ink mb-3">
          Mata-mata — oficial
        </h2>
        {ko.length === 0 && (
          <div className="border-2 border-dashed border-rule p-8 text-center font-serif italic text-soft">
            Os confrontos oficiais dos 16 avos aparecem aqui assim que a FIFA definir os
            classificados (fim da fase de grupos, 27/06). Atualiza sozinho.
          </div>
        )}
        <div className="space-y-10">
          {STAGES.map(({ key, label }) => {
            const list = byStage.get(key) ?? [];
            if (list.length === 0) return null;
            return (
              <section key={key}>
                <h3 className="font-anton text-xl uppercase tracking-tight text-green mb-3">
                  {label}
                </h3>
                <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {list.map((m) => {
                    const played = m.home_score !== null && m.away_score !== null;
                    const pens = m.pen_home !== null && m.pen_away !== null;
                    return (
                      <div key={m.id} className="border-2 border-rule bg-paper p-3">
                        <div className="font-mono text-[10px] uppercase tracking-widest text-mute mb-2 flex justify-between">
                          <span>{fmtKickoff(m.kickoff_at)}</span>
                          {m.status === "live" && (
                            <span className="text-green font-bold">● AO VIVO</span>
                          )}
                        </div>
                        {[
                          { name: m.home_name, iso: m.home_iso, score: m.home_score, pen: m.pen_home },
                          { name: m.away_name, iso: m.away_iso, score: m.away_score, pen: m.pen_away },
                        ].map((t, i) => (
                          <div key={i} className="flex items-center justify-between py-1">
                            <span className="flex items-center gap-2 font-anton text-sm uppercase tracking-wide text-ink">
                              {t.iso && (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={flagUrl(t.iso)} alt="" className="w-5 h-auto border border-rule" />
                              )}
                              {t.name ?? "A definir"}
                            </span>
                            <span className="font-anton text-base text-green">
                              {played ? t.score : "–"}
                              {pens && <span className="text-mute text-xs"> ({t.pen})</span>}
                            </span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </main>
    </div>
  );
}
