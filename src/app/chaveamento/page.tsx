import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

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

  // Defensivo: antes da migration 0005 (ou do 1º ingest), a tabela pode não
  // existir ou estar vazia — a página mostra o esqueleto com aviso.
  const { data, error } = await supabase
    .from("ko_matches")
    .select("*")
    .order("kickoff_at", { ascending: true });

  const matches = (error ? [] : (data ?? [])) as KoMatch[];
  const byStage = new Map<string, KoMatch[]>();
  for (const m of matches) {
    const arr = byStage.get(m.stage) ?? [];
    arr.push(m);
    byStage.set(m.stage, arr);
  }

  return (
    <div className="min-h-screen bg-paper">
      <header className="bg-ink text-paper border-b-4 border-green">
        <div className="max-w-[1280px] mx-auto px-8 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2 font-anton uppercase tracking-wider text-base">
            <span className="w-2 h-2 bg-green rounded-full animate-pulse" />
            Bolão / 26
          </div>
          <Link
            href="/apostas"
            className="font-mono text-[11px] uppercase tracking-widest text-paper/70 hover:text-yellow"
          >
            ← Voltar pras apostas
          </Link>
        </div>
      </header>

      <main className="max-w-[1280px] mx-auto px-8 py-8">
        <h1 className="font-anton text-4xl uppercase tracking-tight text-ink">
          <span className="text-yellow">►</span> Chaveamento
        </h1>
        <p className="font-serif italic text-soft mt-1 text-sm mb-8">
          Mata-mata da Copa 2026, atualizado automaticamente conforme os jogos são
          definidos e jogados. Só pra acompanhar — o bolão vale a fase de grupos.
        </p>

        {matches.length === 0 && (
          <div className="border-2 border-dashed border-rule p-8 text-center font-serif italic text-soft">
            O chaveamento aparece aqui assim que a FIFA definir os classificados —
            os confrontos dos 16 avos saem ao fim da fase de grupos (27/06).
          </div>
        )}

        <div className="space-y-10">
          {STAGES.map(({ key, label }) => {
            const list = byStage.get(key) ?? [];
            if (list.length === 0) return null;
            return (
              <section key={key}>
                <h2 className="font-anton text-xl uppercase tracking-tight text-green mb-3">
                  {label}
                </h2>
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
                              {pens && (
                                <span className="text-mute text-xs"> ({t.pen})</span>
                              )}
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
