# ARCHITECTURE.md — Transient Event Detection

> Last updated: 2026-08-06

## High-Level Data Flow

```
GCN Kafka Broker (NASA)
        │ Kafka TLS (SASL/OAUTHBEARER)
        ▼
Python FastAPI Backend :8001
  ├── gcn-kafka Consumer (asyncio poll loop)
  ├── Normalizer (6 parsers: GRB, GW, FRB, NU, Swift, IceCube)
  ├── AlertRingBuffer (200 events, in-memory)
  └── WebSocket Broadcast → all connected clients
        │ WebSocket ws://python-backend:8001/api/ws
        ▼
Node.js Express API Server :8000
  ├── kafkaConsumer.ts (WS bridge — receives from Python)
  ├── alertFilter.ts (per-source scientific quality gates)
  ├── Drizzle ORM upsert → PostgreSQL
  ├── eventBroadcaster.ts (WS fanout to all frontend clients)
  └── REST API (/api/*)
        │ HTTP REST + WebSocket ws://api-server:8000/api/ws
        ▼
React Frontend :5173
  ├── useAstroWebSocket (WS client, reconnect, dedup by event_id)
  ├── React Query (REST polling for events list / stats)
  └── Dashboard (live event feed, science panel, filters)
        │
        ▼
PostgreSQL :5432
  └── 8 schemas, 26 tables (core.events is primary)
```

## Service Communication

| From | To | Protocol | Address (Docker) |
|---|---|---|---|
| Python backend | GCN Kafka | Kafka TLS | kafka*.gcn.nasa.gov:9092 |
| Node.js api-server | Python backend | WebSocket | ws://python-backend:8001/api/ws |
| Frontend nginx | Node.js api-server | HTTP + WebSocket | http://api-server:8000 |
| Node.js api-server | PostgreSQL | TCP (pg driver) | postgres:5432 |
| migrate container | PostgreSQL | TCP (pg driver) | postgres:5432 |

> **Rule:** No service uses `localhost` to reach another service inside Docker. All use Docker service names.

## Docker Compose Stack

```
postgres (healthy)
    ↓
migrate (service_completed_successfully)  ← one-shot Drizzle migrations
    ↓
python-backend (healthy)                  ← FastAPI + GCN Kafka
    ↓
api-server (healthy)                      ← Express + WebSocket
    ↓
frontend                                  ← nginx serving Vite SPA
```

Single entry point: `docker compose up --build`

## Frontend Architecture

### Provider Stack (App.tsx)
```
GoogleOAuthProvider
  └── QueryClientProvider
        └── AuthProvider (JWT from localStorage)
              └── ThemeProvider
                    └── ScienceModeProvider
                          └── NotificationsProvider
                                └── Router (Wouter)
```

### Routes
| Path | Component |
|---|---|
| `/` | `dashboard.tsx` — live event feed |
| `/events` | `EventsPage.tsx` — archive list |
| `/events/:id` | `EventDetailPage.tsx` |
| `/events/:id/workspace` | `WorkspacePage.tsx` |
| `/bookmarks` | `BookmarksPage.tsx` |
| `/team` | `TeamPage.tsx` |
| `/login` | `LoginPage.tsx` |
| `/debug/ws` | `DebugWsPage.tsx` (public) |

### Key Hooks
- `useAstroWebSocket` — WebSocket client with reconnect, sequence dedup, ring buffer replay
- `useListEvents` — TanStack Query, paginated REST polling
- `useGetEventStats` — stats strip data

## Authentication Flow

```
1. User submits credentials (email/pw, Google token, or ORCID code)
2. POST /api/auth/{register|login|google|orcid}
3. Server validates → issues JWT (HS256, JWT_SECRET)
4. Frontend stores JWT in localStorage via AuthContext
5. All protected requests send: Authorization: Bearer <JWT>
6. requireAuth middleware validates JWT → injects req.user
```

**Multi-tenant model:** Every event is scoped to a `lab_id`. The default lab is seeded on first startup. Users belong to labs via `tenant.lab_members`.

## Alert Ingestion Pipeline (Node.js)

```
kafkaConsumer.ts receives WS message from Python
    ↓
JSON.parse(message)
    ↓
applyAlertFilter(topic, rawPayload) → AcceptVerdict | RejectVerdict
    ├── REJECT → recordRejected(), log, stop
    └── ACCEPT → continue
        ↓
db.insert(core.events).onConflictDoUpdate()
    ├── NEW event      → revisionCount=0 → broadcastEvent()
    └── REVISION event → revisionCount++ → broadcastEventUpdate()
        ↓
wss.clients.forEach(client.send(JSON.stringify(message)))
```

## Scientific Alert Filter Gates (alertFilter.ts)

| Gate | Topics Affected | Rejection Reason |
|---|---|---|
| Test trigger flag | All | `test_trigger` |
| Sub-threshold SNR | GW, GRB | `sub_threshold` |
| Retraction | All | `retraction` |
| MDC mock event | GW | `mdc_mock` |
| Below noise floor | All | `noise` |
| Duplicate in window | All | `duplicate` |

## Build System

- **API server:** `pnpm --filter @workspace/api-server run build` → esbuild → `dist/index.mjs`
- **Frontend:** `pnpm --filter @workspace/astro-sentinel run build` → Vite → `dist/public/`
- **TypeScript:** Strict mode, `tsconfig.base.json` extended by all packages
