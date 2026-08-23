#!/usr/bin/env bash
# deploy/scripts/restore.sh
# ─────────────────────────────────────────────────────────────────────────────
# Restore a PostgreSQL backup for Transient Event Detection.
#
# USAGE
#   ./deploy/scripts/restore.sh backup_20240724_020000.sql.gz
#
# PROCESS
#   1. Stops api-server (prevent active connections during restore)
#   2. Drops and recreates the database
#   3. Restores from the gzipped pg_dump file
#   4. Restarts api-server
#
# WARNING: This is a destructive operation. All current data will be replaced.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BACKUP_FILE="${1:?Usage: restore.sh <backup_filename.sql.gz>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.prod.yml"
LOG_PREFIX="[$(date '+%Y-%m-%d %H:%M:%S')] [restore]"

# Load .env for DB variables
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  set -a; source "$PROJECT_ROOT/.env"; set +a
fi

POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-Astro-sentinel}"

echo "$LOG_PREFIX ════════════════════════════════════════════"
echo "$LOG_PREFIX  Transient Event Detection — Database Restore"
echo "$LOG_PREFIX ════════════════════════════════════════════"
echo "$LOG_PREFIX Backup file : $BACKUP_FILE"
echo "$LOG_PREFIX Database    : $POSTGRES_DB"
echo "$LOG_PREFIX User        : $POSTGRES_USER"
echo ""
echo "$LOG_PREFIX ⚠️  WARNING: All existing data will be PERMANENTLY REPLACED."
echo "$LOG_PREFIX    Press ENTER to continue or Ctrl+C to abort."
read -r

echo "$LOG_PREFIX Stopping api-server to prevent active connections..."
docker compose -f "$COMPOSE_FILE" stop api-server

echo "$LOG_PREFIX Restoring from backup: $BACKUP_FILE"
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  sh -c "dropdb -U $POSTGRES_USER --if-exists $POSTGRES_DB && \
         createdb -U $POSTGRES_USER $POSTGRES_DB && \
         zcat /backups/$BACKUP_FILE | psql -U $POSTGRES_USER $POSTGRES_DB"

echo "$LOG_PREFIX Restore complete. Restarting api-server..."
docker compose -f "$COMPOSE_FILE" start api-server

echo "$LOG_PREFIX ✓ Restore successful. api-server is back online."
