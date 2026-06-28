import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Tela inicial = desambiguação: o usuário escolhe Mata-mata ou Fase de Grupos.
// Cada seção tem suas próprias abas (Minhas apostas · Ranking · Resultado).
export default async function Home() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/home.html");

  return (
    <div className="min-h-screen flex flex-col bg-paper">
      <header className="bg-ink text-paper border-b-4 border-green flex-shrink-0">
        <div className="max-w-[1280px] mx-auto px-8 h-14 flex items-center gap-2 font-anton uppercase tracking-wider text-base">
          <span className="w-2 h-2 bg-green rounded-full animate-pulse" />
          Bolão do Planinhas
        </div>
      </header>

      <main className="flex-1 grid place-items-center px-6 py-12">
        <div className="w-full max-w-2xl">
          <h1 className="font-anton text-3xl sm:text-4xl uppercase tracking-tight text-ink">
            Onde você quer <span className="text-green">entrar?</span>
          </h1>
          <p className="font-serif italic text-soft mt-2 mb-8">
            A fase de grupos já acabou — o foco agora é o mata-mata. Escolha um espaço:
          </p>

          <div className="grid sm:grid-cols-2 gap-4">
            <a
              href="/copa"
              className="group border-2 border-ink bg-paper p-6 hover:bg-ink transition-colors"
              style={{ boxShadow: "6px 6px 0 #FFDF00" }}
            >
              <div className="font-anton text-2xl uppercase tracking-tight text-ink group-hover:text-yellow">
                🏆 Mata-mata
              </div>
              <p className="font-serif italic text-sm text-soft group-hover:text-paper/80 mt-1">
                Palpites de cada fase + campeão, ranking e resultados da fase final.
              </p>
              <span className="inline-block mt-4 font-mono text-[11px] uppercase tracking-widest text-green group-hover:text-yellow">
                Entrar →
              </span>
            </a>

            <a
              href="/apostas"
              className="group border-2 border-ink bg-paper p-6 hover:bg-ink transition-colors"
              style={{ boxShadow: "6px 6px 0 #009739" }}
            >
              <div className="font-anton text-2xl uppercase tracking-tight text-ink group-hover:text-green">
                Fase de Grupos
              </div>
              <p className="font-serif italic text-sm text-soft group-hover:text-paper/80 mt-1">
                Seus palpites, ranking e resultados da fase de grupos (encerrada).
              </p>
              <span className="inline-block mt-4 font-mono text-[11px] uppercase tracking-widest text-green group-hover:text-green">
                Entrar →
              </span>
            </a>
          </div>
        </div>
      </main>
    </div>
  );
}
