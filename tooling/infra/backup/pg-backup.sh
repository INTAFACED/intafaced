#!/bin/sh
# The hosted beta's database backup and restore (#10211). POSIX sh, so it runs in the postgres:16-alpine image the
# `pg-backup` compose service uses (profile `beta`), whose pg_dump matches the server's major version.
#
#   pg-backup.sh backup            one backup now: the roles, then every database, into $BACKUP_DIR/<UTC stamp>/
#   pg-backup.sh restore <dir>     restore one backup into a FRESH server: refuses a database that already exists
#   pg-backup.sh nightly           backup at $BACKUP_AT_UTC (HH:MM, UTC) every day, forever
#
# Connection: the libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD), as a superuser: the roles are read and written.
# BACKUP_DIR (default /backups) holds the backups; KEEP (default 14) is how many are kept, newest first.
# METRICS_DIR, when set, gets intafaced_backup.prom for node-exporter's textfile collector, which the alert
# `BackupStale` reads (tooling/infra/prometheus-alerts.yaml).
#
# To restore on the host: stop the services, start a fresh, empty Postgres (a new volume, POSTGRES_DB=postgres so it
# holds none of our databases), then from the pg-backup container (`docker compose --profile beta run --rm pg-backup
# sh /backup-bin/pg-backup.sh restore /backups/<stamp>`), with PGHOST naming that fresh server.
#
# A backup is written into <stamp>.partial and renamed only once every file and its checksum are on disk, so a crash
# mid-backup leaves a .partial that restore never reads and the next backup removes. Tested end to end, restore into
# a fresh server included, by tooling/infra/backup/pg-backup.test.mjs.
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
KEEP=${KEEP:-14}
export PGDATABASE=${PGDATABASE:-postgres}

log() { printf '%s pg-backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "refused: $*"; exit 1; }

write_metrics() { # <status 1|0>
  [ -n "${METRICS_DIR:-}" ] || return 0
  mkdir -p "$METRICS_DIR"
  now=$(date -u +%s)
  tmp="$METRICS_DIR/.intafaced_backup.prom.$$"
  {
    echo '# HELP intafaced_backup_last_attempt_timestamp_seconds When the last backup attempt ended.'
    echo '# TYPE intafaced_backup_last_attempt_timestamp_seconds gauge'
    echo "intafaced_backup_last_attempt_timestamp_seconds $now"
    echo '# HELP intafaced_backup_last_attempt_success 1 when the last backup attempt succeeded, else 0.'
    echo '# TYPE intafaced_backup_last_attempt_success gauge'
    echo "intafaced_backup_last_attempt_success $1"
    if [ "$1" = 1 ]; then last=$now; else last=${LAST_SUCCESS:-}; fi
    if [ -n "$last" ]; then
      echo '# HELP intafaced_backup_last_success_timestamp_seconds When the last complete backup was written.'
      echo '# TYPE intafaced_backup_last_success_timestamp_seconds gauge'
      echo "intafaced_backup_last_success_timestamp_seconds $last"
    fi
  } > "$tmp"
  mv "$tmp" "$METRICS_DIR/intafaced_backup.prom"
}

previous_success() {
  [ -n "${METRICS_DIR:-}" ] && [ -f "$METRICS_DIR/intafaced_backup.prom" ] || return 0
  sed -n 's/^intafaced_backup_last_success_timestamp_seconds //p' "$METRICS_DIR/intafaced_backup.prom"
}

databases() {
  psql -XAtqc "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY datname"
}

backup() {
  mkdir -p "$BACKUP_DIR"
  rm -rf "$BACKUP_DIR"/*.partial
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  work="$BACKUP_DIR/$stamp.partial"
  mkdir "$work"
  pg_dumpall --globals-only --file="$work/globals.sql"
  dbs=$(databases)
  [ -n "$dbs" ] || die "the server holds no database to back up"
  for db in $dbs; do
    pg_dump --format=custom --dbname="$db" --file="$work/db-$db.dump"
  done
  printf '%s\n' $dbs > "$work/databases.txt"
  (cd "$work" && sha256sum globals.sql databases.txt db-*.dump > SHA256SUMS)
  mv "$work" "$BACKUP_DIR/$stamp"
  # Keep the newest $KEEP complete backups. Stamps sort by time.
  ls -1d "$BACKUP_DIR"/2*Z 2>/dev/null | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do rm -rf "$old"; done
  log "backup $stamp: $(echo $dbs | wc -w) database(s), $(du -sk "$BACKUP_DIR/$stamp" | cut -f1) KiB"
}

restore() { # <backup dir>
  src=${1:-}
  [ -n "$src" ] && [ -d "$src" ] || die "restore needs a backup directory"
  case "$src" in *.partial | *.partial/) die "$src is an unfinished backup" ;; esac
  (cd "$src" && sha256sum -c -s SHA256SUMS) || die "$src fails its checksums"
  existing=$(databases)
  for db in $(cat "$src/databases.txt"); do
    for have in $existing; do [ "$have" != "$db" ] || die "database $db already exists: restore only into a fresh server"; done
  done
  # A fresh server already has the bootstrap superuser, so its CREATE ROLE fails with "already exists" and the ALTER
  # ROLE after it still sets its attributes. Any other error stops the restore.
  errs=$(psql -X -q -f "$src/globals.sql" 2>&1 >/dev/null | grep 'ERROR' | grep -v 'already exists' || true)
  [ -z "$errs" ] || die "restoring the roles failed: $errs"
  for db in $(cat "$src/databases.txt"); do
    pg_restore --create --exit-on-error --dbname=postgres "$src/db-$db.dump"
  done
  log "restored $(basename "$src"): $(wc -l < "$src/databases.txt") database(s)"
}

nightly() {
  at=${BACKUP_AT_UTC:-19:17} # 03:17 in Bali (UTC+8), the quietest hour of the beta
  h=${at%:*}
  m=${at#*:}
  while :; do
    now=$(date -u +%s)
    next=$(( now / 86400 * 86400 + ${h#0} * 3600 + ${m#0} * 60 ))
    [ "$next" -gt "$now" ] || next=$((next + 86400))
    log "next backup at $(date -u -d "@$next" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "$next")"
    sleep $((next - now))
    LAST_SUCCESS=$(previous_success)
    # A separate process, not `if backup`: errexit is off inside an if condition, so a failed pg_dump would pass.
    if sh "$0" _backup; then write_metrics 1; else log "backup failed"; write_metrics 0; fi
  done
}

case "${1:-}" in
  backup)
    LAST_SUCCESS=$(previous_success)
    if sh "$0" _backup; then write_metrics 1; else write_metrics 0; exit 1; fi
    ;;
  _backup) backup ;;
  restore) restore "${2:-}" ;;
  nightly) nightly ;;
  *) die "usage: pg-backup.sh backup | restore <dir> | nightly" ;;
esac
