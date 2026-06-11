"use client";

import { useEffect, useState } from "react";

type BipEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

/**
 * Banner de instalação do app:
 * - Android/Chrome: captura o beforeinstallprompt e oferece instalação
 *   NATIVA em 1 toque (o navegador mostra o diálogo oficial).
 * - iPhone/iPad: a Apple não permite instalar programaticamente — o banner
 *   mostra o passo a passo visual (Compartilhar → Adicionar à Tela de Início).
 * Some quando o app já está instalado (standalone) ou após dispensar.
 */
export default function InstallBanner() {
  const [deferred, setDeferred] = useState<BipEvent | null>(null);
  const [ios, setIos] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true;
    if (standalone) return;
    if (localStorage.getItem("bolao26-install-dismissed") === "1") return;

    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIos) {
      setIos(true);
      setShow(true);
      return;
    }
    const onBip = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BipEvent);
      setShow(true);
    };
    window.addEventListener("beforeinstallprompt", onBip);
    return () => window.removeEventListener("beforeinstallprompt", onBip);
  }, []);

  function dismiss() {
    localStorage.setItem("bolao26-install-dismissed", "1");
    setShow(false);
  }

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    if (outcome === "accepted") setShow(false);
  }

  if (!show) return null;

  return (
    <div className="fixed bottom-0 inset-x-0 z-[60] bg-ink text-paper border-t-4 border-green px-4 py-3 shadow-lg">
      <div className="max-w-[640px] mx-auto flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icon-192.png" alt="" className="w-10 h-10 border border-paper/20 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-anton text-sm uppercase tracking-wider">
            Instale o app do bolão 📲
          </div>
          {ios ? (
            <div className="font-serif text-[12px] text-paper/80 leading-snug">
              Toque em{" "}
              <svg viewBox="0 0 24 24" className="inline w-4 h-4 -mt-1 fill-yellow" aria-label="Compartilhar">
                <path d="M12 2l4 4h-3v9h-2V6H8l4-4zM5 10v10h14V10h2v12H3V10h2z" />
              </svg>{" "}
              <b className="text-yellow">Compartilhar</b> e depois em{" "}
              <b className="text-yellow">&quot;Adicionar à Tela de Início&quot;</b>. Abra pelo
              ícone novo pra ativar as notificações de gol.
            </div>
          ) : (
            <div className="font-serif text-[12px] text-paper/80">
              Ícone na tela, ranking ao vivo e notificação a cada gol.
            </div>
          )}
        </div>
        {!ios && (
          <button
            onClick={install}
            className="px-4 py-2 bg-green text-paper font-anton text-[12px] uppercase tracking-wider border-2 border-green hover:bg-green2 whitespace-nowrap"
          >
            Instalar
          </button>
        )}
        <button
          onClick={dismiss}
          aria-label="Fechar"
          className="w-8 h-8 grid place-items-center text-paper/60 hover:text-paper flex-shrink-0"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
