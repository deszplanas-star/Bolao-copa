import type { Metadata, Viewport } from "next";
import "./globals.css";
import PwaSetup from "@/components/PwaSetup";

export const metadata: Metadata = {
  title: "Bolão 26 — O bolão da Copa do Mundo 2026",
  description:
    "Apostas, ranking e premiação para a fase de grupos da Copa do Mundo FIFA 2026. Login Google, Pix manual, ranking ao vivo, mobile-first.",
  metadataBase: new URL("https://bolao-copa-pu3k.vercel.app"),
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/icon-192.png",
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Bolão 26",
  },
};

export const viewport: Viewport = {
  themeColor: "#002776",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body>
        {children}
        <PwaSetup />
      </body>
    </html>
  );
}
