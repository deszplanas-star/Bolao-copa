"use client";

import { useEffect, useState } from "react";
import { removePushSubscription, savePushSubscription } from "@/app/apostas/push-actions";

// Converte a VAPID public key (base64url) pro formato do PushManager
function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type BellState = "unsupported" | "off" | "on" | "busy" | "denied";

/**
 * Botão "avise meus gols": inscreve este navegador/dispositivo no push.
 * No iPhone só funciona com o app instalado na tela de início (regra da
 * Apple pro Web Push) — o título do botão explica isso no hover.
 */
export default function PushBell({ onToast }: { onToast?: (msg: string) => void }) {
  const [state, setState] = useState<BellState>("unsupported");

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !("Notification" in window)
    )
      return;
    if (Notification.permission === "denied") {
      setState("denied");
      return;
    }
    navigator.serviceWorker.ready.then(async (reg) => {
      const sub = await reg.pushManager.getSubscription();
      setState(sub ? "on" : "off");
    });
  }, []);

  async function toggle() {
    const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!vapid) {
      onToast?.("Push não configurado (VAPID ausente).");
      return;
    }
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();

      if (existing) {
        await removePushSubscription({ endpoint: existing.endpoint });
        await existing.unsubscribe();
        setState("off");
        onToast?.("Notificações de gol desativadas.");
        return;
      }

      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState(perm === "denied" ? "denied" : "off");
        onToast?.("Permissão de notificação não concedida.");
        return;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid),
      });
      const res = await savePushSubscription(sub.toJSON());
      if (!res.ok) {
        await sub.unsubscribe();
        setState("off");
        onToast?.(`❌ ${res.error}`);
        return;
      }
      setState("on");
      onToast?.("🔔 Você vai receber aviso a cada gol!");
    } catch (e) {
      console.error("[push] toggle falhou", e);
      setState("off");
      onToast?.("Não consegui ativar as notificações aqui.");
    }
  }

  if (state === "unsupported") return null;

  const label =
    state === "on" ? "🔔 Gols ON" : state === "busy" ? "..." : state === "denied" ? "🔕" : "🔕 Gols";
  const title =
    state === "denied"
      ? "Notificações bloqueadas no navegador — libere nas configurações do site."
      : state === "on"
        ? "Recebendo aviso a cada gol. Clique para desativar."
        : "Receber notificação a cada gol da Copa. No iPhone, instale o app na tela de início primeiro.";

  return (
    <button
      onClick={state === "busy" || state === "denied" ? undefined : toggle}
      disabled={state === "busy" || state === "denied"}
      title={title}
      className={[
        "font-mono text-[10px] uppercase tracking-widest px-2.5 py-1.5 border transition-colors whitespace-nowrap",
        state === "on"
          ? "border-green text-green hover:border-red-400 hover:text-red-400"
          : "border-paper/30 text-paper/70 hover:border-yellow hover:text-yellow",
        state === "denied" ? "opacity-40 cursor-not-allowed" : "",
      ].join(" ")}
    >
      {label}
    </button>
  );
}
