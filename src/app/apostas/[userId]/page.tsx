import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Match, MatchView, Prediction, Team } from "@/lib/types";

export const dynamic = "force-dynamic";

const flagUrl = (iso: string) => `https://flagcdn.com/w80/${iso}.png`;

function fmtKickoff(iso: string) {
  return new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function ApostasUserPage({
  params,
}: {
  params: { userId: string };
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/apostas/${params.userId}`);

  const db = createAdminClient();
  if (!db) return <div className="p-8 font-mono text-sm">Erro: admin client indisponível</div>;

  const [matchesRes, teamsRes, predsRes, targetRes] = await Promise.all([
    db.from("matches").select("*").order("kickoff_at", { ascending: true }),
    db.from("teams").select("*"),
    db.from("predictions").select("*").eq("user_id", params.userId),
    db.from("users").select("id, name, avatar_url").eq("id", params.userId).maybeSingle(),
  ]);

  const target = targetRes.data;
  if (!target) redirect("/apostas?tab=ranking");

  const matches = (matchesRes.data ?? []) as Match[];
  const teams = (teamsRes.data ?? []) as Team[];
  const preds = (predsRes.data ?? []) as Prediction[];

  const teamById = new Map(teams.map((t) => [t.id, t]));
  const predByMatch = new Map(preds.map((p) => [p.match_id, p]));

  const matchViews: MatchView[] = matches
    .map((m) => {
      const home = teamById.get(m.home_team_id);
      const away = teamById.get(m.away_team_id);
      if (!home || !away) return null;
      const p = predByMatch.get(m.id);
      return {
        ...m,
        home,
        away,
        prediction: p
          ? { home_score: p.home_score, away_score: p.away_score, points: p.points, computed_at: p.computed_at }
          : null,
      } satisfies MatchView;
    })
    .filter((m): m is MatchView => m !== null);

  const withPred = matchViews.filter((m) => m.prediction !== null);
  const resolved = withPred.filter((m) => m.prediction?.computed_at);
  const totalPoints = withPred.reduce((s, m) => s + (m.prediction?.points ?? 0), 0);
  const exactHits = resolved.filter((m) => m.prediction?.points === 3).length;
  const partialHits = resolved.filter((m) => m.prediction?.points === 1).length;

  const navTabs = [
    { href: "/apostas?tab=apostas", label: "Apostas" },
    { href: "/apostas?tab=ranking", label: "Ranking" },
    { href: "/apostas?tab=resultados", label: "Resultados" },
    { href: "/apostas?tab=minhas", label: "Minhas apostas" },
    { href: "/chaveamento", label: "Chaveamento" },
  ];

  return (
    <div className="min-h-screen bg-paper flex flex-col">
      <header className="bg-ink text-paper border-b-4 border-green flex-shrink-0">
        <div className="max-w-[1280px] mx-auto px-8 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2 font-anton uppercase tracking-wider text-base">
            <span className="w-2 h-2 bg-green rounded-full animate-pulse" />
            Bolão do Planinhas
          </div>
        </div>
      </header>

      <nav className="bg-paper border-b border-rule sticky top-0 z-20 overflow-x-auto flex-shrink-0">
        <div className="max-w-[1280px] mx-auto px-8 flex">
          {navTabs.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className="flex-shrink-0 px-4 py-3 font-mono text-[11px] uppercase tracking-widest text-mute hover:text-ink border-b-2 border-transparent hover:border-ink transition-colors"
            >
              {t.label}
            </Link>
          ))}
          <span className="flex-shrink-0 px-4 py-3 font-mono text-[11px] uppercase tracking-widest text-green border-b-2 border-green">
            {target.name ?? "Apostador"}
          </span>
        </div>
      </nav>

      <main className="max-w-[860px] mx-auto px-8 py-10 w-full">
        <div className="flex items-center gap-3 mb-6">
          {target.avatar_url ? (
            <img src={target.avatar_url} alt="" className="w-10 h-10 rounded-full border-2 border-ink object-cover" />
          ) : (
            <span className="w-10 h-10 rounded-full bg-paper2 border-2 border-ink grid place-items-center font-mono text-base text-mute">
              {(target.name ?? "?").slice(0, 1).toUpperCase()}
            </span>
          )}
          <div>
            <h2 className="font-anton text-3xl uppercase tracking-tight text-ink">
              {target.name ?? "Apostador"}
            </h2>
            <p className="font-mono text-[10px] uppercase tracking-widest text-mute">
              {withPred.length}/{matchViews.length} palpites
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          {[
            { label: "Pontos", value: totalPoints, accent: true },
            { label: "Apurados", value: resolved.length, accent: false },
            { label: "Exatos", value: exactHits, accent: false },
            { label: "Parciais", value: partialHits, accent: false },
          ].map((s) => (
            <div
              key={s.label}
              className={["border-2 p-3", s.accent ? "border-ink bg-ink text-paper" : "border-rule bg-paper"].join(" ")}
            >
              <div className={["font-mono text-[10px] uppercase tracking-widest mb-1", s.accent ? "text-green" : "text-mute"].join(" ")}>
                {s.label}
              </div>
              <div className="font-anton text-3xl leading-none">{s.value}</div>
            </div>
          ))}
        </div>

        {withPred.length === 0 ? (
          <p className="font-serif italic text-soft">Nenhum palpite ainda.</p>
        ) : (
          <div className="space-y-2">
            {withPred.map((m) => {
              const pts = m.prediction?.points ?? 0;
              const computed = !!m.prediction?.computed_at;
              return (
                <div
                  key={m.id}
                  className="border border-rule bg-paper p-3 grid grid-cols-[1fr_auto_1fr_auto] items-center gap-3"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <img src={flagUrl(m.home.iso_code)} alt="" className="w-7 h-5 object-cover border border-rule flex-shrink-0" />
                    <span className="font-anton uppercase tracking-tight text-sm truncate">{m.home.name}</span>
                  </div>
                  <div className="font-anton text-lg text-ink whitespace-nowrap">
                    {m.prediction?.home_score} <span className="text-mute mx-0.5">×</span>{" "}
                    {m.prediction?.away_score}
                  </div>
                  <div className="flex items-center gap-2 justify-end min-w-0">
                    <span className="font-anton uppercase tracking-tight text-sm truncate text-right">{m.away.name}</span>
                    <img src={flagUrl(m.away.iso_code)} alt="" className="w-7 h-5 object-cover border border-rule flex-shrink-0" />
                  </div>
                  <div className="text-right min-w-[80px]">
                    {computed ? (
                      <span className={[
                        "inline-block px-2 py-1 font-anton text-[11px] uppercase tracking-wider",
                        pts === 3 ? "bg-green text-paper" : pts === 1 ? "bg-yellow text-ink" : "bg-paper2 text-mute",
                      ].join(" ")}>
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
        )}
      </main>
    </div>
  );
}
