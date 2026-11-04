#!/usr/bin/env bash
# DSH 账号服务每日备份：pg_dump 压缩 + 保留 14 天
# 用法：/opt/dsh-account/deploy/backup.sh
set -euo pipefail
cd "$(dirname "$0")"
BACKUP_DIR="${BACKUP_DIR:-/opt/dsh-account/backups}"
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d_%H%M%S)
FILE="$BACKUP_DIR/dsh-account-$STAMP.sql.gz"
docker compose exec -T db pg_dump -U dsh -d dsh_account --no-owner | gzip -9 > "$FILE"
chmod 600 "$FILE"
# 保留最近 14 天
find "$BACKUP_DIR" -name 'dsh-account-*.sql.gz' -mtime +14 -delete
echo "[backup] $(date '+%F %T') -> $FILE ($(stat -c%s "$FILE") bytes)"
