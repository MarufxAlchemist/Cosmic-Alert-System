# Transient Event Detection — Complete Project Analysis

> **Generated:** 2026-06-14  
> **Auditor roles:** Senior Software Architect · Technical Lead · DevOps Engineer · Security Auditor · Code Reviewer  
> **Branch:** `main` | **Commit:** `eda23db`

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Repository Structure](#2-repository-structure)
3. [Technology Stack](#3-technology-stack)
4. [System Architecture](#4-system-architecture)
5. [Database Analysis](#5-database-analysis)
6. [API Documentation](#6-api-documentation)
7. [Authentication & Authorization](#7-authentication--authorization)
8. [Environment Variables](#8-environment-variables)
9. [Dependency Analysis](#9-dependency-analysis)
10. [Bug Detection](#10-bug-detection)
11. [Performance Analysis](#11-performance-analysis)
12. [Security Audit](#12-security-audit)
13. [Feature Inventory](#13-feature-inventory)
14. [Technical Debt](#14-technical-debt)
15. [Deployment Analysis](#15-deployment-analysis)
16. [Improvement Roadmap](#16-improvement-roadmap)
17. [Final Scorecard](#17-final-scorecard)

---

## 1. Executive Summary

### Project Purpose

**Transient Event Detection** is a real-time, multi-messenger astrophysical event alert platform. It ingests high-priority transient alerts — Gravitational Waves (GW), Gamma-ray Bursts (GRB), Fast Radio Bursts (FRB), and Neutrinos (NU) — from NASA's General Coordinates Network (GCN) Kafka broker and presents them to astronomical research teams through a live, collaborative web dashboard.

### Core Functionality

- **Real-time ingestion** of GCN Kafka notices from 6 observatory topics (Swift-BAT, LIGO/Virgo/KAGRA, CHIME, IceCube, Einstein Probe)
- **Scientific quality filtering** — multi-gate pipeline rejects test triggers, sub-threshold events, retractions, MDC mock events, and noise
- **Live WebSocket streaming** — new events appear on the dashboard within seconds of GCN publication
- **PostgreSQL persistence** — complete event history with revision tracking for multi-notice events
- **Research collaboration** — multi-tenant lab model with team roles, bookmarks, annotations, and follow-up request management
- **Multi-provider authentication** — email/password, Google OAuth, and ORCID (academic identity) login

### Current Development Status

**Active development / pre-production.** Core data pipeline, backend infrastructure, and primary dashboard are functional. Collaboration features (team management, bookmarks, discussions) have backend routing wired but minimal frontend integration. Advanced features (pgvector semantic search, PostGIS spatial queries, TimescaleDB hypertables) are schema-defined but not yet populated or surfaced in the UI.

### Major Completed Features

- GCN Kafka consumer (Python FastAPI + asyncio)
- Scientific alert filter with per-source quality gates
- Node.js Express + WebSocket API server
- PostgreSQL schema across 8 namespaces (26 tables)
- Bootstrap seeding with historical event replay
- React dashboard with live event feed, science mode, lifecycle/tier badges
- JWT authentication with Google + ORCID OAuth
- Multi-tenant lab/team system backend
- Drizzle ORM migrations and type-safe queries
- pnpm monorepo workspace with shared libraries

### Major Incomplete Features

- Sun/Moon angular distance calculation (hardcoded placeholder `90°`)
- External link buttons (GCN, ALADIN, ESASky, TNS) are non-functional stubs
- Telescope follow-up request UI (backend schema complete, no frontend)
- Event localization FITS map viewer (schema complete, no UI)
- pgvector semantic similarity search (schema complete, no population logic)
- Observatory statistics in `/events/stats` response (`byObservatory` always returns `[]`)
- Proper `event_updated` handling in the frontend WebSocket hook

### Overall Architecture Overview

A **three-tier**, **real-time**, **multi-service** architecture:

```
GCN Kafka Broker (NASA)
        │ (Kafka protocol over TLS)
        ▼
Python FastAPI Backend (port 8001)
  • gcn-kafka consumer
  • Alert normalization (6 parsers)
  • Ring buffer (200 events)
  • WebSocket broadcast
        │ (WebSocket ws://localhost:8001/api/ws)
        ▼
Node.js Express API Server (port 8000)
  • Scientific quality filter
  • Drizzle ORM → PostgreSQL
  • REST API + WebSocket fanout
        │ (HTTP/WS)
        ▼
React Frontend (Vite, port 5173)
  • Live dashboard
  • Event archive
  • Auth / Team / Bookmarks
```

---

## 2. Repository Structure

### Complete Folder Tree

```
Cosmic-Alert-System/
│
├── backend/                          # Python GCN Kafka consumer service
│   ├── app/
│   │   ├── main.py                   # FastAPI app, lifespan, HTTP + WS endpoints
│   │   ├── gcn/
│   │   │   ├── consumer.py           # gcn-kafka Consumer wrapper
│   │   │   ├── normalizer.py         # Raw GCN JSON → AstroEvent (6 parsers)
│   │   │   ├── topics.py             # Topic metadata & configuration
│   │   │   └── background_listener.py# Async Kafka poll + heartbeat loops
│   │   ├── websocket/
│   │   │   └── manager.py            # ConnectionManager, AlertRingBuffer
│   │   └── ingest/                   # (empty / unused)
│   ├── scripts/
│   │   └── import_archive_to_postgres.py  # (untracked) archive import util
│   ├── historical_events_2026.json   # (untracked) archive data
│   ├── test_consumer.py              # Manual Kafka consumer test
│   ├── requirements.txt              # Python dependencies
│   └── venv/                         # Python virtual environment (not in git)
│
├── artifacts/                        # Deployable application packages (pnpm workspace)
│   │
│   ├── api-server/                   # Node.js REST + WebSocket API server
│   │   ├── src/
│   │   │   ├── index.ts              # HTTP server, WSS setup, bootstrap call
│   │   │   ├── app.ts                # Express config (middleware, router)
│   │   │   ├── middlewares/
│   │   │   │   └── auth.ts           # requireAuth, requireAdmin, signToken
│   │   │   ├── routes/
│   │   │   │   ├── index.ts          # Route aggregator
│   │   │   │   ├── health.ts         # GET /healthz
│   │   │   │   ├── events.ts         # GET /events, /events/stats, /events/:id
│   │   │   │   ├── auth.ts           # POST /auth/register, /login, /google, /orcid
│   │   │   │   ├── team.ts           # Lab/team CRUD
│   │   │   │   ├── bookmarks.ts      # Event bookmarks
│   │   │   │   ├── discussions.ts    # Event discussion threads
│   │   │   │   ├── notes.ts          # Lab notes
│   │   │   │   └── filterReport.ts   # GET /filter-report
│   │   │   └── lib/
│   │   │       ├── kafkaConsumer.ts  # WS bridge to Python backend
│   │   │       ├── alertFilter.ts    # Per-source scientific quality gates
│   │   │       ├── bootstrap.ts      # Startup seed from recent_events.json
│   │   │       ├── eventBroadcaster.ts # WS fanout to frontend clients
│   │   │       ├── eventIngestion.ts # NO-OP stub (legacy, kept for import compat)
│   │   │       ├── filterReport.ts   # In-memory filter statistics tracker
│   │   │       └── logger.ts         # Pino logger config
│   │   ├── recent_events.json        # Bootstrap seed data (10 historical events)
│   │   ├── build.mjs                 # esbuild bundler config
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── astro-sentinel/               # React/Vite frontend
│       ├── src/
│       │   ├── main.tsx              # React DOM entry point
│       │   ├── App.tsx               # Provider stack + router
│       │   ├── pages/
│       │   │   ├── dashboard.tsx     # Primary live event dashboard ← MODIFIED
│       │   │   ├── EventsPage.tsx    # Event archive list
│       │   │   ├── EventDetailPage.tsx  # Single event detail
│       │   │   ├── WorkspacePage.tsx  # Research workspace
│       │   │   ├── BookmarksPage.tsx  # Saved events
│       │   │   ├── TeamPage.tsx       # Team management
│       │   │   ├── LoginPage.tsx      # Auth page
│       │   │   ├── DebugWsPage.tsx    # WebSocket debug tool (public)
│       │   │   └── NotFoundPage.tsx
│       │   ├── components/
│       │   │   ├── ui/               # 40+ shadcn/ui primitives
│       │   │   ├── SciencePanel.tsx  # Science data display panel
│       │   │   ├── Navbar.tsx
│       │   │   └── ...               # ~60 total components
│       │   ├── hooks/
│       │   │   ├── useAstroWebSocket.ts  # WS client, reconnect, dedup
│       │   │   └── ...
│       │   ├── lib/
│       │   │   ├── AuthContext.tsx    # JWT auth state
│       │   │   ├── ScienceModeContext.tsx
│       │   │   ├── formatters.ts     # Date/latency formatters
│       │   │   └── ...
│       │   └── index.css             # Tailwind v4 base styles
│       ├── vite.config.ts
│       ├── components.json           # shadcn/ui config
│       ├── package.json
│       └── tsconfig.json
│
├── lib/                              # Shared workspace libraries
│   ├── db/                           # Drizzle ORM database layer
│   │   ├── src/
│   │   │   ├── index.ts              # db pool export
│   │   │   └── schema/
│   │   │       ├── events.ts         # core.* (7 tables + relations)
│   │   │       ├── tenant.ts         # tenant.* (3 tables)
│   │   │       ├── identity.ts       # identity.* (3 tables)
│   │   │       ├── catalog.ts        # catalog.* (2 tables)
│   │   │       ├── alerts.ts         # alerts.* (1 table)
│   │   │       ├── metrics.ts        # metrics.* (1 table)
│   │   │       └── audit.ts          # audit.* (1 table)
│   │   ├── drizzle.config.ts
│   │   └── migrations/               # Auto-generated SQL migrations
│   │
│   ├── api-client-react/             # TanStack Query hooks generated from OpenAPI
│   ├── api-zod/                      # Zod validation schemas (OpenAPI-generated)
│   └── api-spec/                     # OpenAPI spec (orval.config.ts)
│
├── scripts/                          # Build utilities
├── historical_events.json            # (untracked) Raw historical archive
├── gcn_archive.json.tar.gz           # (untracked) Compressed GCN archive
├── ingest_gcn_archive.py             # (untracked) Archive ingest script
├── .env                              # Local environment variables ⚠️ SENSITIVE
├── .npmrc                            # pnpm settings
├── pnpm-workspace.yaml               # Workspace package paths + catalog
├── pnpm-lock.yaml                    # Locked dependency tree
├── tsconfig.base.json                # Base TypeScript config
├── package.json                      # Root workspace manifest
└── run-commands.txt                  # Developer startup cheatsheet
```

### Notable Observations

| Finding | Location | Severity |
|---------|----------|----------|
| **Dead code** — `eventIngestion.ts` is a no-op stub, still imported and called | `api-server/src/index.ts:9,88` | Low |
| **Unused directory** — `backend/app/ingest/` is empty | `backend/app/ingest/` | Low |
| **Duplicate packages** — both `bcrypt` and `bcryptjs` are installed | `api-server/package.json` | Medium |
| **Untracked sensitive files** — `historical_events_2026.json`, archive scripts in repo root | Root, `backend/scripts/` | Medium |
| **No `.gitignore` review** — `.env` with real credentials is present | `.env` | Critical |

---

## 3. Technology Stack

### Frontend

| Category | Technology | Version |
|----------|-----------|---------|
| **Framework** | React | 19.1.0 |
| **Build Tool** | Vite | ^7.3.2 |
| **Routing** | Wouter | ^3.3.5 |
| **State Management** | TanStack React Query | ^5.90.21 |
| **Styling** | TailwindCSS v4 | catalog |
| **UI Primitives** | Radix UI (20+ packages) | Various |
| **Component Library** | shadcn/ui (local) | — |
| **Forms** | React Hook Form + Zod | ^7.55 / catalog |
| **Animations** | Framer Motion | catalog |
| **Charts** | Recharts | ^2.15.2 |
| **Data Viz** | D3.js | ^7.9.0 |
| **Date Utils** | date-fns | ^3.6.0 |
| **Auth (Google)** | @react-oauth/google | ^0.13.5 |
| **Icons** | Lucide React + react-icons | catalog / ^5.4 |
| **Notifications** | Sonner | ^2.0.7 |
| **Theme** | next-themes | ^0.4.6 |

### Backend (Node.js API Server)

| Category | Technology | Version |
|----------|-----------|---------|
| **Runtime** | Node.js (ESM) | ≥18 |
| **Framework** | Express | ^5 |
| **WebSocket** | ws | ^8.20.0 |
| **ORM** | Drizzle ORM | ^0.45.2 |
| **Database Driver** | pg (via Drizzle) | — |
| **Logging** | Pino + pino-http | ^9 / ^10 |
| **Auth / JWT** | jsonwebtoken | ^9.0.3 |
| **Password Hash** | bcryptjs | ^3.0.3 |
| **OAuth** | google-auth-library | ^10.7.0 |
| **Build** | esbuild | ^0.27.3 |
| **Validation** | Zod (via api-zod) | catalog |
| **CORS** | cors | ^2 |

### Backend (Python GCN Consumer)

| Category | Technology |
|----------|-----------|
| **Runtime** | Python 3.11+ |
| **Framework** | FastAPI |
| **ASGI Server** | uvicorn |
| **Kafka Client** | gcn-kafka |
| **Async** | asyncio |
| **WS Server** | FastAPI WebSockets |

### Database

| Category | Technology |
|----------|-----------|
| **RDBMS** | PostgreSQL 14+ |
| **ORM** | Drizzle ORM |
| **Migrations** | drizzle-kit (push/generate) |
| **Extensions** | pgvector, PostGIS, ltree, TimescaleDB |
| **Query Strategy** | Prepared statements via Drizzle |
| **Schemas** | 8 namespaces: `core`, `tenant`, `identity`, `catalog`, `alerts`, `metrics`, `audit`, `public` |

### Infrastructure

| Category | Technology | Notes |
|----------|-----------|-------|
| **Package Manager** | pnpm 9+ (workspace) | Catalog versioning |
| **Monorepo** | pnpm workspaces | `artifacts/*`, `lib/*` |
| **TypeScript** | ~5.9.2 | Strict config |
| **CI/CD** | None configured | ⚠️ Missing |
| **Containerization** | None configured | ⚠️ Missing |
| **Monitoring** | None configured | ⚠️ Missing |
| **Hosting** | Local dev only | No cloud deployment |

---

## 4. System Architecture

### High-Level Architecture

```mermaid
flowchart TB
    GCN[GCN Kafka Broker\nNASA / IGWN]
    
    subgraph PY["Python Backend (port 8001)"]
        KC[gcn-kafka Consumer]
        NRM[Normalizer\n6 parsers]
        BUF[Ring Buffer\n200 events]
        WM[WebSocket Manager]
        FA[FastAPI HTTP]
    end
    
    subgraph NODE["Node.js API Server (port 8000)"]
        KBR[Kafka Bridge\nkafkaConsumer.ts]
        QF[Quality Filter\nalertFilter.ts]
        DB_W[Drizzle ORM]
        WS[WebSocket Server\nfanout to clients]
        REST[Express REST API]
        BS[Bootstrap Seeder]
    end
    
    subgraph PG["PostgreSQL"]
        CORE[core.*\nevents + 6 tables]
        TENANT[tenant.*]
        IDENT[identity.*]
    end
    
    subgraph FE["React Frontend (port 5173)"]
        DASH[Dashboard]
        EVT[Events Archive]
        AUTH[Auth Pages]
        HOOK[useAstroWebSocket]
        RQ[React Query]
    end
    
    GCN -->|Kafka TLS| KC
    KC --> NRM --> BUF --> WM
    WM -->|WS alerts| KBR
    KBR -->|raw payload| QF
    QF -->|accept| DB_W --> CORE
    DB_W --> WS
    WS -->|WS broadcast| HOOK
    REST --> RQ
    BS -->|startup seed| CORE
    CORE --> REST
    RQ --> DASH
    HOOK --> DASH
    IDENT --> REST
    TENANT --> REST
```

### Request Flow (New Kafka Alert)

```
1. GCN publishes alert to Kafka topic (e.g., igwn.gwalert)
2. Python consumer.consume() polls → receives raw JSON bytes
3. normalizer.normalize(topic, raw) → AstroEvent dict
4. manager.broadcast(envelope) → sent to all WS clients
   └─ Node.js kafkaConsumer.ts receives alert via WS
5. applyAlertFilter(topic, rawPayload) → AcceptVerdict | RejectVerdict
   ├─ REJECT → recordRejected(), log, return
   └─ ACCEPT → continue
6. db.insert(eventsTable).onConflictDoUpdate() → PostgreSQL upsert
   ├─ NEW → revisionCount=0, broadcastEvent()
   └─ REVISION → revisionCount+1, broadcastEventUpdate()
7. broadcastEvent/Update → wss.clients.forEach(client.send())
8. Frontend useAstroWebSocket → receives "alert" message
9. Dashboard allEvents memo re-derives → SidebarItem renders
```

### Frontend Architecture

```mermaid
flowchart LR
    subgraph Providers
        A[GoogleOAuthProvider]
        B[QueryClientProvider]
        C[AuthProvider]
        D[ThemeProvider]
        E[ScienceModeProvider]
        F[NotificationsProvider]
    end

    subgraph Router
        R1["/ → Dashboard"]
        R2["/events → Archive"]
        R3["/events/:id → Detail"]
        R4["/events/:id/workspace"]
        R5["/bookmarks"]
        R6["/team"]
        R7["/login"]
        R8["/debug/ws"]
    end

    subgraph Hooks
        WS[useAstroWebSocket\nWS reconnect + dedup]
        LQ[useListEvents\nReact Query REST]
        SQ[useGetEventStats\nReact Query]
    end

    Providers --> Router
    Router --> R1
    R1 --> WS
    R1 --> LQ
    R1 --> SQ
```

### Database Architecture

```mermaid
erDiagram
    "tenant.labs" {
        uuid id PK
        text slug UK
        text name
        text plan
        jsonb settings
        bool is_active
    }

    "identity.users" {
        uuid id PK
        text email UK
        text password_hash
        text provider
        text orcid_id
        bool email_verified
        jsonb settings
    }

    "tenant.lab_members" {
        uuid lab_id FK
        uuid user_id FK
        text role
    }

    "core.events" {
        bigint id PK
        uuid lab_id FK
        text event_id UK
        text event_type
        timestamptz detection_time
        float8 ra
        float8 dec
        text sky_position
        float8 error_radius
        float8 snr
        float8 far
        text lifecycle
        text observatory
        bool is_historical
        int revision_count
    }

    "core.event_detections" {
        bigint id PK
        bigint event_id FK
        uuid lab_id FK
        bigint observatory_id FK
        timestamptz detected_at
    }

    "core.event_localizations" {
        bigint id PK
        bigint event_id FK
        text method
        text fits_url
        bool is_latest
    }

    "core.event_classifications" {
        bigint id PK
        bigint event_id FK
        text classifier
        float4 prob_bns
        float4 prob_bbh
        bool has_ns
    }

    "core.event_annotations" {
        bigint id PK
        bigint event_id FK
        uuid user_id FK
        text content
        bigint parent_id FK
    }

    "catalog.observatories" {
        bigint id PK
        text name
        text instrument_type
    }

    "tenant.labs" ||--o{ "core.events" : "labId"
    "identity.users" ||--o{ "tenant.lab_members" : "userId"
    "tenant.labs" ||--o{ "tenant.lab_members" : "labId"
    "core.events" ||--o{ "core.event_detections" : "eventId"
    "core.events" ||--o{ "core.event_localizations" : "eventId"
    "core.events" ||--o{ "core.event_classifications" : "eventId"
    "core.events" ||--o{ "core.event_annotations" : "eventId"
    "identity.users" ||--o{ "core.event_annotations" : "userId"
    "catalog.observatories" ||--o{ "core.event_detections" : "observatoryId"
```

---

## 5. Database Analysis

### Schema Overview (8 namespaces, 18+ tables)

#### `core` Schema — Astrophysical Event Data

**`core.events`** — Primary event table (the most important table)

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | bigserial | PK | Auto-increment |
| `lab_id` | uuid | NOT NULL, FK→labs | Multi-tenant isolation |
| `event_id` | text | NOT NULL, UNIQUE | GCN event identifier |
| `event_type` | text | NOT NULL | GRB / GW / FRB / NU |
| `detection_time` | timestamptz | NOT NULL | Original observatory time |
| `ra` | float8 | NOT NULL | Right ascension [°] |
| `dec` | float8 | NOT NULL | Declination [°] |
| `sky_position` | geography(POINT) | Computed | ST_MakePoint(ra,dec) via trigger |
| `error_radius` | float8 | NOT NULL | Localization uncertainty [arcmin] |
| `snr` | float8 | NOT NULL | Signal-to-noise ratio |
| `far` | float8 | NOT NULL | False alarm rate [Hz] |
| `fluence` | float8 | Nullable | GRB-specific [erg/cm²] |
| `t90` | float8 | Nullable | GRB duration [s] |
| `dm` | float8 | Nullable | FRB dispersion measure [pc/cm³] |
| `chirp_mass` | float8 | Nullable | GW chirp mass [M☉] |
| `luminosity_distance` | float8 | Nullable | GW distance [Mpc] |
| `gal_lat` | float8 | NOT NULL | Galactic latitude |
| `gal_lon` | float8 | NOT NULL | Galactic longitude |
| `sun_distance` | float8 | NOT NULL | Angular distance from Sun [°] — ⚠️ HARDCODED 90° |
| `moon_distance` | float8 | NOT NULL | Angular distance from Moon [°] — ⚠️ HARDCODED 90° |
| `latency_us` | bigint | NOT NULL | μs from detection to API receipt |
| `lifecycle` | text | NOT NULL, default 'preliminary' | preliminary/initial/update/confirmed |
| `alert_type` | text | Nullable | Raw alert_type from source |
| `classification_tier` | text | Nullable | GOLD / BRONZE (IceCube) |
| `observatory` | text | NOT NULL, default 'Unknown' | Source instrument name |
| `is_retraction` | bool | NOT NULL, default false | Retraction flag |
| `source` | text | NOT NULL, default 'kafka' | kafka / bootstrap / historical |
| `is_historical` | bool | NOT NULL, default false | Bootstrap seed marker |
| `revision_count` | int | NOT NULL, default 0 | Update counter |
| `latest_revision` | text | Nullable | Most recent alert_type string |
| `ingested_by` | uuid | FK→users, Nullable | Who ingested this |
| `created_at` | timestamptz | NOT NULL, defaultNow() | |
| `updated_at` | timestamptz | NOT NULL, defaultNow() | |

**Indexes on `core.events`:**
- `(id)` — Primary key (B-tree)
- `(event_id)` — Unique index (upsert target)
- `(detection_time DESC)` — Recommended for time-ordered list queries
- `(event_type)` — Recommended for type filtering
- `(sky_position)` — GiST index for PostGIS cone search (defined in migration SQL)

**`core.event_detections`** — TimescaleDB hypertable for multi-observatory detections of the same event

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigserial PK | |
| `event_id` | bigint FK→events.id | |
| `lab_id` | uuid FK→labs.id | |
| `observatory_id` | bigint FK→observatories.id | |
| `detected_at` | timestamptz | **Hypertable partition key** |
| `ra`, `dec`, `error_radius`, `snr`, `far` | float8 | Refined coordinates |
| `pipeline_version` | text | |
| `raw_payload` | jsonb | Full raw GCN notice |

**`core.event_localizations`** — HEALPix sky map metadata (FITS URL reference)

| Column | Type | Notes |
|--------|------|-------|
| `fits_url` | text NOT NULL | External FITS file URL |
| `nside` | int | HEALPix resolution |
| `area_50_deg2`, `area_90_deg2` | real | Credible region areas |
| `vol_50_mpc3`, `vol_90_mpc3` | float8 | 3D volume (GW only) |
| `lineage` | ltree | Hierarchical localization path |
| `is_latest` | bool | Version control flag |

**`core.event_classifications`** — CBC probability outputs (GW)

| Column | Type | Notes |
|--------|------|-------|
| `classifier` | text | gstlal, cbc, etc. |
| `prob_bns`, `prob_nsbh`, `prob_bbh`, `prob_mass_gap`, `prob_terrestrial` | real | Classification probabilities |
| `has_ns`, `has_remnant` | bool | |

**`core.event_followup_requests`** — Telescope observation requests

| Column | Notes |
|--------|-------|
| `event_id`, `observatory_id`, `requested_by` | FK references |
| `priority`, `status` | normal/urgent, pending/accepted/rejected |
| `exposure_time_s`, `filter_band` | Observation parameters |
| `expires_at`, `responded_at` | Scheduling |

**`core.event_annotations`** — Threaded comments per event

| Column | Notes |
|--------|-------|
| `parent_id` | Self-referential for thread replies |
| `tags` | text[] for hashtags |
| `is_pinned` | Boolean |
| `deleted_at` | Soft delete |

**`core.event_embeddings`** — pgvector semantic embeddings (unpopulated)

| Column | Notes |
|--------|-------|
| `embedding` | 1536-dim stored as text (should be `vector(1536)`) |
| `model_name`, `model_version` | Embedding model metadata |
| `input_features` | text[] feature list |

HNSW index: `CREATE INDEX USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64)` — defined in migration SQL.

#### `tenant` Schema — Multi-tenancy

**`tenant.labs`**

| Column | Notes |
|--------|-------|
| `slug` | UNIQUE, URL-friendly identifier |
| `plan` | free / pro / enterprise |
| `max_users`, `max_events_per_day` | Quota limits |
| `settings` | jsonb team config |

**`tenant.lab_members`** — Composite PK `(lab_id, user_id)`, role: researcher/admin/viewer

**`tenant.lab_invitations`** — Email invitations with expiry

**`tenant.event_bookmarks`** — User-scoped event bookmarks with personal notes

#### `identity` Schema — Authentication

**`identity.users`** — Supports local, Google, ORCID providers

**`identity.sessions`** — Token-based sessions (not currently used — JWT is stateless)

**`identity.api_keys`** — Hashed scoped API keys (schema only, no routes)

#### `catalog` Schema — Observatory Metadata

**`catalog.observatories`** + **`catalog.observatory_capabilities`** — Instrument registry

#### `alerts` Schema

**`alerts.alert_subscriptions`** — User alert preferences with channel config (email, push, webhook) — schema only, no routing

#### `metrics` Schema

**`metrics.event_metrics`** — Aggregate event statistics — schema only

#### `audit` Schema

**`audit.audit_logs`** — Change log with old/new JSONB values — schema only (no trigger wired)

### Missing Indexes

| Table | Missing Index | Impact |
|-------|--------------|--------|
| `core.events` | `(lab_id)` — all queries filter by lab | High |
| `core.events` | `(source)` — bootstrap vs kafka filter | Medium |
| `core.events` | `(lifecycle)` — dashboard filters by lifecycle | Medium |
| `core.event_annotations` | `(event_id, deleted_at)` | Medium |
| `identity.users` | `(orcid_id)` — ORCID login lookup | Medium |
| `tenant.lab_invitations` | `(email, status)` — invitation check on every registration | High |

### Potential Performance Bottlenecks

1. **No lab_id index** — Every event query implicitly filters by `lab_id` through the multi-tenant model, but no index exists on this column.
2. **`byObservatory` is hardcoded `[]`** — The stats endpoint returns an empty array for observatory breakdown because the GROUP BY query was removed.
3. **`recentRate` raw SQL** — `WHERE created_at > now() - interval '1 hour'` benefits from an index on `created_at`.
4. **Bootstrap count query on startup** — `SELECT count(*) FROM core.events` on every startup; safe but could be slow on large datasets.

---

## 6. API Documentation

### Base URL

Development: `http://localhost:8000/api`

### REST Endpoints

---

#### `GET /healthz`

**Purpose:** Health check  
**Auth:** None  
**Response:**
```json
{ "status": "ok" }
```

---

#### `GET /events`

**Purpose:** Paginated list of events from the database  
**Auth:** None (should be protected — see Security section)  
**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | int | 50 | Max results per page |
| `offset` | int | 0 | Pagination offset |
| `eventType` | string | — | Filter: GRB / GW / FRB / NU |

**Response:**
```json
{
  "events": [
    {
      "id": "1",
      "eventId": "GRB20260614T120000Z",
      "eventType": "GRB",
      "observatory": "Swift (BAT)",
      "detectionTime": "2026-06-14T12:00:00.000Z",
      "ra": 123.456,
      "dec": 45.678,
      "errorRadius": 2.5,
      "snr": 15.3,
      "far": 1e-7,
      "fluence": 1.23e-6,
      "dm": null,
      "galLat": -25.1,
      "galLon": 180.5,
      "sunDistance": 90.0,
      "moonDistance": 90.0,
      "latencyUs": "2500000",
      "createdAt": "2026-06-14T12:00:02.000Z",
      "lifecycle": "preliminary",
      "alertType": "ALERT",
      "classificationTier": null,
      "isHistorical": false,
      "source": "kafka"
    }
  ],
  "total": 42
}
```

**Missing:** No filtering by `observatory`, `lifecycle`, `source`, or date range. No sorting options.

---

#### `GET /events/stats`

**Purpose:** Aggregate statistics for the stats strip  
**Auth:** None  
**Response:**
```json
{
  "totalEvents": 42,
  "byType": { "GRB": 20, "GW": 10, "FRB": 12 },
  "byObservatory": [],
  "recentRate": 3,
  "latestEvent": { ...event }
}
```
**Known Bug:** `byObservatory` always returns `[]`. `NU` (neutrino) count is not included in `byType`.

---

#### `GET /events/:id`

**Purpose:** Single event by numeric ID  
**Auth:** None  
**Path Params:** `id` — numeric integer  
**Response:** Same shape as single event object above  
**Errors:**
```json
{ "error": "Event not found" }   // 404
{ "error": "ID must be numeric" } // 400
```

---

#### `POST /auth/register`

**Purpose:** Email/password user registration (first user becomes admin; subsequent users require invitation)  
**Auth:** None  
**Request:**
```json
{ "email": "user@example.com", "password": "password123", "name": "Dr. Smith" }
```
**Response (201):**
```json
{ "token": "<JWT>", "user": { "id": "...", "email": "...", "name": "...", "role": "researcher" } }
```
**Errors:** 400 (missing fields, bad email, short password), 403 (no invitation), 409 (email exists)

---

#### `POST /auth/login`

**Purpose:** Email/password login  
**Request:** `{ "email": "...", "password": "..." }`  
**Response:** `{ "token": "<JWT>", "user": {...} }`  
**Errors:** 400 (missing fields), 401 (invalid credentials)

---

#### `POST /auth/google`

**Purpose:** Google OAuth login/registration via ID token  
**Request:** `{ "token": "<Google ID token>" }`  
**Response:** `{ "token": "<JWT>", "user": {...} }`

---

#### `POST /auth/orcid`

**Purpose:** ORCID OAuth login/registration via authorization code  
**Request:** `{ "code": "<auth code>", "redirectUri": "https://..." }`  
**Response:** `{ "token": "<JWT>", "user": { ...includes "orcidId" } }`

---

#### `GET /auth/me`

**Purpose:** Get current user from JWT  
**Auth:** Bearer token required  
**Response:** `{ "userId": "...", "email": "...", "role": "..." }`

---

#### `GET /filter-report`

**Purpose:** Real-time filter statistics (accepted/rejected by topic and category)  
**Auth:** None  
**Response:**
```json
{
  "uptimeSeconds": 3600,
  "totalReceived": 100,
  "totalAccepted": 45,
  "totalRejected": 55,
  "acceptRate": 45.0,
  "byTopic": { "igwn.gwalert": { "received": 10, "accepted": 5, "rejected": 5 } },
  "rejectedByCategory": { "test_trigger": 20, "sub_threshold": 15 },
  "rejectedByReason": [{ "reason": "...", "count": 5, "topic": "...", "lastEventId": "..." }]
}
```

---

### WebSocket Endpoint

**URL:** `ws://localhost:8000/api/ws`

#### Server → Client Messages

| Type | When | Key Fields |
|------|------|-----------|
| `connection_ack` | On connect | `session_id`, `subscribed_topics`, `heartbeat_interval` |
| `alert` | New GCN event accepted | `sequence`, `event`, `notification.priority` |
| `event_updated` | Existing event revised | `sequence`, `event` (with updated `revision_count`) |
| `heartbeat` | Every 30s | `listener_alive`, `kafka_connected` (always `true` — see Bug #3) |

#### Client → Server Messages

| Type | Purpose |
|------|---------|
| `ping` | Keep-alive / RTT check → server responds with `pong` |
| `history_request` | Request buffered events since ISO timestamp |
| `ack` | Guaranteed-delivery acknowledgement (reserved, no-op in v1) |

---

### Python Backend Endpoints (port 8001 — internal)

These are internal-only endpoints; the frontend does not call them directly.

| Endpoint | Notes |
|----------|-------|
| `GET /` | Status check |
| `GET /health` | Health probe |
| `GET /api/events` | Reads `historical_events.json` directly (not DB) — bypassed by Node.js layer |
| `GET /api/events/stats` | Reads `historical_events.json` directly — bypassed |
| `WS /api/ws` | The real consumer endpoint — Node.js connects here |

---

## 7. Authentication & Authorization

### Authentication Flow

```
Email/Password Login
─────────────────────
POST /auth/login
  → validate email + password
  → bcrypt.compare(password, hash) [12 rounds]
  → SELECT user + lab_members for role
  → jwt.sign({ userId, email, role }, JWT_SECRET, { expiresIn: "7d" })
  → return { token, user }

Google OAuth
────────────
Client: Google One Tap → id_token
POST /auth/google { token }
  → googleClient.verifyIdToken(token, audience: GOOGLE_CLIENT_ID)
  → Extract email, name from ticket payload
  → Lookup user by email
  → If missing: check invitation OR first-user auto-admin
  → Insert user, join lab, assign role
  → jwt.sign(...) → return token

ORCID OAuth
───────────
Client: ORCID redirect → authorization code
POST /auth/orcid { code, redirectUri }
  → Fetch https://orcid.org/oauth/token (exchange code)
  → Decode id_token (JWT) to extract email
  → Lookup by orcid_id → then by email → then create new
  → Invitation check for non-first-users
  → jwt.sign(...) → return token
```

### Authorization Model

| Endpoint | Auth Level | Notes |
|----------|-----------|-------|
| `GET /events` | ❌ None | Should require Bearer token |
| `GET /events/stats` | ❌ None | Should require Bearer token |
| `GET /events/:id` | ❌ None | Should require Bearer token |
| `GET /healthz` | ✅ None (correct) | Public health check |
| `GET /auth/me` | ✅ Bearer required | Uses `requireAuth` middleware |
| `GET /filter-report` | ❌ None | Should be admin-only |
| Team routes | ✅ Bearer required | Uses `requireAuth` |
| Bookmarks routes | ✅ Bearer required | Uses `requireAuth` |

### Role Model

| Role | Description |
|------|-------------|
| `admin` | Full access; first registered user |
| `researcher` | Standard researcher access |
| `viewer` | Read-only (schema defined, not enforced in routes) |

### JWT Configuration

- **Algorithm:** HS256 (jsonwebtoken default)
- **Expiry:** 7 days
- **Secret:** `JWT_SECRET` env var; falls back to `"astrosentinel-dev-secret"` if unset ⚠️
- **Storage:** Client-side (localStorage assumed via AuthContext)
- **Refresh:** No refresh token mechanism

### Security Vulnerabilities in Auth

1. **No rate limiting** on `/auth/login` — brute force possible
2. **JWT fallback secret** `"astrosentinel-dev-secret"` if `JWT_SECRET` not set
3. **Events API unprotected** — any unauthenticated request can list/read all events
4. **ORCID error leaks** — `console.error("ORCID auth error:", error)` sends full error to stdout, potentially including secrets
5. **`jwt.decode(id_token)`** without verification in ORCID flow — attacker could send a crafted id_token to poison the email field if the `orcid.org/oauth/token` endpoint is not strictly TLS-verified

---

## 8. Environment Variables

### Complete Variable Reference

| Variable | Required | Example | Used In | Notes |
|----------|----------|---------|---------|-------|
| `DATABASE_URL` | **Required** | `postgresql://user:pass@host:5432/dbname` | `lib/db`, api-server | Postgres connection string |
| `JWT_SECRET` | **Required** | 64-char random hex | `api-server/middlewares/auth.ts` | Falls back to insecure default if missing |
| `PORT` | **Required** | `8000` | `api-server/src/index.ts` | Server crashes without it |
| `PYTHON_BACKEND_URL` | Optional | `ws://localhost:8001/api/ws` | `kafkaConsumer.ts` | Defaults to localhost:8001 |
| `GOOGLE_CLIENT_ID` | Optional | `123456.apps.googleusercontent.com` | `api-server/routes/auth.ts` | Google OAuth |
| `VITE_GOOGLE_CLIENT_ID` | Optional | Same as above | `astro-sentinel` (Vite) | Frontend Google OAuth |
| `ORCID_CLIENT_ID` | Optional | `APP-XXXXXXXXXXXX` | `api-server/routes/auth.ts` | ORCID OAuth |
| `ORCID_CLIENT_SECRET` | Optional | `xxxx-xxxx-xxxx` | `api-server/routes/auth.ts` | ORCID OAuth secret |
| `VITE_ORCID_CLIENT_ID` | Optional | Same as `ORCID_CLIENT_ID` | `astro-sentinel` (Vite) | Frontend ORCID |
| `LOG_LEVEL` | Optional | `info` | `api-server/lib/logger.ts` | debug/info/warn/error |
| `NODE_ENV` | Optional | `development` | Build tools | Enables pino-pretty in dev |
| `GCN_CLIENT_ID` | Optional | (from gcn.nasa.gov) | Python backend | Kafka credentials |
| `GCN_CLIENT_SECRET` | Optional | (from gcn.nasa.gov) | Python backend | Kafka credentials |

### Generated `.env.example`

```dotenv
# ─── Database ─────────────────────────────────────────────────────────────────
# PostgreSQL connection string. URL-encode special chars in password (e.g. @ → %40)
DATABASE_URL=postgresql://postgres:password@localhost:5432/astro-sentinel

# ─── API Server ───────────────────────────────────────────────────────────────
# Port for the Node.js Express + WebSocket server
PORT=8000

# ─── Authentication ───────────────────────────────────────────────────────────
# Long random string for JWT signing. Generate with: openssl rand -hex 64
JWT_SECRET=replace_with_64_char_random_hex_string

# ─── Google OAuth ─────────────────────────────────────────────────────────────
GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
VITE_GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com

# ─── ORCID OAuth ──────────────────────────────────────────────────────────────
ORCID_CLIENT_ID=APP-XXXXXXXXXXXXXXXXXXXX
ORCID_CLIENT_SECRET=your-orcid-client-secret
VITE_ORCID_CLIENT_ID=APP-XXXXXXXXXXXXXXXXXXXX

# ─── Service URLs ─────────────────────────────────────────────────────────────
# URL of the Python GCN Kafka consumer backend (internal service)
PYTHON_BACKEND_URL=ws://localhost:8001/api/ws

# ─── Logging ──────────────────────────────────────────────────────────────────
LOG_LEVEL=info
NODE_ENV=development

# ─── GCN Kafka (Python backend only) ──────────────────────────────────────────
# Register at https://gcn.nasa.gov/quickstart to obtain these credentials
GCN_CLIENT_ID=your_gcn_client_id
GCN_CLIENT_SECRET=your_gcn_client_secret
```

---

## 9. Dependency Analysis

### Node.js (api-server)

| Package | Status | Notes |
|---------|--------|-------|
| `bcrypt` + `bcryptjs` | ⚠️ **Duplicate** | Both installed; only `bcryptjs` is imported in code. Remove `bcrypt`. |
| `cookie-parser` | ⚠️ **Unused** | Installed, never imported in any source file |
| `express` ^5 | ✅ Current | Express 5 is RC/stable |
| `ws` ^8 | ✅ Current | |
| `drizzle-orm` ^0.45.2 | ✅ Current | |
| `pino` ^9 | ✅ Current | |
| `jsonwebtoken` ^9 | ✅ Current | |
| `google-auth-library` ^10 | ✅ Current | |
| `esbuild` ^0.27 | ✅ Current | |
| `pino-pretty` | Dev only | Correct placement |

### React Frontend (astro-sentinel)

| Package | Status | Notes |
|---------|--------|-------|
| `d3` + `@types/d3` | ⚠️ **Potentially unused** | No D3 code found in reviewed files; may be pulled in transitively or planned |
| `embla-carousel-react` | ⚠️ **Potentially unused** | Shadcn/ui carousel dep; verify if carousel component is used |
| `react-day-picker` | ⚠️ **Potentially unused** | Shadcn/ui date-picker dep |
| `input-otp` | ⚠️ **Potentially unused** | Shadcn/ui OTP dep |
| `react-resizable-panels` | ⚠️ **Potentially unused** | Verify usage in workspace panel |
| `next-themes` | ✅ Used | Theme provider |
| `framer-motion` | ✅ Used | Animations |
| `recharts` | ✅ Used | Charts in SciencePanel |
| `wouter` | ✅ Used | Routing |
| `sonner` | ✅ Used | Toast notifications |

### Python Backend

| Package | Status | Notes |
|---------|--------|-------|
| `gcn-kafka` | ✅ Core | GCN Kafka client |
| `fastapi` | ✅ Current | |
| `uvicorn` | ✅ Current | |
| `astropy` | ❓ Missing | Needed for sun/moon distance calculation |
| `ephem` | ❓ Missing | Alternative for sun/moon calculation |

### Vulnerability Assessment

No explicit `npm audit` output was available in the scan. Recommend running:
```bash
pnpm audit --recursive
```

Known risk areas:
- `jsonwebtoken` — verify ≥9.0.0 (fixes algorithm confusion attacks)
- `bcrypt` — native addon; ensure compatible Node.js version

---

## 10. Bug Detection

### Bug #1 — Hardcoded `kafka_connected: true` in Node.js heartbeat

**File:** `artifacts/api-server/src/index.ts:61-68`  
**Severity:** Medium  
**Description:** The WebSocket heartbeat sent from the Node.js server always reports `kafka_connected: true` regardless of whether the Python backend bridge is actually connected. Clients (frontend) use this field to display connection status.

```typescript
// BUGGY — always true, never reflects actual state
ws.send(JSON.stringify({
  type: "heartbeat",
  kafka_connected: true,  // ← hardcoded
  last_alert_at: null,    // ← always null
  last_sequence: null,    // ← always null
}));
```

**Fix:** Import and call `isKafkaBridgeConnected()` from `kafkaConsumer.ts`:
```typescript
import { isKafkaBridgeConnected } from "./lib/kafkaConsumer";
// ...
kafka_connected: isKafkaBridgeConnected(),
```

---

### Bug #2 — `byObservatory` hardcoded to empty array

**File:** `artifacts/api-server/src/routes/events.ts:102`  
**Severity:** Medium  
**Description:** The `/events/stats` endpoint always returns `byObservatory: []`. The comment says "observatory column was removed" but it exists in the schema as `observatory text NOT NULL`. The frontend's ScienceMode stats strip loops over this array to display per-observatory counts — it always shows nothing.

```typescript
byObservatory: [], // observatory column was removed  ← incorrect comment
```

**Fix:** Add GROUP BY query:
```typescript
db.select({
  observatory: eventsTable.observatory,
  count: sql<number>`count(*)::int`
}).from(eventsTable).groupBy(eventsTable.observatory)
```

---

### Bug #3 — `NU` event type missing from stats `byType`

**File:** `artifacts/api-server/src/routes/events.ts:92`  
**Severity:** Low  
**Description:** The `byType` aggregation object only has keys `GRB`, `GW`, `FRB`. Neutrino events (`NU`) from IceCube are silently dropped from the statistics.

```typescript
const byType = { GRB: 0, GW: 0, FRB: 0 }; // NU missing
```

**Fix:** Add `NU: 0` to the object.

---

### Bug #4 — Sun/Moon distance hardcoded to 90°

**File:** `backend/app/gcn/normalizer.py` (all 6 parsers)  
**Severity:** Medium (incorrect scientific data)  
**Description:** `_sun_moon_distance()` is a placeholder returning `(90.0, 90.0)` for all events. These values are stored in the database and displayed in the dashboard as legitimate scientific measurements.

```python
def _sun_moon_distance(ra, dec, t):
    return 90.0, 90.0  # TODO: implement using astropy
```

**Fix:** Use `astropy.coordinates` with the actual RA/Dec and detection time to compute the true angular separation.

---

### Bug #5 — `event_updated` message type not handled in frontend WebSocket hook

**File:** `artifacts/astro-sentinel/src/hooks/useAstroWebSocket.ts` (inferred from dashboard.tsx usage)  
**Severity:** Medium  
**Description:** The Node.js server broadcasts `type: "event_updated"` when an existing event receives a revision. The dashboard `dashboard.tsx` deduplicates events by `eventId` in a `Map`, which would correctly handle updates — but only if the WebSocket hook adds updated events to its `liveEvents` state. If the hook only handles `type: "alert"` and ignores `"event_updated"`, revisions silently fail to update the UI.

---

### Bug #6 — Dashboard lifecycle filter hides INITIAL and UPDATE events

**File:** `artifacts/astro-sentinel/src/pages/dashboard.tsx:341-347`  
**Severity:** Low (by design, but silently drops events from view)  
**Description:** The sidebar only shows events with `lifecycle === "preliminary"` or `"confirmed"`:

```typescript
const VISIBLE_LIFECYCLES = new Set(["preliminary", "confirmed"]);
const sidebarEvents = useMemo(
  () => allEvents.filter(e => VISIBLE_LIFECYCLES.has((e as any).lifecycle ?? "preliminary")),
  [allEvents],
);
```

Events in `"initial"` or `"update"` lifecycle states are invisible in the sidebar. While this is commented as intentional, it means a user could miss all INITIAL/UPDATE notices. There is no filter control or indication that events are hidden.

---

### Bug #7 — Unsafe `(event as any).lifecycle` type casts in dashboard

**File:** `artifacts/astro-sentinel/src/pages/dashboard.tsx:95-98`  
**Severity:** Low  
**Description:** Multiple `(event as any).lifecycle`, `(event as any).classificationTier`, `(event as any).revisionCount`, `(event as any).isHistorical` casts indicate these fields are not present in the shared `AstroEvent` type from `@workspace/api-client-react`. The fields exist in the database and API response but are missing from the generated OpenAPI type.

**Fix:** Update the OpenAPI spec / Zod schema to include `lifecycle`, `classificationTier`, `revisionCount`, `isHistorical`, `source`, `alertType`.

---

### Bug #8 — ORCID token `jwt.decode` without verification

**File:** `artifacts/api-server/src/routes/auth.ts:138`  
**Severity:** Medium (Security)  
**Description:**
```typescript
const decoded = jwt.decode(id_token) as any; // No signature verification!
if (decoded && decoded.email) {
  email = decoded.email.toLowerCase();
}
```
`jwt.decode` does not verify the signature. An attacker who intercepts the ORCID flow or crafts a malicious token could supply any email. The id_token from ORCID should be verified with ORCID's public keys via `jwt.verify` with the ORCID JWKS endpoint.

---

### Bug #9 — Dynamic import in hot path (`_handleAlert`)

**File:** `artifacts/api-server/src/lib/kafkaConsumer.ts:155`  
**Severity:** Low (Performance)  
**Description:**
```typescript
const { labs } = await import("@workspace/db"); // Dynamic import inside alert handler
```
Called on every accepted Kafka alert. While Node.js caches modules after the first import, this pattern is unusual and confusing. Import `labs` at module top-level.

---

### Bug #10 — `latencyUs` type mismatch in broadcast payload

**File:** `artifacts/api-server/src/lib/kafkaConsumer.ts:281`  
**Severity:** Low  
**Description:** In the broadcast payload, `latencyUs` is set to `Number(upserted.latencyUs)` — but `latencyUs` is `bigserial` (bigint) which can exceed JavaScript's safe integer range (2^53). The REST API correctly converts it to `String(row.latencyUs)` in `formatEvent()`, but the WebSocket broadcast sends a potentially lossy Number.

---

## 11. Performance Analysis

### Frontend

| Issue | Location | Impact |
|-------|----------|--------|
| **Dashboard fetches 300 events on load** | `dashboard.tsx:307` `useListEvents({ limit: 300 })` | Network bandwidth; large initial payload for the dashboard |
| **`allEvents` memo recomputes on every WS message** | `dashboard.tsx:310-333` | O(n) Map construction + Array sort on every received event |
| **`liveIds` memo depends on `liveEvents` array reference** | `dashboard.tsx:335` | Stable but recalculates on every push |
| **No virtualization in event sidebar** | `dashboard.tsx:366-370` | 50 events rendered; fine now but will become slow at higher limits |
| **Multiple API refetch intervals** | `StatsStrip` refetches every 10s | Creates polling load; consider WS-driven updates instead |

### Backend

| Issue | Location | Impact |
|-------|----------|--------|
| **No connection pooling config** | `lib/db/src/index.ts` | Default pool size (10) — adequate for dev, may need tuning for prod |
| **No rate limiting** | `app.ts` | All endpoints unthrottled |
| **No DB query caching** | All routes | Every `/events` request hits DB; no Redis / in-memory cache |
| **Filter stats in-memory** | `filterReport.ts` | Lost on restart; not suitable for multi-process deployment |
| **Sequence counter in-memory** | `eventBroadcaster.ts:10` | Resets to 1 on restart — clients using sequence for dedup may re-process |
| **`COUNT(*)` on startup** | `bootstrap.ts:88` | Full table scan; negligible now, add LIMIT 1 check instead |

### Database

| Issue | Impact |
|-------|--------|
| **Missing index on `lab_id`** | All multi-tenant queries do full scans on `core.events` |
| **Missing index on `(email, status)` in `lab_invitations`** | Registration check on every login/register |
| **TimescaleDB hypertable not activated** | `event_detections` is defined as a regular table; TimescaleDB `create_hypertable()` call is likely missing from migrations |
| **pgvector `embedding` column is `text` not `vector(1536)`** | HNSW index cannot work on a text column; requires proper `vector` type |

---

## 12. Security Audit

### CRITICAL

#### SEC-01: Real Database Password in `.env` File

**File:** `.env:1`  
**Finding:**
```
DATABASE_URL=postgresql://postgres:Maruf%40788824@localhost:5432/Astro-sentinel
```
The actual database password `Maruf@788824` is committed or present in the working directory. If `.env` is tracked by git (it should never be), this credential is permanently in git history.

**Action:** Immediately rotate the database password. Add `.env` to `.gitignore`. Verify git history with `git log --all --full-history -- .env`.

---

#### SEC-02: Placeholder JWT Secret in `.env`

**File:** `.env:3`  
```
JWT_SECRET=your_long_random_secret_here
```
The JWT secret is a placeholder string. Any token signed with this secret can be verified by anyone who sees the `.env` file. Additionally, the code falls back to `"astrosentinel-dev-secret"` if the var is empty.

**Action:** Generate a real 64-character random secret: `openssl rand -hex 64`.

---

### HIGH

#### SEC-03: CORS Wildcard (`*`)

**File:** `artifacts/api-server/src/app.ts:28`  
```typescript
app.use(cors()); // allows ALL origins
```
All origins are allowed. In production this should be restricted to the known frontend domain.

**Fix:**
```typescript
app.use(cors({ origin: process.env.ALLOWED_ORIGIN ?? "http://localhost:5173" }));
```

---

#### SEC-04: Public Events Endpoints (No Auth)

**File:** `artifacts/api-server/src/routes/events.ts`  
All three event endpoints (`GET /events`, `GET /events/stats`, `GET /events/:id`) have no authentication requirement. Any unauthenticated HTTP request can enumerate the full event database.

---

#### SEC-05: No Rate Limiting on Auth Endpoints

**File:** `artifacts/api-server/src/routes/auth.ts`  
No rate limiting on `/auth/login`, `/auth/register`, `/auth/google`. Brute force attacks on login are trivial.

**Fix:** Add `express-rate-limit` middleware to auth routes.

---

#### SEC-06: ORCID `id_token` Decoded Without Verification

**File:** `artifacts/api-server/src/routes/auth.ts:138`  
`jwt.decode()` does not verify the token signature or expiry. A compromised ORCID exchange or MITM could inject a malicious email.

---

### MEDIUM

#### SEC-07: `filter-report` Endpoint Exposes Internal State Without Auth

**File:** `artifacts/api-server/src/routes/filterReport.ts`  
The filter report exposes operational information (rejection categories, event IDs, topic names) without authentication. This is minor but should be admin-only.

---

#### SEC-08: JWT Fallback Secret

**File:** `artifacts/api-server/src/middlewares/auth.ts:4`  
```typescript
const JWT_SECRET = process.env["JWT_SECRET"] ?? "astrosentinel-dev-secret";
```
If the environment variable is accidentally unset in production, all tokens signed with this fallback secret will be accepted by any server that also has this default. This is a production accident waiting to happen.

**Fix:** Throw on missing secret: `if (!process.env["JWT_SECRET"]) throw new Error("JWT_SECRET is required")`.

---

#### SEC-09: `console.error` Leaking ORCID Error Details

**File:** `artifacts/api-server/src/routes/auth.ts:224`  
```typescript
console.error("ORCID auth error:", error);
```
Uses `console.error` (not the Pino logger) and outputs the raw error object, potentially including ORCID client secrets in stack traces.

---

### LOW

#### SEC-10: No CSRF Protection

The API is purely JSON-based with Bearer token auth, which is generally CSRF-safe. However, if cookies are ever introduced, CSRF protection will be needed.

#### SEC-11: No `helmet` Middleware

No security headers (X-Content-Type-Options, X-Frame-Options, Content-Security-Policy). Add `helmet` to the Express app.

#### SEC-12: No Input Sanitization Beyond Zod

The auth routes use basic type assertions (`req.body as { email?: string }`). While SQL injection is prevented by Drizzle parameterization, general input sanitization middleware (e.g., `xss-clean`) is absent.

---

### Security Risk Summary

| ID | Severity | Status | Finding |
|----|----------|--------|---------|
| SEC-01 | 🔴 Critical | Open | Real DB password in `.env` |
| SEC-02 | 🔴 Critical | Open | Placeholder JWT secret |
| SEC-03 | 🟠 High | Open | CORS wildcard |
| SEC-04 | 🟠 High | Open | Events endpoints unauthenticated |
| SEC-05 | 🟠 High | Open | No rate limiting on auth |
| SEC-06 | 🟠 High | Open | ORCID id_token unverified |
| SEC-07 | 🟡 Medium | Open | filter-report public |
| SEC-08 | 🟡 Medium | Open | JWT fallback secret |
| SEC-09 | 🟡 Medium | Open | Error detail logging |
| SEC-10 | 🟢 Low | Open | No CSRF protection |
| SEC-11 | 🟢 Low | Open | No security headers |
| SEC-12 | 🟢 Low | Open | No input sanitization middleware |

---

## 13. Feature Inventory

### Implemented Features

| Feature | Status | Key Files |
|---------|--------|-----------|
| GCN Kafka consumer (Python) | ✅ Complete | `backend/app/gcn/consumer.py`, `background_listener.py` |
| Alert normalization (6 parsers) | ✅ Complete | `backend/app/gcn/normalizer.py` |
| Scientific quality filter | ✅ Complete | `api-server/src/lib/alertFilter.ts` |
| WebSocket bridge (Python → Node) | ✅ Complete | `api-server/src/lib/kafkaConsumer.ts` |
| PostgreSQL event persistence + upsert | ✅ Complete | `api-server/src/lib/kafkaConsumer.ts` |
| Bootstrap historical seed | ✅ Complete | `api-server/src/lib/bootstrap.ts` |
| WebSocket broadcast to frontend | ✅ Complete | `api-server/src/lib/eventBroadcaster.ts` |
| Live event dashboard | ✅ Complete | `astro-sentinel/src/pages/dashboard.tsx` |
| Event revision tracking | ✅ Complete | `revisionCount`, `latestRevision` columns |
| Lifecycle badge display (PRELIM/INITIAL/UPDATE/CONFIRMED) | ✅ Complete | `dashboard.tsx:84-91` |
| Science Mode (additional metrics) | ✅ Complete | `ScienceModeContext`, dashboard |
| Email/password registration + login | ✅ Complete | `routes/auth.ts` |
| Google OAuth login | ✅ Complete | `routes/auth.ts:16-102` |
| ORCID OAuth login | ✅ Complete | `routes/auth.ts:104-227` |
| Invitation-based registration | ✅ Complete | `tenant.lab_invitations` table + auth routes |
| Multi-tenant lab model | ✅ Complete | `tenant.*` schema + auth |
| Filter report / statistics | ✅ Complete | `lib/filterReport.ts`, `routes/filterReport.ts` |
| Pino structured logging with redaction | ✅ Complete | `lib/logger.ts` |
| Drizzle ORM migrations | ✅ Complete | `lib/db/migrations/` |
| Database schema (26 tables, 8 schemas) | ✅ Complete | `lib/db/src/schema/` |
| Auto-generated Zod schemas | ✅ Complete | `lib/api-zod/` |
| React Query API client | ✅ Complete | `lib/api-client-react/` |
| esbuild production bundle | ✅ Complete | `api-server/build.mjs` |
| pnpm monorepo workspace | ✅ Complete | `pnpm-workspace.yaml` |

### Partially Implemented Features

| Feature | Status | Missing Parts | Key Files |
|---------|--------|--------------|-----------|
| Event bookmarks | ⚠️ Partial | Backend routes exist; frontend page exists but integration unknown | `routes/bookmarks.ts`, `pages/BookmarksPage.tsx` |
| Team management | ⚠️ Partial | Backend routes exist; frontend TeamPage exists but create-lab flow unclear | `routes/team.ts`, `pages/TeamPage.tsx` |
| Event discussions | ⚠️ Partial | Backend routes exist; no confirmed frontend UI wiring | `routes/discussions.ts` |
| Research notes | ⚠️ Partial | Backend routes exist; workspace page exists | `routes/notes.ts`, `pages/WorkspacePage.tsx` |
| Event archive page | ⚠️ Partial | EventsPage exists but sorting/filtering UI is basic | `pages/EventsPage.tsx` |
| Event detail page | ⚠️ Partial | Page exists but depth of data shown unclear | `pages/EventDetailPage.tsx` |
| Observatory stats | ⚠️ Partial | DB has data; `byObservatory` always returns `[]` | `routes/events.ts:102` |
| `event_updated` WebSocket handling | ⚠️ Partial | Server broadcasts it; frontend hook handling unclear | `useAstroWebSocket.ts` |

### Missing Features

| Feature | Description | Effort |
|---------|-------------|--------|
| Sun/Moon distance calculation | Currently returns 90° hardcoded | Medium (astropy integration) |
| External link buttons | GCN, ALADIN, ESASky, TNS buttons are non-functional stubs | Small |
| Telescope follow-up request UI | Schema + backend schema complete; no UI | Large |
| FITS sky map viewer | Localization schema exists; no map viewer | Large |
| pgvector semantic search | Schema + index defined; no population or search route | Large |
| API keys management | `identity.api_keys` table defined; no routes | Medium |
| Alert subscriptions (email/push/webhook) | `alerts.alert_subscriptions` table defined; no delivery | Large |
| Audit log wiring | `audit.audit_logs` table defined; no triggers/routes | Medium |
| Event metrics population | `metrics.event_metrics` defined; no population logic | Medium |
| TimescaleDB hypertable activation | Needs `select create_hypertable('core.event_detections', 'detected_at')` | Small |
| Rate limiting | No `express-rate-limit` on any endpoint | Small |
| Security headers | No `helmet` middleware | Small |
| CI/CD pipeline | No GitHub Actions or equivalent | Medium |
| Docker compose | No containerization | Medium |
| Production logging | pino-pretty should be dev-only; prod needs JSON output to file/stdout | Small |

---

## 14. Technical Debt

### Debt #1 — Dead Code: `eventIngestion.ts`

**Impact:** Medium | **Files:** `api-server/src/lib/eventIngestion.ts`, `api-server/src/index.ts:9,88`

`startIngestion()` is imported and called but is a no-op. The comment says it's kept for "import compatibility." There is no import compatibility reason to keep a no-op function. This misleads developers into thinking ingestion is happening via this path.

**Action:** Delete `eventIngestion.ts`, remove import and call from `index.ts`.

---

### Debt #2 — Duplicate Password Libraries

**Impact:** Medium | **Files:** `api-server/package.json`

Both `bcrypt` (native C++ addon) and `bcryptjs` (pure JS) are installed. Only `bcryptjs` is imported. `bcrypt` adds a native build dependency with no benefit.

**Action:** Remove `bcrypt` and `@types/bcrypt` from `package.json`.

---

### Debt #3 — `(event as any)` Type Casts in Dashboard

**Impact:** Medium | **Files:** `dashboard.tsx:95-98, 276-278`

Multiple `as any` casts indicate the shared `AstroEvent` type from the generated API client is missing fields that the API actually returns. The OpenAPI spec / Zod schema needs to be updated to include all returned fields.

---

### Debt #4 — Python Backend Has Redundant REST Endpoints

**Impact:** Low | **Files:** `backend/app/main.py:43-88`

The Python FastAPI backend has `/api/events` and `/api/events/stats` that read from `historical_events.json`. These are never called by the frontend or Node.js layer. They represent a confusing duplicate of the Node.js API and could mislead developers.

---

### Debt #5 — In-Memory State Not Production-Ready

**Impact:** High | **Files:** `filterReport.ts`, `eventBroadcaster.ts`

Both the filter statistics and the WebSocket sequence counter are stored in module-level variables. On server restart: sequence resets to 1, filter stats are lost. In a multi-process (PM2 cluster) deployment, state is inconsistent between workers.

**Action:** For sequence counter, persist to Redis or PostgreSQL. For filter stats, write to a metrics table.

---

### Debt #6 — `latencyUs` as `bigserial` Instead of `bigint`

**Impact:** Low | **Files:** `lib/db/src/schema/events.ts:96`

```typescript
latencyUs: bigserial("latency_us", { mode: "bigint" }).notNull(),
```
`bigserial` is an auto-incrementing sequence column type — inappropriate for storing a measured latency value. This should be a plain `bigint`. Using `bigserial` allocates a sequence object in PostgreSQL unnecessarily.

---

### Debt #7 — `geographyPoint` Custom Type Uses `text` Data Type

**Impact:** Medium | **Files:** `lib/db/src/schema/events.ts:49`

The `geographyPoint` custom type returns `"text"` as its `dataType`, bypassing proper PostGIS support. The actual column in the DB migration is `geography(POINT, 4326)`, but Drizzle doesn't know this — so spatial queries through the ORM are not type-safe.

---

### Debt #8 — `vector` Embedding Stored as `text`

**Impact:** Medium | **Files:** `lib/db/src/schema/events.ts:252`

```typescript
embedding: text("embedding").notNull(),
```
The `core.event_embeddings.embedding` column is defined as `text` in the schema type, but the intent is `vector(1536)`. The HNSW index in the migration SQL operates on a `vector` column — if the column is actually `text`, the index silently fails or does not exist.

---

### Debt #9 — Large File: `dashboard.tsx`

**Impact:** Low | **Files:** `dashboard.tsx` (~385 lines)

Contains `TimelineBar`, `SidebarItem`, `EventBrief`, `RightPanel`, `StatsStrip`, `TeamDetails`, `generateSummary`, and the main `Dashboard` — all in one file. Should be split into dedicated component files.

---

### Debt #10 — Tight Coupling: Python Backend URL Hardcoded Default

**Impact:** Low | **Files:** `kafkaConsumer.ts:56`

The default Python backend URL (`ws://localhost:8001/api/ws`) is hardcoded. In Docker/Kubernetes this needs to be different — but the fallback value makes it easy to forget to set the env var.

---

## 15. Deployment Analysis

### Current Build Process

#### Node.js API Server

```bash
cd artifacts/api-server
pnpm build   # → runs build.mjs (esbuild)
             # Outputs: dist/index.mjs (single ESM bundle)
pnpm start   # → node --enable-source-maps ./dist/index.mjs
```

**esbuild config (`build.mjs`):**
- Entry: `src/index.ts`
- Format: ESM
- Output: `dist/index.mjs`
- External: native addons (bcrypt, sharp, sqlite3, etc.)
- Plugin: `esbuild-plugin-pino` (handles Pino worker threads)
- Banner: CJS shim for ESM compatibility

#### React Frontend

```bash
cd artifacts/astro-sentinel
pnpm build   # → vite build
             # Outputs: dist/ (static HTML + JS + CSS)
pnpm serve   # → vite preview (dev only)
```

#### Python Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8001
```

#### Full Workspace Build

```bash
pnpm build   # runs typecheck then builds all artifacts
```

### Environment Requirements

- **Node.js** ≥ 18 (ESM support, `node:crypto`, `node:fs`, etc.)
- **Python** ≥ 3.11 (`str | None` syntax, `asyncio.create_task`)
- **PostgreSQL** ≥ 14 with extensions: `pgvector`, `postgis`, `ltree`, `timescaledb`
- **pnpm** ≥ 9 (workspace catalogs)

### Missing Deployment Infrastructure

- ❌ No `Dockerfile` for any service
- ❌ No `docker-compose.yml`
- ❌ No GitHub Actions / CI pipeline
- ❌ No `nginx.conf` for production reverse proxy
- ❌ No process manager config (PM2, systemd)
- ❌ No database backup strategy
- ❌ No health check configuration for orchestrators

---

## 16. Improvement Roadmap

### Immediate Fixes (1–3 days)

| Priority | Task | Effort |
|----------|------|--------|
| P0 | **Rotate database password** — current password is in plain text in `.env` | 1h |
| P0 | **Set real JWT_SECRET** — replace placeholder with `openssl rand -hex 64` | 30m |
| P0 | **Add `.env` to `.gitignore`** — prevent future credential leaks | 15m |
| P1 | Fix `byObservatory` in `/events/stats` — add GROUP BY query | 2h |
| P1 | Add `NU` to `byType` in stats | 30m |
| P1 | Fix hardcoded `kafka_connected: true` heartbeat | 1h |
| P1 | Remove dead `eventIngestion.ts` + its import | 30m |
| P1 | Remove duplicate `bcrypt` package | 30m |
| P2 | Add rate limiting to auth endpoints (`express-rate-limit`) | 2h |
| P2 | Add `helmet` security headers middleware | 1h |
| P2 | Restrict CORS to known frontend origin | 1h |

### Short-Term Improvements (1–2 weeks)

| Priority | Task | Effort |
|----------|------|--------|
| P1 | Protect event endpoints with `requireAuth` | 2h |
| P1 | Add sun/moon angular distance calculation (astropy) | 3d |
| P1 | Fix ORCID `id_token` verification with JWKS | 4h |
| P1 | Add JWT_SECRET required check (throw if missing) | 30m |
| P1 | Update `AstroEvent` OpenAPI type to include all returned fields | 1d |
| P2 | Add missing DB indexes (`lab_id`, `lifecycle`, `email+status`) | 2h |
| P2 | Fix `latencyUs` in WebSocket broadcast (use String) | 30m |
| P2 | Fix `latencyUs` column type (`bigserial` → `bigint`) | 2h |
| P2 | Wire up external links (GCN, ALADIN, ESASky, TNS) | 1d |
| P2 | Split `dashboard.tsx` into component files | 1d |
| P3 | Add `pnpm audit` to CI | 2h |

### Medium-Term Improvements (1–2 months)

| Priority | Task | Effort |
|----------|------|--------|
| P1 | Add Docker Compose (PostgreSQL + Python backend + Node.js) | 3d |
| P1 | Add GitHub Actions CI (typecheck + lint + build) | 2d |
| P1 | Implement telescope follow-up request UI | 1w |
| P1 | Implement FITS sky map localization viewer | 2w |
| P2 | Persist filter statistics to `metrics` schema | 3d |
| P2 | Implement alert subscriptions (email notifications) | 1w |
| P2 | Add Nginx reverse proxy config for production | 2d |
| P2 | Implement TimescaleDB hypertable activation | 1d |
| P2 | Fix pgvector `embedding` column type | 2d |
| P3 | Add WebSocket authentication (require JWT for WS connections) | 3d |
| P3 | Add event filtering by date range, observatory, lifecycle | 3d |

### Long-Term Roadmap (3–6 months)

| Task | Description |
|------|-------------|
| **pgvector semantic search** | Embed events and enable similarity-based retrieval |
| **PostGIS cone search** | Find events within N arcminutes of sky coordinates |
| **Multi-process deployment** | Redis for shared state (WS sequence, filter stats) |
| **Grafana / Prometheus monitoring** | Expose `/metrics` endpoint, build observatory dashboards |
| **Mobile notifications** | Push notifications for high-priority events |
| **GCN Circular auto-drafting** | AI-assisted draft generation for GCN Circulars |
| **VOEvent support** | Parse and generate VOEvent XML format |
| **Multi-region deployment** | Low-latency alert delivery to distributed teams |

---

## 17. Final Scorecard

| Category | Score | Rationale |
|----------|-------|-----------|
| **Architecture** | 7.5/10 | Clean three-tier design; Python→Node bridge is creative but adds operational complexity; missing orchestration layer |
| **Code Quality** | 7/10 | TypeScript is well-typed overall; scientific filter is well-documented; `as any` casts and dead code reduce score |
| **Maintainability** | 6.5/10 | Good modular structure; pnpm workspace is well-organized; missing tests, large dashboard file, dead code hurt maintainability |
| **Security** | 3.5/10 | Real credentials in `.env`, no rate limiting, no auth on primary endpoints, CORS wildcard, unverified ORCID JWT — multiple critical issues |
| **Scalability** | 5/10 | PostgreSQL schema supports multi-tenant scale; in-memory state (filter stats, sequence) won't survive multi-process; no caching layer |
| **Performance** | 6/10 | Efficient upsert pattern; missing indexes; 300-event initial load; no query caching; TimescaleDB/pgvector not yet leveraged |
| **Documentation** | 5/10 | Code comments are good in critical files (alertFilter.ts, kafkaConsumer.ts, bootstrap.ts); no README, no API docs, no architecture diagram |
| **Deployment Readiness** | 3/10 | No Dockerfile, no CI/CD, no process manager, no production Nginx config; development-only setup |

### Overall Project Health Score

```
╔══════════════════════════════════════════════════════╗
║                                                      ║
║   Overall Health:  5.6 / 10                          ║
║                                                      ║
║   Core Science Pipeline: ████████░░ 8/10  Excellent  ║
║   API & Data Layer:      ███████░░░ 7/10  Good       ║
║   Frontend UX:           ███████░░░ 7/10  Good       ║
║   Security Posture:      ████░░░░░░ 3.5/10 Poor      ║
║   Ops & Deployment:      ███░░░░░░░ 3/10  Needs Work ║
║                                                      ║
╚══════════════════════════════════════════════════════╝
```

**Summary for new developers:** The Transient Event Detection has a technically sound and well-architected scientific data pipeline. The GCN Kafka integration, alert normalization, quality filtering, and WebSocket real-time delivery are all solid. The database schema is comprehensive and forward-looking (pgvector, PostGIS, TimescaleDB). The main concerns are **security** (credentials in `.env`, missing auth on public endpoints) and **deployment readiness** (no containerization, no CI/CD). Addressing the Critical and High security issues should be the first priority before any production use. Once those are resolved, this is a strong foundation for a production-grade multi-messenger astronomy alert platform.

---

*Report generated by complete repository audit — 2026-06-14*
