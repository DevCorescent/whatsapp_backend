# WhatsCRM — NestJS Backend

The API backend for WhatsCRM: a multi-tenant WhatsApp CRM SaaS platform. Built as a NestJS monorepo that serves as the **single source of truth** for all business logic, database access, and background processing. The Next.js frontend is a thin shell — it holds the session layer and UI only; every data operation proxies here.

---

## Architecture

```mermaid
graph TB
    subgraph "Frontend (Vercel)"
        NextJS["Next.js App<br/>(session + UI only)"]
    end

    subgraph "Backend (Render)"
        GW["Gateway Service<br/>:4000"]

        subgraph "Workers"
            MSG["Messaging Worker"]
            AI["AI Worker"]
            CAM["Campaigns Worker"]
        end
    end

    subgraph "Infrastructure"
        DB[("PostgreSQL<br/>(Neon / Supabase)")]
        REDIS[("Redis<br/>(Upstash)")]
    end

    subgraph "External APIs"
        META["Meta Graph API<br/>(WhatsApp Cloud)"]
        OPENAI["OpenAI / Groq<br/>(AI replies)"]
        STRIPE["Stripe / Razorpay<br/>(Billing)"]
    end

    NextJS -->|"proxy /api/* → /api/nest/*"| GW
    GW -->|JWT auth| NextJS

    GW -->|Prisma| DB
    GW -->|Bull queues| REDIS

    REDIS -->|jobs| MSG
    REDIS -->|jobs| AI
    REDIS -->|jobs| CAM

    MSG --> DB
    MSG --> META
    AI --> DB
    AI --> OPENAI
    CAM --> DB
    CAM --> META

    GW --> STRIPE
```

### Request Flow

```
Browser → Next.js (edge middleware, session check)
       → /api/nest/* proxy route
       → NestJS Gateway (JWT guard, ValidationPipe)
       → Feature module (service → Prisma → DB)
       → TransformInterceptor wraps: { success, data, pagination? }
       → Browser
```

### Multi-Tenancy Model

Every row is scoped by `tenantId`. The JWT payload carries `{ sub, tenantId, businessId, role, email }`. Guards enforce tenant isolation at the controller layer — no cross-tenant data leaks are possible even with a valid token.

Account types: `PLATFORM` (super admin) · `RESELLER` · `CLIENT`

---

## Monorepo Structure

```
backend/
├── apps/
│   ├── gateway/          # Main HTTP API — the service Render runs
│   │   └── src/
│   │       ├── account/          contacts, profile, brand config
│   │       ├── admin/            super-admin platform management
│   │       ├── ai/               AI settings, knowledge base triggers
│   │       ├── analytics/        dashboard metrics, reports
│   │       ├── api-v1/           public REST API (v1 key-auth)
│   │       ├── auth/             login, JWT issue, /auth/me refresh
│   │       ├── billing/          plans, subscriptions, invoices
│   │       ├── blacklist/        blocked numbers
│   │       ├── businesses/       WhatsApp Business account CRUD
│   │       ├── campaigns/        broadcast campaign management
│   │       ├── chatbot/          flow builder, chatbot config
│   │       ├── contacts/         contact CRUD, import, tagging
│   │       ├── conversations/    inbox threads, assignments
│   │       ├── export/           CSV/Excel data exports
│   │       ├── integrations/     third-party webhook integrations
│   │       ├── knowledge/        RAG knowledge base
│   │       ├── leads/            lead pipeline, scoring
│   │       ├── media/            file upload, S3 proxy
│   │       ├── messages/         message history, send API
│   │       ├── newsletter/       newsletter subscription
│   │       ├── notifications/    in-app + email notifications
│   │       ├── onboarding/       tenant onboarding checklist
│   │       ├── quick-replies/    canned response library
│   │       ├── reseller/         reseller portal, client provisioning
│   │       ├── search/           full-text search across contacts/messages
│   │       ├── segments/         dynamic contact segments
│   │       ├── settings/         workspace settings, integrations config
│   │       ├── team/             users, roles, invites
│   │       ├── tickets/          support ticket management
│   │       ├── wallet/           prepaid wallet, top-up, transactions
│   │       ├── webhook/          inbound Meta webhook handler
│   │       ├── webhooks/         outbound webhook config (user-defined)
│   │       ├── gateway.controller.ts   /ping, /brand, /account/plan-name
│   │       ├── gateway.service.ts      brand + plan queries
│   │       └── gateway.module.ts       root module wiring
│   │
│   ├── messaging/        # Worker: inbound/outbound WhatsApp messages
│   ├── ai-worker/        # Worker: AI auto-reply processing
│   ├── campaigns/        # Worker: broadcast campaign sends
│   ├── contacts/         # Worker: bulk contact operations
│   └── billing/          # Worker: subscription lifecycle events
│
├── libs/
│   ├── prisma/           # @lib/prisma — global PrismaService + schema
│   │   └── prisma/
│   │       └── schema.prisma
│   ├── common/           # @lib/common — JwtAuthGuard, tenant decorator, permissions
│   └── queue/            # @lib/queue — Bull queue names + module
│
├── nest-cli.json         # Monorepo app registry
├── tsconfig.json
└── package.json
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | NestJS 12 (Express platform) |
| Language | TypeScript 6 |
| ORM | Prisma 7.10 (pg adapter) |
| Database | PostgreSQL (Neon / Supabase compatible) |
| Queue | Bull + BullMQ backed by Redis (Upstash) |
| Auth | Passport JWT + bcryptjs |
| Validation | class-validator + class-transformer |
| AI | OpenAI SDK, Groq, OpenRouter |
| Docs | Swagger / OpenAPI (`/api/docs`) |
| Build | `@rspack/core` (fast bundler), `tsc` for type-check |
| Test | Vitest |
| Lint | oxlint |

---

## Environment Variables

Copy `.env` and fill in the values. All variables are required in production unless marked optional.

```env
# ── Database ───────────────────────────────────────────────
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require

