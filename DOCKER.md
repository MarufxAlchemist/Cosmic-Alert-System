# Transient Event Detection — Docker Guide

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Docker bridge network: cosmic                                   │
│                                                                  │
│  ┌────────────┐    ┌──────────┐    ┌───────────────┐            │
│  │  postgres  │◄───│ migrate  │    │ python-backend│            │
│  │  :5432     │    │ (exits 0)│    │  :8001        │            │
│  └─────┬──────┘    └──────────┘    └───────┬───────┘            │
│        │                                   │                     │
│        └──────────────┬────────────────────┘                     │
│                       ▼                                          │
│               ┌───────────────┐                                  │
│               │  api-server   │                                  │
│               │  :8000        │                                  │
│               └───────┬───────┘                                  │
│                       ▼                                          │
│               ┌───────────────┐                                  │
│               │   frontend    │  (nginx: SPA + /api proxy)       │
│               │  :5173        │                                  │
│               └───────────────┘                                  │
└─────────────────────────────────────────────────────────────────┘
```

| Service          | Image / Dockerfile       | Port | Purpose                                |
|------------------|--------------------------|------|----------------------------------------|
| `postgres`       | postgis/postgis:16-3.4-alpine | 5432 | Persistent PostGIS database       |
| `migrate`        | `Dockerfile.migrate`     | —    | Runs Drizzle migrations once then exits|
| `python-backend` | `Dockerfile.python`      | 8001 | GCN Kafka consumer + FastAPI WebSocket |
| `api-server`     | `Dockerfile.api`         | 8000 | Express REST API + WebSocket bridge    |
| `frontend`       | `Dockerfile.frontend`    | 5173 | Vite SPA + `/api` nginx proxy          |

---

## Prerequisites

1. **Docker Desktop** installed and running
   - Download: https://www.docker.com/products/docker-desktop/
   - Confirm with: `docker version`

2. **Ports available** on your machine:
   - `5432` — PostgreSQL
   - `8001` — Python backend
   - `8000` — API server
   - `5173` — Frontend (the app entry point)

3. **`.env` file** created from the template:
   ```bash
   cp .env.example .env
   # Edit .env and fill in all CHANGE_ME values
   ```

---

## How to Build and Run

### Single command (recommended)

```bash
docker compose up --build
```

Or in detached mode:

```bash
docker compose up -d --build
```

**Startup sequence (automatic, healthcheck-based):**
1. `postgres` starts and waits until accepting connections
2. `migrate` runs Drizzle migrations (applies pending SQL files) then exits 0
3. `python-backend` starts uvicorn FastAPI + GCN Kafka consumer
4. `api-server` starts only after postgres is healthy, migrate has completed, and python-backend is healthy
5. `frontend` starts after api-server passes its healthcheck

**Access the app:** http://localhost:5173

---

## How to Rebuild

### Rebuild everything

```bash
docker compose up --build
```

### Rebuild a specific service

```bash
# Rebuild only the api-server
docker compose build api-server
docker compose up --no-deps api-server

# Or in one command
docker compose up --build --no-deps api-server
```

### Force a clean rebuild (no cache)

```bash
docker compose build --no-cache
docker compose up
```

---

## How to Stop

### Stop containers (keep data)

```bash
docker compose down
```

Postgres data is preserved in the `postgres_data` named volume.

### Stop containers and wipe the database

> ⚠️ This permanently deletes all data.

```bash
docker compose down -v
```

---

## How to Inspect Logs

### All services at once

```bash
docker compose logs -f
```

### A specific service

```bash
docker compose logs -f api-server
docker compose logs -f python-backend
docker compose logs -f postgres
docker compose logs -f migrate
docker compose logs -f frontend
```

### Last N lines

```bash
docker compose logs --tail=100 api-server
```

### Check service health status

```bash
docker compose ps
```

---

## How to Connect to PostgreSQL Inside Docker

### Via docker exec (no local psql needed)

```bash
# Open an interactive psql shell inside the container
docker compose exec postgres psql -U postgres -d Astro-sentinel

