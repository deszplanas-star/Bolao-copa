import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { KoMatch, KoPredictionFields } from "@/lib/types";

export const dynamic = "force-dynamic";

const flagUrl = (iso: string) => `https://flagcdn.com/w80/${iso}.png`;

// Mesma trava do mata-mata (copa/actions.ts): jogo fecha 1h antes do apito, ou
// quando deixa de estar "scheduled". Sem horário definido = ainda aberto.
// Usada pra esconder de TERCEIROS os palpites de jogos ainda abertos (anti-cópia).
const KO_CUTOFF_MS = 60 * 60 * 1000;
function isKoLocked(status: string, kickoff_at: string | null): boolean {
  if (!kickoff_at) return false;
  if (status !== "scheduled") return true;
  return new Date(kickoff_at).getTime() - Date.now() <= KO_CUTOFF_MS;
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

export default async function CopaUserPage({ params }: { params: { userId: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/copa/${params.userId}`);

  const db = createAdminClient();
  if (!db) return <div className="p-8 font-mono text-sm">Erro: admin client indisponível</div>;

  const [koRes, predsRes, targetRes, champRes, cfgRes] = await Promise.all([
    db.from("ko_matches").select("*").order("kickoff_at", { ascending: true }),
    db.from("ko_predictions").select("*").eq("user_id", params.userId),
    db.from("users").select("id, name, avatar_url").eq("id", params.userId).maybeSingle(),
    db
      .from("champion_predictions")
      .select("team_iso, team_name")
      .eq("user_id", params.userId)
      .maybeSingle(),
    db.from("ko_config").select("champion_lock_at").eq("id", 1).maybeSingle(),
  ]);

  const target = targetRes.data;
  if (!target) redirect("/copa");

  const ko = (koRes.data ?? []) as KoMatch[];
  const preds = (predsRes.data ?? []) as (KoPredictionFields & { ko_match_id: string })[];
  const champion = champRes.data as { team_iso: string | null; team_name: string | null } | null;
  const predByMatch = new Map(preds.map((p) => [p.ko_match_id, p]));

  const rows = ko
    .map((m) => ({ m, p: predByMatch.get(m.id) }))
    .filter((r) => r.p);
  const totalPoints = rows.reduce((s, r) => s + (r.p?.points ?? 0), 0);
  const resolved = rows.filter((r) => r.p?.computed_at);

  // Quem está olhando. O dono vê os próprios palpites todos; terceiros só veem
  // os jogos JÁ TRAVADOS (1h antes do apito) — anti-cópia.
  const isOwn = user.id === params.userId;
  const visibleRows = isOwn
    ? rows
    : rows.filter((r) => isKoLocked(r.m.status as string, r.m.kickoff_at as string | null));
  const hiddenCount = rows.length - visibleRows.length;
  // Palpite de campeão também é copiável: só aparece pra terceiros depois de travar.
  const champLockAt = cfgRes.data?.champion_lock_at as string | null | undefined;
  const championLocked = !!champLockAt && Date.now() >= new Date(champLockAt).getTime();
  const showChampion = isOwn || championLocked;

  return (
    <div className="min-h-screen bg-paper flex flex-col">
      <header className="bg-ink text-paper border-b-4 border-yellow flex-shrink-0">
        <div className="max-w-[1280px] mx-auto px-8 h-14 flex items-center gap-2 font-anton uppercase tracking-wider text-base">
          <span className="w-2 h-2 bg-yellow rounded-full animate-pulse" />
          Bolão do Planinhas · Mata-mata
        </div>
      </header>

      <nav className="bg-paper border-b border-rule sticky top-0 z-20 overflow-x-auto flex-shrink-0">
        <div className="max-w-[1280px] mx-auto px-8 flex">
          <Link
            href="/copa?tab=ranking"
            className="flex-shrink-0 px-4 py-3 font-mono text-[11px] uppercase tracking-widest text-mute border-b-2 border-transparent hover:text-ink hover:border-ink"
          >
            ‹ Voltar ao ranking
          </Link>
          <span className="flex-shrink-0 px-4 py-3 font-mono text-[11px] uppercase tracking-widest text-yellow border-b-2 border-yellow">
            {target.name ?? "Apostador"}
          </span>
        </div>
      </nav>

      <main className="max-w-[860px] mx-auto px-8 py-10 w-full">
        <div className="flex items-center gap-3 mb-6">
          {target.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
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
              {rows.length} palpite{rows.length !== 1 ? "s" : ""} · {totalPoints} pts · mata-mata
            </p>
          </div>
        </div>

        {showChampion && champion?.team_iso && (
          <div className="flex items-center gap-2 mb-6 border-2 border-ink bg-paper2 px-4 py-3">
            <span className="font-mono text-[10px] uppercase tracking-widest text-mute">Campeão:</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={flagUrl(champion.team_iso)} alt="" className="w-6 h-4 object-cover border border-rule" />
            <span className="font-anton uppercase tracking-tight text-sm text-ink">{champion.team_name}</span>
          </div>
        )}

        {visibleRows.length === 0 ? (
          <p className="font-serif italic text-soft">
            {rows.length === 0
              ? "Nenhum palpite no mata-mata ainda."
              : "🔒 Os palpites deste apostador aparecem aqui assim que cada jogo trava (1h antes do apito)."}
          </p>
        ) : (
          <div className="space-y-2">
            {visibleRows.map(({ m, p }) => {
              const pts = p?.points ?? 0;
              const computed = !!p?.computed_at;
              const hasPen = p?.pen_home !== null && p?.pen_away !== null;
              const newModel = m.stage !== "LAST_32"; // oitavas+ = 3 camadas
              return (
                <div
                  key={m.id}
                  className="border border-rule bg-paper p-3 grid grid-cols-[1fr_auto_1fr_auto] items-center gap-3"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {m.home_iso && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={flagUrl(m.home_iso)} alt="" className="w-7 h-5 object-cover border border-rule flex-shrink-0" />
                    )}
                    <span className="font-anton uppercase tracking-tight text-sm truncate">{m.home_name ?? "A definir"}</span>
                  </div>
                  <div className="font-anton text-lg text-ink whitespace-nowrap text-center">
                    {newModel ? (
                      <>
                        90′ {p?.reg_home ?? "–"} <span className="text-mute mx-0.5">×</span> {p?.reg_away ?? "–"}
                        <span className="block font-mono text-[9px] text-mute tracking-widest">
                          prorr {p?.home_score}-{p?.away_score}
                          {hasPen ? ` · pên ${p?.pen_home}-${p?.pen_away}` : ""}
                        </span>
                      </>
                    ) : (
                      <>
                        {p?.home_score} <span className="text-mute mx-0.5">×</span> {p?.away_score}
                        {hasPen && (
                          <span className="block font-mono text-[9px] text-mute tracking-widest">
                            pên {p?.pen_home}-{p?.pen_away}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-2 justify-end min-w-0">
                    <span className="font-anton uppercase tracking-tight text-sm truncate text-right">{m.away_name ?? "A definir"}</span>
                    {m.away_iso && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={flagUrl(m.away_iso)} alt="" className="w-7 h-5 object-cover border border-rule flex-shrink-0" />
                    )}
                  </div>
                  <div className="text-right min-w-[70px]">
                    {computed ? (
                      <span
                        className={[
                          "inline-block px-2 py-1 font-anton text-[11px] uppercase tracking-wider",
                          pts >= 3 ? "bg-green text-paper" : pts >= 1 ? "bg-yellow text-ink" : "bg-paper2 text-mute",
                        ].join(" ")}
                      >
                        +{pts}
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
        <p className="mt-4 font-serif italic text-xs text-soft">
          {resolved.length} jogo(s) já apurado(s).
          {hiddenCount > 0 && ` · 🔒 ${hiddenCount} palpite(s) de jogo(s) ainda aberto(s) oculto(s) até travar.`}
        </p>
      </main>
    </div>
  );
}
