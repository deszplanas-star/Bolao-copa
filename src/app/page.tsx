import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function Home() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Se já logado, manda direto pra área de apostas
  if (user) redirect("/apostas");

  return (
    <main className="min-h-screen flex flex-col">
      {/* TOP BAR */}
      <header className="bg-ink text-paper border-b-4 border-green">
        <div className="max-w-[1280px] mx-auto px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3 font-anton text-lg uppercase tracking-wider">
            <span className="w-2 h-2 bg-green rounded-full animate-pulse" />
            Bolão / 26
          </div>
          <Link
            href="/login"
            className="font-mono text-xs uppercase tracking-widest text-yellow hover:text-paper transition-colors"
          >
            Entrar →
          </Link>
        </div>
      </header>

      {/* HERO */}
      <section className="flex-1 grid place-items-center px-8 py-24">
        <div className="max-w-[1100px] mx-auto text-center">
          <div className="inline-flex items-center gap-2 bg-green text-paper px-3 py-1.5 font-anton text-xs uppercase tracking-widest mb-8">
            ► Documento de produto · Lançamento 20.05.2026
          </div>

          <h1 className="font-anton uppercase leading-[0.86] tracking-tight text-[clamp(56px,12vw,180px)] mb-12">
            O bolão
            <br />
            da <span className="text-green">Copa</span>
            <br />
            <span className="text-green">2026</span> ⚽
          </h1>

          <Link
            href="/login"
            className="inline-flex items-center gap-3 px-7 py-5 bg-ink text-paper font-anton text-base uppercase tracking-wider border-2 border-ink hover:bg-green hover:border-green transition-all"
            style={{ boxShadow: "5px 5px 0 #009739" }}
          >
            <span className="w-6 h-6 bg-paper text-ink rounded-full grid place-items-center text-sm font-black">
              G
            </span>
            Entrar com Google
            <span>→</span>
          </Link>

          <div className="mt-4 font-mono text-xs uppercase tracking-widest text-soft">
            Sem cadastro · Sem senha · <strong className="text-ink">4 minutos</strong> até a primeira aposta
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="bg-ink text-paper3 py-6 text-center font-mono text-xs uppercase tracking-widest">
        Bolão 26 · Copa do Mundo FIFA 2026 · Não afiliado à FIFA
      </footer>
    </main>
  );
}
