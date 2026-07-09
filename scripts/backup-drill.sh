#!/bin/sh
# Daily pg_dump + restore drill. A backup nobody has restored is a backup
# nobody can trust — this proves each dump actually restores by loading it
# into a throwaway database and sanity-checking a row count, then records
# the result in backup_health so workerWatchdog.ts can page ops if a cycle
# is ever missing or failing (instead of silently rotting until the day
# someone actually needs to restore).
DB_HOST=postgres
DB_USER=grindly
DB_NAME=grindly
DRILL_DB=grindly_restore_check

while true; do
  STAMP=$(date +%Y%m%d_%H%M%S)
  DUMP_FILE="/backup/grindly_${STAMP}.sql.gz"

  if ! pg_dump -h "$DB_HOST" -U "$DB_USER" "$DB_NAME" | gzip > "$DUMP_FILE"; then
    echo "[backup] pg_dump FAILED"
    sleep 86400
    continue
  fi
  find /backup -name '*.sql.gz' -mtime +7 -delete
  echo "[backup] daily dump done: $DUMP_FILE"

  psql -h "$DB_HOST" -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS $DRILL_DB;" >/dev/null 2>&1
  psql -h "$DB_HOST" -U "$DB_USER" -d postgres -c "CREATE DATABASE $DRILL_DB;" >/dev/null 2>&1

  RESTORE_OK=false
  ROW_COUNT=0
  if gunzip -c "$DUMP_FILE" | psql -h "$DB_HOST" -U "$DB_USER" -d "$DRILL_DB" -q -v ON_ERROR_STOP=1 >/tmp/restore.log 2>&1; then
    ROW_COUNT=$(psql -h "$DB_HOST" -U "$DB_USER" -d "$DRILL_DB" -t -A -c "SELECT count(*) FROM users;" 2>/dev/null)
    ROW_COUNT=${ROW_COUNT:-0}
    ORIG_COUNT=$(psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -t -A -c "SELECT count(*) FROM users;" 2>/dev/null)
    ORIG_COUNT=${ORIG_COUNT:-0}
    if [ "$ORIG_COUNT" -eq 0 ] || [ "$ROW_COUNT" -ge "$ORIG_COUNT" ]; then
      RESTORE_OK=true
      echo "[backup] restore drill OK — users table restored with $ROW_COUNT rows (source has $ORIG_COUNT)"
    else
      echo "[backup] restore drill SUSPECT — restored $ROW_COUNT rows, source has $ORIG_COUNT"
    fi
  else
    echo "[backup] RESTORE DRILL FAILED — dump did not restore cleanly:"
    cat /tmp/restore.log
  fi

  psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c "
    CREATE TABLE IF NOT EXISTS backup_health (
      id TEXT PRIMARY KEY DEFAULT 'singleton',
      last_dump_at TIMESTAMPTZ,
      last_restore_at TIMESTAMPTZ,
      last_restore_ok BOOLEAN DEFAULT false,
      last_row_count INT,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    INSERT INTO backup_health (id, last_dump_at, last_restore_at, last_restore_ok, last_row_count, updated_at)
    VALUES ('singleton', now(), now(), ${RESTORE_OK}, ${ROW_COUNT}, now())
    ON CONFLICT (id) DO UPDATE SET
      last_dump_at = EXCLUDED.last_dump_at,
      last_restore_at = EXCLUDED.last_restore_at,
      last_restore_ok = EXCLUDED.last_restore_ok,
      last_row_count = EXCLUDED.last_row_count,
      updated_at = now();
  " || echo "[backup] failed to record backup_health row"

  psql -h "$DB_HOST" -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS $DRILL_DB;" >/dev/null 2>&1

  sleep 86400
done
