/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'flagcdn.com' },
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' }, // Google avatares
    ],
  },
  experimental: {
    serverActions: {
      // O comprovante Pix pode ter até 5MB (limite da tela) — o default de
      // 1MB derrubava o submitPayment em silêncio (modal preso em Enviando).
      bodySizeLimit: '8mb',
    },
  },
};

export default nextConfig;
