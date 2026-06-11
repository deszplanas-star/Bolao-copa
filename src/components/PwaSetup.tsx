"use client";

import { useEffect } from "react";

// Registra o service worker (push de gols + instalação como app).
// Roda em todas as páginas via layout; é no-op onde não há suporte.
export default function PwaSetup() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((e) => {
      console.warn("[pwa] registro do service worker falhou", e);
    });
  }, []);

  return null;
}