# ── Auth ───────────────────────────────────────────────────
JWT_SECRET=                     # ≥32 random bytes
JWT_EXPIRES_IN=7d
SERVICE_SECRET=                 # shared secret for Next.js → NestJS service calls

# ── Redis ──────────────────────────────────────────────────
REDIS_HOST=
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_TLS=true                  # set false for local Redis

# ── CORS ───────────────────────────────────────────────────
FRONTEND_URL=https://your-app.vercel.app

# ── Ports (defaults shown — override per worker) ───────────
GATEWAY_PORT=4000
MESSAGING_PORT=4001
AI_WORKER_PORT=4002
CAMPAIGNS_PORT=4003
CONTACTS_PORT=4004
BILLING_PORT=4005

# ── WhatsApp / Meta ────────────────────────────────────────
WHATSAPP_APP_SECRET=
WHATSAPP_APP_ID=
WHATSAPP_ES_CONFIG_ID=
WHATSAPP_API_VERSION=v22.0
WHATSAPP_VERIFY_TOKEN=

# ── Encryption (contact PII at rest) ───────────────────────
ENCRYPTION_KEY=                 # 32-byte hex string

# ── AI ─────────────────────────────────────────────────────
GROQ_API_KEY=
GROQ_MODEL=llama-3.1-8b-instant
OPENROUTER_API_KEY=             # optional fallback
OPENROUTER_MODEL=               # optional
```

---

## Local Development

### Prerequisites

- Node.js 20+
- A PostgreSQL database (local or Neon free tier)
- Redis (local or Upstash free tier)

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill env
cp .env.example .env   # edit DATABASE_URL, JWT_SECRET, REDIS_* at minimum

# 3. Generate Prisma client
npm run db:generate

# 4. Run migrations
npx prisma migrate dev --schema=libs/prisma/prisma/schema.prisma

# 5. Start gateway in watch mode
npm run start:gateway
# → http://localhost:4000
# → Swagger UI: http://localhost:4000/api/docs
```

### Start individual workers

```bash
npm run start:messaging     # WhatsApp message handler
npm run start:ai-worker     # AI auto-reply worker
npm run start:campaigns     # Campaign send worker
```

---

## API Overview

All responses are wrapped by `TransformInterceptor`:

```json
{ "success": true, "data": { ... } }
```

Pagination is included where applicable:

```json
{ "success": true, "data": [...], "pagination": { "page": 1, "limit": 20, "total": 142 } }
```

### Authentication

```
POST /auth/login        { email, password, tenantSlug? }  → { access_token, user }
GET  /auth/me           Bearer <token>                    → full user + tenant profile
```

### Health

```
GET  /ping              → { status: "ok", ts: "..." }
```

### White-Label Branding (public)

```
GET  /brand?host=<host>              → brand config for a custom domain
GET  /brand/by-tenant?tenantId=<id> → brand config for a tenant (used by email templates)
```

### Account

```
GET  /account/plan-name   Bearer   → subscription plan display name for sidebar badge
```

Full interactive docs at `/api/docs` when the server is running.

---

## Scripts

| Script | Description |
|---|---|
| `npm run start:gateway` | Start gateway in watch mode |
| `npm run build` | Generate Prisma client + build gateway for production |
| `npm run start:prod:gateway` | Run compiled gateway (production) |
| `npm run db:generate` | Regenerate Prisma client after schema changes |
| `npm run typecheck` | Full TypeScript type-check (all apps + libs) |
| `npm run lint` | oxlint across `apps/` and `libs/` |
| `npm run test` | Run Vitest test suite |
| `npm run test:watch` | Vitest watch mode |

---

## Deployment (Render)

The gateway is deployed as a **Web Service** on Render.

| Setting | Value |
|---|---|
| Build command | `npm install && npm run build` |
| Start command | `npm run start:prod:gateway` |
| Port | `4000` (or `PORT` env var) |
| Health check | `GET /ping` |

> **Free tier keep-alive:** Set up a cron job (e.g. cron-job.org) to `GET /ping` every 14 minutes — Render free tier sleeps after 15 minutes of inactivity.

Set all env vars from the table above in the Render service dashboard. `DATABASE_URL` and `REDIS_*` are the minimum required to start.

---

## Remotes

```
origin      https://github.com/yashvardhansharma111/whatsapp_backend.git
corescent   https://github.com/DevCorescent/whatsapp_backend.git
```

---

## License

Private — Corescent Technologies Pvt Ltd. All rights reserved.
