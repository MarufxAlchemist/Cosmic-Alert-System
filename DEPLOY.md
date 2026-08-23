# Transient Event Detection — Production Deployment Guide

> **Goal**: Deploy the entire stack on a Linux VPS using only `git clone` + `docker compose up -d`.

---

## Table of Contents

1. [Server Requirements](#1-server-requirements)
2. [VPS Installation](#2-vps-installation)
3. [Docker Installation](#3-docker-installation)
4. [First Deployment](#4-first-deployment)
5. [Updating Containers](#5-updating-containers)
6. [Rebuilding Images](#6-rebuilding-images)
7. [Rollback Procedure](#7-rollback-procedure)
8. [Backup & Restoration](#8-backup--restoration)
9. [SSL / HTTPS Setup](#9-ssl--https-setup)
10. [Monitoring Setup](#10-monitoring-setup)
11. [Troubleshooting](#11-troubleshooting)

---

## Architecture

```
Internet
    │
    ▼ port 80 / 443
┌─────────────────────────────────────────────────────────────────┐
│  nginx (reverse proxy)   — only service exposed to the internet  │
│  deploy/nginx/nginx.conf                                        │
│                                                                  │
│  /            → frontend:5173  (Vite SPA, static files)         │
│  /api/*       → api-server:8000 (Express REST API)             │
│  /api/ws      → api-server:8000 (WebSocket)                    │
│  /health/api  → api-server:8000/api/healthz (monitoring)       │
│  /.well-known → /var/www/certbot (Let's Encrypt ACME)          │
│                                                                  │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────────┐    │
│  │  frontend    │  │  api-server    │  │  python-backend  │    │
│  │  nginx:alpine│  │  Express/Node22│  │  FastAPI/Python  │    │
│  │  :5173 int.  │  │  :8000 int.    │  │  :8001 int.      │    │
│  └──────────────┘  └───────┬────────┘  └──────────────────┘    │
│                             │                                    │
│                    ┌────────┴────────┐                          │
│                    │  postgres:5432   │   ← internal only       │
│                    │  postgres:16-alp │                          │
│                    └─────────────────┘                          │
└─────────────────────────────────────────────────────────────────┘
            All on docker bridge network: cosmic-prod
```

---

## 1. Server Requirements

### Minimum Specifications

| Resource | Minimum | Recommended |
|---|---|---|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 2 GB | 4 GB |
| Disk | 20 GB SSD | 40 GB SSD |
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |
| Network | 100 Mbps | 1 Gbps |

### Open Ports (Firewall)

| Port | Protocol | Purpose |
|---|---|---|
| 22 | TCP | SSH (change to custom port in production) |
| 80 | TCP | HTTP (nginx, Let's Encrypt challenge) |
| 443 | TCP | HTTPS (nginx, after SSL setup) |

> **All other ports (5432, 8000, 8001, 5173) should be BLOCKED by your firewall.**
> Docker Compose manages internal communication — these ports never need to be public.

### UFW firewall setup (Ubuntu)

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

---

## 2. VPS Installation

### Connect to your VPS

```bash
ssh root@YOUR_SERVER_IP
# or with key: ssh -i ~/.ssh/key.pem ubuntu@YOUR_SERVER_IP
```

### System update

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl wget unzip logrotate
```

### Create a non-root user (recommended)

```bash
adduser cosmic
usermod -aG sudo cosmic
usermod -aG docker cosmic   # allow docker commands (after Docker is installed)
su - cosmic
```

---

## 3. Docker Installation

### Install Docker Engine (Ubuntu)

```bash
# Remove old versions
sudo apt remove -y docker docker-engine docker.io containerd runc || true

# Install prerequisites
sudo apt install -y ca-certificates curl gnupg lsb-release

# Add Docker official GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add Docker repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io \
                    docker-buildx-plugin docker-compose-plugin

# Verify
docker --version
docker compose version
```

### Allow current user to run Docker without sudo

```bash
sudo usermod -aG docker $USER
newgrp docker
# OR log out and back in
```

### Enable Docker on system startup

```bash
sudo systemctl enable docker
sudo systemctl start docker
```

---

## 4. First Deployment

### Clone the repository

```bash
cd /opt
git clone https://github.com/MarufxAlchemist/Cosmic-Alert-System.git cosmic-alert
cd cosmic-alert
```

### Create the environment file

```bash
cp .env.example .env
nano .env   # Fill in all CHANGE_ME values
```

#### Required `.env` values

| Variable | Description | Example |
|---|---|---|
| `POSTGRES_PASSWORD` | Database password | `MySecurePass123!` |
| `POSTGRES_PASSWORD_URLENC` | URL-encoded password | `MySecurePass123%21` (! → %21) |
| `JWT_SECRET` | 64-char random string | `openssl rand -hex 64` |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | `123456.apps.googleusercontent.com` |
| `GEMINI_API_KEY` | Google AI API key | From Google Cloud Console |
| `ORCID_CLIENT_ID` | ORCID OAuth ID | `APP-XXXXXXXXXXXXXXXX` |
| `ORCID_CLIENT_SECRET` | ORCID OAuth secret | From ORCID developer tools |

> **URL-encoding the password**: If your password contains `@`, `#`, `$`, etc., encode them:
> `@` → `%40`, `#` → `%23`, `$` → `%24`, `!` → `%21`, `:` → `%3A`

**Generate a secure JWT secret:**
```bash
openssl rand -hex 64
```

### Create the GCN credentials file

```bash
nano backend/.env
```

```env
GCN_CLIENT_ID=your_gcn_client_id
GCN_CLIENT_SECRET=your_gcn_client_secret
```

### Run the automated deployment script

```bash
chmod +x deploy/scripts/deploy.sh
./deploy/scripts/deploy.sh
```

This script:
1. Validates prerequisites
2. Installs logrotate config
3. Sets up a daily backup cron job
4. Builds all Docker images
5. Starts the full stack
6. Waits for the API to become healthy
7. Reports the server's public IP

### Manual deployment (alternative)

If you prefer step-by-step control:

```bash
# Build all images
DOCKER_BUILDKIT=1 docker compose -f docker-compose.prod.yml build

# Start the stack in detached mode
docker compose -f docker-compose.prod.yml up -d

# Check status
docker compose -f docker-compose.prod.yml ps

# Watch logs
docker compose -f docker-compose.prod.yml logs -f
```

### Verify deployment

```bash
# Check all containers are running
docker compose -f docker-compose.prod.yml ps

# Test API health endpoint
curl http://localhost/health/api
# Expected: {"status":"ok","db":"connected","timestamp":"..."}

# Test frontend is served
curl -I http://localhost/
# Expected: HTTP/1.1 200 OK

# Test rate limiting (should get 200 OK)
curl http://YOUR_SERVER_IP/api/events?page=1&limit=10
```

---

## 5. Updating Containers

Use the automated update script for a rolling restart with minimal downtime:

```bash
./deploy/scripts/update.sh
```

The script:
1. Pulls latest changes from `git main`
2. Rebuilds changed Docker images (BuildKit cache makes this fast)
3. Runs database migrations (if schema changed)
4. Restarts each service individually
5. Verifies API health before completing
6. Prunes dangling images

### Manual update

```bash
# Pull latest code
git pull origin main

# Rebuild and restart a specific service (e.g., api-server only)
DOCKER_BUILDKIT=1 docker compose -f docker-compose.prod.yml build api-server
docker compose -f docker-compose.prod.yml up -d --no-deps api-server

# Rebuild and restart all services
DOCKER_BUILDKIT=1 docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

---

## 6. Rebuilding Images

### Force rebuild (ignore cache)

```bash
DOCKER_BUILDKIT=1 docker compose -f docker-compose.prod.yml build --no-cache
docker compose -f docker-compose.prod.yml up -d
```

### Rebuild a single service

```bash
# Rebuild only the python-backend image
DOCKER_BUILDKIT=1 docker compose -f docker-compose.prod.yml build python-backend

# Restart only that container (leave others running)
docker compose -f docker-compose.prod.yml up -d --no-deps python-backend
```

### Free up disk space after rebuild

```bash
# Remove dangling images (safe, only untagged layers)
docker image prune -f

# Remove ALL unused images (aggressive, frees more space)
docker image prune -a -f

# Full cleanup (removes stopped containers, networks, volumes — CAREFUL with -v)
docker system prune -f
```

---

## 7. Rollback Procedure

### Method 1: Rollback via git (recommended)

```bash
# Find the last known-good commit
git log --oneline -10

# Rollback to a specific commit
git checkout abc1234

# Rebuild and restart
./deploy/scripts/update.sh --no-pull
```

### Method 2: Keep previous image with git tags

Before any deployment, tag the current working state:

```bash
# Before updating, create a release tag
git tag -a v1.2.3 -m "Release v1.2.3" HEAD
git push origin v1.2.3
```

To rollback to a tag:
```bash
git checkout v1.2.3
./deploy/scripts/update.sh --no-pull
```

### Method 3: Database rollback

If a migration broke the database schema:

```bash
# Stop the api-server to prevent ongoing writes
docker compose -f docker-compose.prod.yml stop api-server

# Restore from the most recent backup (see Backup & Restoration below)
./deploy/scripts/restore.sh backup_YYYYMMDD_HHMMSS.sql.gz

# Rollback the code
git checkout <previous-commit>
./deploy/scripts/update.sh --no-pull
```

> **⚠️ Important**: Drizzle migrations do not support automatic rollback. If a migration fails midway, restore from a backup.

---

## 8. Backup & Restoration

### Automated daily backups

The deployment script installs a cron job that runs backups at 2:00 AM daily:

```bash
# Verify cron is installed
crontab -l | grep backup
```

### Manual backup

```bash
./deploy/scripts/backup.sh
# OR directly:
docker compose -f docker-compose.prod.yml --profile backup run --rm backup
```

### List existing backups

```bash
docker run --rm \
  -v cosmic-alert_postgres_backups:/backups \
  alpine:latest \
  ls -lh /backups/
```

> **Note**: Docker volume names include the project directory name. If you deployed to `/opt/cosmic-alert/`, the volume name is `cosmic-alert_postgres_backups`.

### Copy backups to the host filesystem

```bash
# Copy all backups to /opt/backups/ on the host
docker run --rm \
  -v cosmic-alert_postgres_backups:/backups \
  -v /opt/backups:/dest \
  alpine:latest \
  cp -r /backups/. /dest/

ls -lh /opt/backups/
```

### Off-server backup (via scp from another machine)

```bash
# Copy backups to your local machine
scp -r user@YOUR_SERVER:/opt/backups/ ./local-backups/
```

### Restore from backup

```bash
./deploy/scripts/restore.sh backup_20240724_020000.sql.gz
```

The restore script:
1. Confirms the operation (destructive — asks for ENTER)
2. Stops api-server to prevent active connections
3. Drops and recreates the database
4. Restores from the gzipped pg_dump file
5. Restarts api-server

---

## 9. SSL / HTTPS Setup

### Prerequisites

1. A domain name pointing to your VPS IP
2. Ports 80 and 443 open in your firewall
3. The production stack already running (HTTP)

### Install Certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
```

### Obtain a certificate

The nginx configuration already serves the ACME challenge on port 80 at `/.well-known/acme-challenge/`. Run certbot in webroot mode:

```bash
# Replace your-domain.com with your actual domain
docker compose -f docker-compose.prod.yml exec nginx \
  sh -c "apk add --no-cache certbot && \
         certbot certonly --webroot \
           -w /var/www/certbot \
           -d your-domain.com \
           --email admin@your-domain.com \
           --agree-tos --non-interactive"
```

### Enable HTTPS in nginx

1. Open `deploy/nginx/nginx.conf`
2. Uncomment the `server { listen 443 ssl http2; ... }` block
3. Set `server_name your-domain.com;`
4. In the HTTP server block, replace all location blocks with:
   ```nginx
   location /.well-known/acme-challenge/ {
       root /var/www/certbot;
   }
   location / {
       return 301 https://$host$request_uri;
   }
   ```
5. Reload nginx:
   ```bash
   docker compose -f docker-compose.prod.yml exec nginx nginx -s reload
   ```

### Test HTTPS

```bash
curl -I https://your-domain.com/health/api
```

### Auto-renew certificates

Certbot certificates expire every 90 days. Add a renewal cron:

```bash
# Add to crontab (checks renewal twice daily — certbot only acts if <30 days left)
echo "0 0,12 * * * docker compose -f /opt/cosmic-alert/docker-compose.prod.yml exec -T nginx certbot renew --quiet && docker compose -f /opt/cosmic-alert/docker-compose.prod.yml exec -T nginx nginx -s reload" | crontab -
```

---

## 10. Monitoring Setup

The nginx reverse proxy exposes these health endpoints, ready for Prometheus or external monitoring:

| Endpoint | Monitors | Expected response |
|---|---|---|
| `GET /health/api` | api-server | `{"status":"ok","db":"connected"}` |
| `GET /health/python` | python-backend | `{"status":"healthy"}` |

### UptimeRobot / Uptime Kuma

Configure an HTTP monitor pointing to `http://YOUR_SERVER/health/api`. Alert threshold: non-200 response.

### Prometheus + Grafana (future)

When ready to add metrics:

1. Add `prom-client` to the api-server: `pnpm --filter @workspace/api-server add prom-client`
2. Expose a `/api/metrics` endpoint from Express
3. Add to `docker-compose.prod.yml`:
   ```yaml
   prometheus:
     image: prom/prometheus:latest
     volumes:
       - ./deploy/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml
     networks:
       - cosmic-prod
   grafana:
     image: grafana/grafana:latest
     networks:
       - cosmic-prod
   ```
4. Configure Prometheus to scrape `api-server:8000/api/metrics`

---

## 11. Troubleshooting

### Check container status

```bash
docker compose -f docker-compose.prod.yml ps
```

### View logs

```bash
# All services
docker compose -f docker-compose.prod.yml logs -f

# Specific service (last 100 lines)
docker compose -f docker-compose.prod.yml logs --tail=100 api-server
docker compose -f docker-compose.prod.yml logs --tail=100 postgres
docker compose -f docker-compose.prod.yml logs --tail=100 nginx
docker compose -f docker-compose.prod.yml logs --tail=100 migrate
```

### A container exits immediately

```bash
docker compose -f docker-compose.prod.yml logs <service-name>
# Check: is .env complete? Is backend/.env present?
```

### api-server is stuck waiting for dependencies

```bash
# Check postgres health
docker compose -f docker-compose.prod.yml ps postgres
docker compose -f docker-compose.prod.yml logs postgres

# Check migrate completed
docker compose -f docker-compose.prod.yml ps migrate
docker compose -f docker-compose.prod.yml logs migrate

# Check python-backend health
docker compose -f docker-compose.prod.yml ps python-backend
docker compose -f docker-compose.prod.yml logs python-backend
```

### Migrations fail

```bash
docker compose -f docker-compose.prod.yml logs migrate
```

Common cause: `POSTGRES_PASSWORD_URLENC` doesn't match `POSTGRES_PASSWORD`. Special characters in the password (`@`, `#`, `!`) must be percent-encoded in the URL-encoded version.

```bash
# Check the connection string is correct
docker compose -f docker-compose.prod.yml config | grep DATABASE_URL
```

### Port 80 or 443 already in use

```bash
# Find what's using the port
sudo ss -tlnp | grep ':80'
sudo ss -tlnp | grep ':443'

# If Apache or another nginx is running, stop it
sudo systemctl stop apache2  # or nginx, if not Docker's
```

### Disk space issues

```bash
# Check disk usage
df -h

# Check Docker disk usage
docker system df

# Clean up
docker image prune -a -f
docker system prune -f
```

### Database connection issues

```bash
# Test database from inside the api-server container
docker compose -f docker-compose.prod.yml exec api-server \
  node --input-type=module \
  -e "import {db} from './dist/index.mjs'; console.log('connected')" || true

# Or connect directly to postgres
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U postgres -d Astro-sentinel -c "SELECT version();"
```

### Reset everything (nuclear option)

> ⚠️ **WARNING**: This deletes ALL data including the database.

```bash
docker compose -f docker-compose.prod.yml down -v --remove-orphans
docker system prune -af
docker volume prune -f

# Then redeploy from scratch
./deploy/scripts/deploy.sh
```

---

## File Reference

| File | Purpose |
|---|---|
| `docker-compose.prod.yml` | Production stack definition |
| `docker-compose.dev.yml` | Development stack (backend only) |
| `docker-compose.yml` | Quick-start stack |
| `deploy/nginx/nginx.conf` | Top-level reverse proxy config |
| `deploy/nginx/frontend-internal.conf` | Frontend container nginx (serve-only) |
| `deploy/scripts/deploy.sh` | First-time deployment script |
| `deploy/scripts/update.sh` | Rolling update/restart script |
| `deploy/scripts/backup.sh` | Manual/cron backup trigger |
| `deploy/scripts/restore.sh` | Database restore from backup |
| `deploy/logrotate/cosmic-alert` | Host logrotate config |
| `.github/workflows/ci.yml` | GitHub Actions CI pipeline |
| `.env.example` | Environment variable template |
| `DOCKER.md` | Docker-specific build/run reference |

---

## Quick Reference

```bash
# Start production stack
docker compose -f docker-compose.prod.yml up -d

# Stop production stack (data preserved)
docker compose -f docker-compose.prod.yml down

# View status
docker compose -f docker-compose.prod.yml ps

# View all logs live
docker compose -f docker-compose.prod.yml logs -f

# Update to latest code
./deploy/scripts/update.sh

# Create a backup
./deploy/scripts/backup.sh

# Restore from backup
./deploy/scripts/restore.sh backup_YYYYMMDD_HHMMSS.sql.gz
```