# Run a one-off query
docker compose exec postgres psql -U postgres -d Astro-sentinel -c "SELECT COUNT(*) FROM events;"
```

### Using a GUI (DBeaver / TablePlus)

```
Host:     localhost
Port:     5432
User:     postgres
Password: (your POSTGRES_PASSWORD from .env)
Database: Astro-sentinel
```

---

## Database Migrations

Migrations are applied **automatically** by the `migrate` service on every `docker compose up`. No manual steps required.

Migrations use Drizzle ORM's programmatic migrator which reads:
- `lib/db/migrations/meta/_journal.json` — tracks which files have been applied
- `lib/db/migrations/*.sql` — ordered SQL migration files

The migrate container exits with code 0 on success. The api-server waits for `service_completed_successfully` before starting, guaranteeing all schema changes are applied.

### Re-run migrations manually

```bash
docker compose run --rm migrate
```

---

## Database Backups

Backups are opt-in, run on demand via Docker Compose profiles:

```bash
# Run a one-off backup
docker compose --profile backup run --rm backup
```

Backup files are stored in the `postgres_backups` named volume (gzipped SQL dumps, kept for 7 days).

To automate backups on a Linux host via cron:
```bash
# Add to crontab (runs at 2:00 AM daily)
0 2 * * * cd /path/to/repo && docker compose --profile backup run --rm backup >> /var/log/astrosentinel-backup.log 2>&1
```

---

## Environment Variables Reference

All variables come from the root `.env` file. Secrets are **never** baked into images.

| Variable | Used by | Description |
|---|---|---|
| `POSTGRES_USER` | postgres, migrate, api-server | DB username |
| `POSTGRES_PASSWORD` | postgres, backup | DB password (plain) |
| `POSTGRES_PASSWORD_URLENC` | migrate, api-server | URL-encoded password (`@` → `%40`) |
| `POSTGRES_DB` | postgres, api-server | Database name |
| `DATABASE_URL` | local dev only | Full connection string (not used by compose) |
| `JWT_SECRET` | api-server | Signs/verifies JWTs |
| `GOOGLE_CLIENT_ID` | api-server | Google OAuth2 client ID |
| `GEMINI_API_KEY` | api-server | Gemini AI API key |
| `GEMINI_MODEL` | api-server | Gemini model name (default: gemini-2.5-flash) |
| `GEMINI_TIMEOUT_MS` | api-server | Gemini request timeout (default: 45000) |
| `ORCID_CLIENT_ID` | api-server | ORCID OAuth client ID |
| `ORCID_CLIENT_SECRET` | api-server | ORCID OAuth client secret |
| `GCN_CLIENT_ID` | python-backend | NASA GCN Kafka client ID |
| `GCN_CLIENT_SECRET` | python-backend | NASA GCN Kafka client secret |

---

## File Structure

```
.
├── docker-compose.yml         ← THE single entry point
├── Dockerfile.api             ← Node 22 multi-stage (pnpm + esbuild)
├── Dockerfile.frontend        ← Node 22 (Vite build) → nginx:alpine
├── Dockerfile.python          ← Python 3.12-slim (FastAPI + Kafka)
├── Dockerfile.migrate         ← Node 22 (Drizzle migrations, one-shot)
├── .dockerignore              ← Root build context exclusions (all services)
├── .env                       ← Secrets (gitignored)
├── .env.example               ← Safe template (committed)
├── artifacts/
│   ├── api-server/            ← Express API source (no Dockerfile here)
│   └── astro-sentinel/        ← React/Vite source (no Dockerfile here)
│       └── nginx.conf         ← nginx config used by Dockerfile.frontend
└── backend/                   ← Python source (no Dockerfile here)
    └── app/
```

---

## BuildKit Cache

All Dockerfiles use `# syntax=docker/dockerfile:1` to enable BuildKit:

- **Python backend**: `--mount=type=cache,target=/root/.cache/pip` — caches pip downloads
- **Node services**: `--mount=type=cache,id=pnpm-store,target=/pnpm/store` — caches pnpm store

BuildKit is enabled by default in Docker Desktop 23+. If needed:

```bash
DOCKER_BUILDKIT=1 docker compose build
```

---

## Troubleshooting

### Container exits immediately

```bash
docker compose logs <service-name>
```

### api-server waiting forever for dependencies

Check if postgres, migrate, and python-backend are healthy:
```bash
docker compose ps
```

### Migrations failing

```bash
docker compose logs migrate
```

Common cause: `POSTGRES_PASSWORD_URLENC` not set or incorrectly encoded.
If your password is `my@pass`, `POSTGRES_PASSWORD_URLENC` must be `my%40pass`.

### Port already in use

```bash
# Windows: find what is using port 8000
netstat -ano | findstr :8000

# Linux/Mac:
lsof -i :8000
```

Stop the conflicting process or change the host port in `docker-compose.yml` (e.g., `"8080:8000"`).

### Full reset (nuclear option)

```bash
docker compose down -v --rmi local
docker compose up --build
```

This removes all containers, volumes (database), and locally built images, then rebuilds everything from scratch.
