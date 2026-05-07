import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bolão 26 — O bolão da Copa do Mundo 2026",
  description:
    "Apostas, ranking e premiação para a fase de grupos da Copa do Mundo FIFA 2026. Login Google, Pix manual, ranking ao vivo, mobile-first.",
  metadataBase: new URL("https://bolao26.vercel.app"),
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
