#!/usr/bin/env bash
# deploy/scripts/deploy.sh
# ─────────────────────────────────────────────────────────────────────────────
# First-time deployment script for Transient Event Detection on a Linux VPS.
# Run ONCE after cloning the repository.
#
# PREREQUISITES (handled by this script):
#   • Docker and Docker Compose installed
#   • .env file present with real credentials
#   • backend/.env file present with GCN credentials
#
# USAGE
#   chmod +x deploy/scripts/deploy.sh
#   ./deploy/scripts/deploy.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.prod.yml"
LOG_PREFIX="[$(date '+%Y-%m-%d %H:%M:%S')] [deploy]"

cd "$PROJECT_ROOT"

echo "$LOG_PREFIX ═══════════════════════════════════════════════"
echo "$LOG_PREFIX  Transient Event Detection — First Deployment"
echo "$LOG_PREFIX ═══════════════════════════════════════════════"

# ── Pre-flight checks ─────────────────────────────────────────────────────────
echo "$LOG_PREFIX Checking prerequisites..."

command -v docker >/dev/null 2>&1 || { echo "ERROR: docker not found. Install Docker Desktop or Docker Engine."; exit 1; }
docker info >/dev/null 2>&1       || { echo "ERROR: Docker daemon is not running."; exit 1; }

[[ -f "$PROJECT_ROOT/.env" ]] || {
  echo "ERROR: .env not found. Copy .env.example → .env and fill in real values."
  exit 1
}

[[ -f "$PROJECT_ROOT/backend/.env" ]] || {
  echo "ERROR: backend/.env not found. Create it with GCN_CLIENT_ID and GCN_CLIENT_SECRET."
  exit 1
}

# Verify required env vars are set (not CHANGE_ME)
source "$PROJECT_ROOT/.env" 2>/dev/null || true
if [[ "${POSTGRES_PASSWORD:-CHANGE_ME}" == *CHANGE_ME* ]]; then
  echo "ERROR: POSTGRES_PASSWORD in .env is still a placeholder. Set a real value."
  exit 1
fi

echo "$LOG_PREFIX ✓ Prerequisites OK"

# ── Set up log directory on host ───────────────────────────────────────────────
echo "$LOG_PREFIX Setting up host log directory..."
sudo mkdir -p /var/log/cosmic-alert
sudo chmod 755 /var/log/cosmic-alert

# ── Install logrotate config ───────────────────────────────────────────────────
if [[ -f "$PROJECT_ROOT/deploy/logrotate/cosmic-alert" ]]; then
  echo "$LOG_PREFIX Installing logrotate config..."
  sudo cp "$PROJECT_ROOT/deploy/logrotate/cosmic-alert" /etc/logrotate.d/cosmic-alert
fi

# ── Set up cron for backups ────────────────────────────────────────────────────
echo "$LOG_PREFIX Setting up daily backup cron (2:00 AM)..."
CRON_JOB="0 2 * * * $PROJECT_ROOT/deploy/scripts/backup.sh >> /var/log/cosmic-alert/backup.log 2>&1"
(crontab -l 2>/dev/null | grep -v "cosmic-alert/deploy/scripts/backup.sh" ; echo "$CRON_JOB") | crontab - || true
echo "$LOG_PREFIX ✓ Cron job installed"

# ── Make all scripts executable ───────────────────────────────────────────────
chmod +x "$PROJECT_ROOT/deploy/scripts/"*.sh

# ── Enable BuildKit ────────────────────────────────────────────────────────────
export DOCKER_BUILDKIT=1

# ── Build images ──────────────────────────────────────────────────────────────
echo "$LOG_PREFIX Building Docker images (this may take 5-10 minutes)..."
docker compose -f "$COMPOSE_FILE" build --progress=plain

# ── Start the stack ───────────────────────────────────────────────────────────
echo "$LOG_PREFIX Starting the production stack..."
docker compose -f "$COMPOSE_FILE" up -d

# ── Wait for API to be healthy ─────────────────────────────────────────────────
echo "$LOG_PREFIX Waiting for api-server to become healthy (up to 3 minutes)..."
for i in $(seq 1 36); do
  if docker compose -f "$COMPOSE_FILE" ps api-server | grep -q "(healthy)"; then
    echo "$LOG_PREFIX ✓ api-server is healthy"
    break
  fi
  if [[ $i -eq 36 ]]; then
    echo "$LOG_PREFIX ✗ Timed out. Check logs: docker compose -f docker-compose.prod.yml logs"
    exit 1
  fi
  sleep 5
done

# ── Print status ──────────────────────────────────────────────────────────────
echo ""
echo "$LOG_PREFIX ═══════════════════════════════════════════════"
echo "$LOG_PREFIX  Deployment Complete!"
echo "$LOG_PREFIX ═══════════════════════════════════════════════"
docker compose -f "$COMPOSE_FILE" ps
echo ""
echo "$LOG_PREFIX Access the app: http://$(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_SERVER_IP')"
echo "$LOG_PREFIX API health:     http://$(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_SERVER_IP')/health/api"
echo ""
echo "$LOG_PREFIX Next steps:"
echo "$LOG_PREFIX   • Configure a domain name and set up HTTPS (see DEPLOY.md)"
echo "$LOG_PREFIX   • Check logs: docker compose -f docker-compose.prod.yml logs -f"
