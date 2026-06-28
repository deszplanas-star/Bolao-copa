"use client";

import { createClient } from "@/lib/supabase/client";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

function LoginInner() {
  const params = useSearchParams();
  const next = params.get("next") || "/";
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signInWithGoogle() {
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    if (error) {
      setError(error.message);
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen grid place-items-center px-6 py-12 bg-paper">
      <div className="w-full max-w-md text-center">
        <div className="inline-flex items-center gap-2 mb-8 font-anton text-lg uppercase tracking-wider text-ink">
          <span className="w-2 h-2 bg-green rounded-full animate-pulse" />
          Bolão / 26
        </div>

        <h1 className="font-anton text-5xl uppercase leading-none tracking-tight mb-3 text-ink">
          Entrar
        </h1>
        <p className="font-serif italic text-soft mb-12">
          Login Google em um clique. Sem cadastro, sem senha.
        </p>

        <button
          onClick={signInWithGoogle}
          disabled={loading}
          className="w-full inline-flex items-center justify-center gap-3 px-7 py-5 bg-ink text-paper font-anton text-base uppercase tracking-wider border-2 border-ink hover:bg-green hover:border-green transition-all disabled:opacity-50"
          style={{ boxShadow: "5px 5px 0 #009739" }}
        >
          <span className="w-6 h-6 bg-paper text-ink rounded-full grid place-items-center text-sm font-black">
            G
          </span>
          {loading ? "Conectando..." : "Entrar com Google"}
          <span>→</span>
        </button>

        {error && (
          <div className="mt-4 p-3 bg-paper2 border-l-4 border-red-500 text-sm text-red-700 text-left">
            {error}
          </div>
        )}

        <div className="mt-8 font-mono text-[11px] uppercase tracking-widest text-mute">
          Ao entrar, você concorda com as regras do bolão
        </div>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}
