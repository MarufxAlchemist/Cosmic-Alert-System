#!/usr/bin/env bash
# deploy/scripts/update.sh
# ─────────────────────────────────────────────────────────────────────────────
# Update Transient Event Detection to the latest version from git.
# Performs a rolling restart: pulls new code, rebuilds changed images,
# restarts services one at a time to minimize downtime.
#
# USAGE
#   ./deploy/scripts/update.sh
#   ./deploy/scripts/update.sh --no-pull   # Skip git pull (use current code)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.prod.yml"
LOG_PREFIX="[$(date '+%Y-%m-%d %H:%M:%S')] [update]"
NO_PULL="${1:-}"

cd "$PROJECT_ROOT"

echo "$LOG_PREFIX ═══════════════════════════════════════════════"
echo "$LOG_PREFIX  Transient Event Detection — Update"
echo "$LOG_PREFIX ═══════════════════════════════════════════════"

# ── Git pull ──────────────────────────────────────────────────────────────────
if [[ "$NO_PULL" != "--no-pull" ]]; then
  echo "$LOG_PREFIX Pulling latest changes from git..."
  git pull origin main
  echo "$LOG_PREFIX ✓ Code updated"
else
  echo "$LOG_PREFIX Skipping git pull (--no-pull specified)"
fi

CURRENT_COMMIT=$(git rev-parse --short HEAD)
echo "$LOG_PREFIX Current commit: $CURRENT_COMMIT"

# ── Rebuild images ────────────────────────────────────────────────────────────
export DOCKER_BUILDKIT=1

echo "$LOG_PREFIX Rebuilding Docker images..."
docker compose -f "$COMPOSE_FILE" build --progress=plain

# ── Run migrations (in case schema changed) ───────────────────────────────────
echo "$LOG_PREFIX Running database migrations..."
docker compose -f "$COMPOSE_FILE" run --rm migrate || {
  echo "$LOG_PREFIX ✗ Migrations failed. Rolling back is NOT automatic."
  echo "$LOG_PREFIX   Check logs and restore from backup if needed."
  exit 1
}

# ── Restart services (one at a time for minimal downtime) ─────────────────────
echo "$LOG_PREFIX Restarting services..."

# Restart backend services first
docker compose -f "$COMPOSE_FILE" up -d --no-deps python-backend
echo "$LOG_PREFIX ↻ python-backend restarted"

docker compose -f "$COMPOSE_FILE" up -d --no-deps api-server
echo "$LOG_PREFIX ↻ api-server restarted"

docker compose -f "$COMPOSE_FILE" up -d --no-deps frontend
echo "$LOG_PREFIX ↻ frontend restarted"

docker compose -f "$COMPOSE_FILE" up -d --no-deps nginx
echo "$LOG_PREFIX ↻ nginx restarted"

# ── Verify health ─────────────────────────────────────────────────────────────
echo "$LOG_PREFIX Waiting for api-server to become healthy..."
for i in $(seq 1 24); do
  if docker compose -f "$COMPOSE_FILE" ps api-server | grep -q "(healthy)"; then
    echo "$LOG_PREFIX ✓ api-server is healthy"
    break
  fi
  if [[ $i -eq 24 ]]; then
    echo "$LOG_PREFIX ✗ api-server did not become healthy in 2 minutes."
    echo "$LOG_PREFIX   Check: docker compose -f docker-compose.prod.yml logs api-server"
    exit 1
  fi
  sleep 5
done

# ── Clean up dangling images ───────────────────────────────────────────────────
echo "$LOG_PREFIX Cleaning up dangling Docker images..."
docker image prune -f

echo ""
echo "$LOG_PREFIX ✓ Update complete — commit $CURRENT_COMMIT is running."
docker compose -f "$COMPOSE_FILE" ps
