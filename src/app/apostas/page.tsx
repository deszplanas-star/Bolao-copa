import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function ApostasPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login?next=/apostas");

  return (
    <main className="min-h-screen bg-paper">
      <header className="bg-ink text-paper border-b-4 border-green">
        <div className="max-w-[1280px] mx-auto px-8 h-14 flex items-center justify-between gap-6">
          <div className="flex items-center gap-2 font-anton uppercase tracking-wider">
            <span className="w-2 h-2 bg-green rounded-full animate-pulse" />
            Bolão / 26
          </div>
          <div className="hidden md:block font-mono text-[11px] uppercase tracking-widest text-paper3">
            bolaocopa26.com / apostas / <span className="text-yellow">grupo-c</span>
          </div>
          <div className="font-mono text-[11px] uppercase tracking-widest text-green">
            {user.user_metadata?.full_name || user.email}
          </div>
        </div>
      </header>

      <section className="max-w-[1280px] mx-auto px-8 py-16">
        <div className="border-b-[3px] border-ink pb-3 mb-8 relative">
          <h1 className="font-anton text-5xl uppercase tracking-tight text-green">
            <span className="text-ink">►</span> Minhas Apostas
          </h1>
          <span className="absolute -bottom-2 left-0 w-20 h-0.5 bg-green" />
        </div>

        <div className="p-12 border-2 border-dashed border-rule bg-paper2 text-center">
          <h2 className="font-anton text-3xl uppercase text-ink mb-3">
            Em construção
          </h2>
          <p className="font-serif italic text-soft max-w-prose mx-auto">
            Logado como <strong className="text-ink">{user.email}</strong>. A área de palpites por jogo está sendo migrada do mockup HTML para esta versão React. Em breve com 72 jogos, classificação ao vivo, salvamento no Supabase e Pix integrado.
          </p>
        </div>
      </section>
    </main>
  );
}
