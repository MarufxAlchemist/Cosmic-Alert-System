# PROJECT_CONTEXT.md — Transient Event Detection

> Last updated: 2026-08-06

## What This Project Is

**Transient Event Detection** is a real-time, multi-messenger astrophysical event alert platform. It ingests high-priority transient alerts — Gravitational Waves (GW), Gamma-ray Bursts (GRB), Fast Radio Bursts (FRB), and Neutrinos (NU) — from NASA's General Coordinates Network (GCN) Kafka broker and presents them to astronomical research teams through a live, collaborative web dashboard.

## Repository

- **GitHub:** https://github.com/MarufxAlchemist/Transient Event Detection
- **Branch:** `main`
- **Monorepo:** pnpm workspaces (`artifacts/*`, `lib/*`)

## Technology Stack

### Frontend (`artifacts/astro-sentinel/`)
- React 19, Vite 7, Wouter (routing), TanStack Query, TailwindCSS v4, shadcn/ui, Framer Motion

### API Server (`artifacts/api-server/`)
- Node.js 22, Express 5, WebSocket (ws), Drizzle ORM, Pino logger, esbuild (bundler)
- Built as ESM bundle via `build.mjs` → `dist/index.mjs`

### Python Backend (`backend/`)
- Python 3.12, FastAPI, uvicorn, gcn-kafka consumer

### Database
- PostgreSQL 16 + PostGIS, Drizzle ORM, 8 schemas, 26 tables
- Extensions: pgvector, PostGIS, ltree, TimescaleDB

### Infrastructure
- Docker Compose (single entry point: `docker compose up --build`)
- 4 root-level Dockerfiles: `Dockerfile.api`, `Dockerfile.frontend`, `Dockerfile.python`, `Dockerfile.migrate`

## Repository Structure

```
.
├── docker-compose.yml          ← single Docker entry point
├── Dockerfile.api / .frontend / .python / .migrate
├── .dockerignore / .env / .env.example
├── artifacts/
│   ├── api-server/             ← Express REST + WebSocket source
│   └── astro-sentinel/         ← React/Vite frontend source
│       └── nginx.conf          ← SPA + /api proxy config
├── backend/                    ← Python FastAPI + GCN Kafka source
│   └── app/
├── lib/
│   ├── db/                     ← Drizzle schema + migrations
│   ├── api-client-react/       ← TanStack Query hooks (OpenAPI-generated)
│   ├── api-zod/                ← Zod validation schemas
│   └── api-spec/               ← OpenAPI spec
├── deploy/
│   └── nginx/                  ← Production VPS nginx configs
├── docs/                       ← AI agent persistent memory (this dir)
└── scripts/                    ← Build utilities
```

## Shared Libraries (`lib/`)

| Package | Purpose |
|---|---|
| `@workspace/db` | Drizzle ORM pool, schema exports, migrations |
| `@workspace/api-zod` | Zod schemas generated from OpenAPI |
| `@workspace/api-spec` | OpenAPI YAML spec |
| `@workspace/api-client-react` | TanStack Query hooks |

## Key Entry Points

| Service | File | Port |
|---|---|---|
| Python backend | `backend/app/main.py` | 8001 |
| API server | `artifacts/api-server/src/index.ts` | 8000 |
| Frontend | `artifacts/astro-sentinel/src/main.tsx` | 5173 |
| DB schema | `lib/db/src/schema/` | — |
| Migrations | `lib/db/migrations/` | — |

## Environment Variables

All secrets in root `.env` (gitignored). See `.env.example` for full list.
Key vars: `POSTGRES_*`, `JWT_SECRET`, `GOOGLE_CLIENT_ID`, `GEMINI_API_KEY`, `ORCID_*`, `GCN_CLIENT_ID`, `GCN_CLIENT_SECRET`.
