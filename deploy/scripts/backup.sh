#!/usr/bin/env bash
# deploy/scripts/backup.sh
# ─────────────────────────────────────────────────────────────────────────────
# Automated PostgreSQL backup for Transient Event Detection.
# Invokes the `backup` Docker Compose service which runs pg_dump inside
# the cosmic-prod network, then gzips and timestamps the output.
#
# USAGE
#   Manual:  ./deploy/scripts/backup.sh
#   Cron:    Add to root crontab on the VPS host:
#              0 2 * * * /opt/cosmic-alert/deploy/scripts/backup.sh >> /var/log/cosmic-backup.log 2>&1
#
# The backup files land in the `postgres_backups` Docker named volume.
# To see them on the host:
#   docker run --rm -v cosmic-alert-system_postgres_backups:/backups alpine ls -lh /backups
#
# To copy all backups to the host filesystem:
#   docker run --rm \
#     -v cosmic-alert-system_postgres_backups:/backups \
#     -v /opt/backups:/dest \
#     alpine cp -r /backups/. /dest/
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.prod.yml"
LOG_PREFIX="[$(date '+%Y-%m-%d %H:%M:%S')] [backup]"

echo "$LOG_PREFIX Starting PostgreSQL backup..."

# Run the backup service (profile=backup, not started by default)
docker compose -f "$COMPOSE_FILE" --profile backup run --rm backup

echo "$LOG_PREFIX Backup completed successfully."
echo "$LOG_PREFIX List current backups:"
docker run --rm \
  -v "$(docker compose -f "$COMPOSE_FILE" config --format json | python3 -c "
import sys, json
cfg = json.load(sys.stdin)
proj = cfg.get('name', 'cosmic-alert-system')
print(proj + '_postgres_backups')
" 2>/dev/null || echo "cosmic-alert-system_postgres_backups"):/backups \
  alpine:latest \
  find /backups -name "backup_*.sql.gz" -exec ls -lh {} \; 2>/dev/null || true
