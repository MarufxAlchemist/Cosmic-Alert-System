# Transient Event Detection

A multi-tier application that ingests, analyzes, and serves astronomical alerts (GCN notices) in real-time.

## Architecture

```
Internet
    │
    ▼ :5173
┌─────────────────────────────────────────────────────────────────┐
│  Docker bridge network: cosmic                                   │
│                                                                  │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐    │
│  │  frontend    │   │  api-server  │   │  python-backend  │    │
│  │  nginx:alpine│   │  Node 22     │   │  Python 3.12     │    │
│  │  :5173       │   │  :8000       │   │  :8001           │    │
│  └──────┬───────┘   └──────┬───────┘   └──────────────────┘    │
│         │ /api proxy       │                                     │
│         └──────────────────┘                                     │
│                             │                                    │
│                    ┌────────┴────────┐                          │
│                    │  postgres:5432  │                           │
│                    │  PostGIS 16     │                           │
│                    └─────────────────┘                          │
└─────────────────────────────────────────────────────────────────┘
```

| Service | Technology | Port |
|---|---|---|
| `postgres` | PostGIS 16-alpine | 5432 |
| `migrate` | Node 22 / Drizzle (one-shot) | — |
| `python-backend` | Python 3.12 / FastAPI / GCN Kafka | 8001 |
| `api-server` | Node 22 / Express / WebSocket | 8000 |
| `frontend` | nginx / React / Vite | 5173 |

---

## 🚀 Docker Quick Start (Recommended)

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- Ports `5173`, `8000`, `8001`, `5432` free on your machine

### 1. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and fill in all `CHANGE_ME` values:

| Variable | Description |
|---|---|
| `POSTGRES_PASSWORD` | Database password (choose any strong password) |
| `POSTGRES_PASSWORD_URLENC` | Same password, URL-encoded (`@` → `%40`, `#` → `%23`) |
| `JWT_SECRET` | Random 64-char hex string (`node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`) |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GEMINI_API_KEY` | Google Gemini API key |
| `ORCID_CLIENT_ID` / `ORCID_CLIENT_SECRET` | ORCID OAuth credentials |
| `GCN_CLIENT_ID` / `GCN_CLIENT_SECRET` | NASA GCN Kafka credentials |

### 2. Start Everything

```bash
docker compose up --build
```

Or in detached mode (background):

```bash
docker compose up -d --build
```

**Automatic startup sequence:**
1. `postgres` starts → waits until healthy (pg_isready)
2. `migrate` runs Drizzle migrations → exits 0
3. `python-backend` starts FastAPI + GCN Kafka consumer
4. `api-server` starts after postgres, migrate, and python-backend are ready
5. `frontend` starts after api-server passes healthcheck

**Access the app:** http://localhost:5173

### 3. Stop

```bash
docker compose down          # stop (database data preserved)
docker compose down -v       # stop + delete all volumes (wipes database)
```

### Useful Commands

```bash
# View all service logs
docker compose logs -f

# View a specific service
docker compose logs -f api-server

# Rebuild a single service
docker compose up --build --no-deps api-server

# Force clean rebuild (no cache)
docker compose build --no-cache
docker compose up

# Run database backup (manual)
docker compose --profile backup run --rm backup

# Connect to PostgreSQL
docker compose exec postgres psql -U postgres -d Astro-sentinel
```

---

## 💻 Local Development (Without Docker)

For frontend/backend development with live reload:

### 1. Start Database (Docker)

```bash
docker compose up -d postgres
```

### 2. Run Migrations

```bash
pnpm --filter @workspace/db run migrate
```

*(Ensure `DATABASE_URL` is set in `.env`)*

### 3. Start API Server

```bash
cd artifacts/api-server
pnpm install
pnpm dev
```

Runs on `http://localhost:8000`

### 4. Start Frontend

```bash
cd artifacts/astro-sentinel
pnpm install
pnpm dev
```

Runs on `http://localhost:5173` (Vite proxy forwards `/api` to `localhost:8000`)

### 5. Start Python Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate        # Windows: .\venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload
```

---

## File Structure

```
.
├── docker-compose.yml         ← THE single entry point (docker compose up --build)
├── Dockerfile.api             ← Node 22 / Express API server
├── Dockerfile.frontend        ← Vite build → nginx SPA
├── Dockerfile.python          ← Python 3.12 / FastAPI / Kafka
├── Dockerfile.migrate         ← Node 22 / Drizzle migrations (one-shot)
├── .dockerignore              ← Build context exclusions
├── .env                       ← Secrets (gitignored)
├── .env.example               ← Safe template (committed)
├── artifacts/
│   ├── api-server/            ← Express API source
│   └── astro-sentinel/        ← React/Vite frontend source
│       └── nginx.conf         ← nginx SPA + /api proxy config
├── backend/                   ← Python FastAPI source
│   └── app/
├── lib/
│   └── db/                    ← Drizzle schema + migrations
└── deploy/
    └── nginx/                 ← Production reverse proxy configs (VPS deployment)
```
