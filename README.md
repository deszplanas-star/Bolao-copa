# Bolão 26

Plataforma de bolão para a Copa do Mundo FIFA 2026 — apostas na fase de grupos, ranking ao vivo, premiação proporcional. Login Google, Pix manual, mobile-first.

## Stack

- **Next.js 14** (App Router) + TypeScript
- **Supabase** (Postgres + Auth + RLS)
- **Tailwind CSS 3.4**
- **Vercel** (deploy)

## Setup local

```bash
npm install
cp .env.local.example .env.local
# preencha .env.local com seus valores reais (NUNCA commite)
npm run dev
```

Abre em `http://localhost:3000`.

## Variáveis de ambiente

| Variável | Onde achar | Visibilidade |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API | Pública (browser) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API | Pública (RLS protege) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API | **PRIVADA** — server only |
| `ADMIN_EMAILS` | Lista CSV de e-mails admin | Server |
| `NEXT_PUBLIC_PIX_KEY` | Chave Pix exibida no modal | Pública |
| `NEXT_PUBLIC_PIX_AMOUNT` | Valor da aposta em reais | Pública |

## Banco de dados

Migrations em `supabase/migrations/`:

- `0001_initial_schema.sql` — 8 tabelas, RLS, triggers, função de cálculo de pontos
- `0002_seed_groups_and_teams.sql` — 12 grupos, 48 seleções, 72 jogos

### Como aplicar

**Opção A — Via Supabase Dashboard (recomendado para começar):**
1. Dashboard → SQL Editor
2. Cola o conteúdo de `0001_initial_schema.sql` → Run
3. Cola o conteúdo de `0002_seed_groups_and_teams.sql` → Run

**Opção B — Via Supabase CLI:**
```bash
supabase link --project-ref <seu-project-ref>
supabase db push
```

## Configurar Google OAuth no Supabase

1. **Google Cloud Console** → cria OAuth Client ID → tipo "Web application"
2. **Authorized redirect URIs:** `https://<seu-ref>.supabase.co/auth/v1/callback`
3. Copia Client ID e Secret
4. **Supabase Dashboard** → Authentication → Providers → Google → cola Client ID + Secret + ativa
5. **Site URL** (Authentication → URL Configuration): `https://<seu-domínio>` (ou `http://localhost:3000` em dev)
6. **Redirect URLs:** adiciona `https://<seu-domínio>/auth/callback` e `http://localhost:3000/auth/callback`

## Deploy na Vercel

1. Conecta o repo no GitHub
2. Vercel detecta Next.js automaticamente
3. **Settings → Environment Variables** — adiciona TODAS as vars do `.env.local`:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `ADMIN_EMAILS`
   - `NEXT_PUBLIC_PIX_KEY`
   - `NEXT_PUBLIC_PIX_AMOUNT`
4. Push pra `main` → deploy automático

## Estrutura

```
app/
├─ src/
│  ├─ app/                    # App Router
│  │  ├─ page.tsx             # Landing
│  │  ├─ login/page.tsx       # Tela de login Google
│  │  ├─ auth/callback/       # OAuth callback
│  │  ├─ apostas/page.tsx     # Área logada (em construção)
│  │  └─ admin/               # Painel admin (TODO)
│  ├─ lib/supabase/
│  │  ├─ client.ts            # Cliente browser
│  │  └─ server.ts            # Cliente server (cookies)
│  └─ middleware.ts           # Refresca sessão + protege rotas
├─ supabase/migrations/       # SQL versionado
├─ public/                    # Assets estáticos
└─ docs/                      # Spec HTML, mockups
```

## Roadmap

- [x] Fase 0 — Fundação (repo, schema, auth, deploy)
- [ ] Fase 1 — Core das apostas (CRUD palpites, classificação ao vivo)
- [ ] Fase 2 — Pix manual + painel admin
- [ ] Fase 3 — Ranking + e-mails diários
- [ ] Fase 4 — Lançamento público (20.05.2026)

## Regras

Pontuação por jogo:
- **+3 pts** placar exato
- **+1 pt** vencedor / empate certo
- **0** errado

Premiação:
- 70% campeão · 20% vice · 10% pódio · lanterna recupera o valor da aposta

Cutoff: 5 minutos antes do apito inicial de cada jogo.
