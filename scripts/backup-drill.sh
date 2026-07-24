#!/bin/sh
# Daily pg_dump + restore drill. A backup nobody has restored is a backup
# nobody can trust — this proves each dump actually restores by loading it
# into a throwaway database and sanity-checking a row count, then records
# the result in backup_health so workerWatchdog.ts can page ops if a cycle
# is ever missing or failing (instead of silently rotting until the day
# someone actually needs to restore).
#
# Two bugs made this produce four days of EMPTY backups, silently:
#
#   1. It authenticated with PGPASSWORD=$POSTGRES_PASSWORD, but that variable
#      holds the password in its URL-ENCODED form (it exists to be substituted
#      into DATABASE_URL). The real password contains characters that encode to
#      %40 and %23, so the literal string libpq received was simply a different
#      password and every connection was rejected. The app was fine throughout,
#      because it connects with DATABASE_URL and libpq decodes the URI for it.
#      So: connect the same way the app does, with the connection string that is
#      known to work, and never hand-assemble credentials here again.
#
#   2. `if ! pg_dump ... | gzip > "$FILE"` reports the exit status of the LAST
#      command in the pipeline — gzip — which cheerfully succeeds at compressing
#      nothing. pg_dump's failure was invisible, a 20-byte file was written, and
#      the script logged "daily dump done". Every dump since 2026-07-20 was
#      empty and nothing said a word. pg_dump's status is now captured on its
#      own, and the result is size-checked before it counts as a backup.
set -u

: "${DATABASE_URL:?[backup] DATABASE_URL is not set — the backup service needs it in docker-compose.yml}"

DRILL_DB=grindly_restore_check
# A dump with a schema but no rows is still several KB; anything under this is
# a failure that produced output, which is the case a plain "is it empty" check
# would wave through.
MIN_DUMP_BYTES=1000

# Swap the database name in the connection URI, preserving user, password, host
# and any query string. The password is left untouched and still encoded, which
# is exactly what libpq wants.
url_with_db() {
  printf '%s' "$DATABASE_URL" | sed -E "s#/[^/?]*(\?.*)?\$#/$1\1#"
}

MAIN_URL="$DATABASE_URL"
POSTGRES_URL=$(url_with_db postgres)
DRILL_URL=$(url_with_db "$DRILL_DB")

while true; do
  STAMP=$(date +%Y%m%d_%H%M%S)
  DUMP_FILE="/backup/grindly_${STAMP}.sql.gz"
  DUMP_OK=false

  # Status of pg_dump ITSELF, not of gzip downstream of it.
  if pg_dump "$MAIN_URL" 2>/tmp/dump.log | gzip > "$DUMP_FILE"; then
    DUMP_BYTES=$(wc -c < "$DUMP_FILE" 2>/dev/null || echo 0)
    if [ "$DUMP_BYTES" -ge "$MIN_DUMP_BYTES" ]; then
      DUMP_OK=true
      echo "[backup] daily dump done: $DUMP_FILE (${DUMP_BYTES} bytes)"
    else
      echo "[backup] DUMP TOO SMALL (${DUMP_BYTES} bytes) — treating as failure:"
      cat /tmp/dump.log
    fi
  else
    echo "[backup] pg_dump FAILED:"
    cat /tmp/dump.log
  fi

  if [ "$DUMP_OK" != "true" ]; then
    # Keep the evidence rather than leaving a plausible-looking empty archive
    # in the directory for someone to find on the day they need it.
    rm -f "$DUMP_FILE"
    psql "$MAIN_URL" -q -c "
      CREATE TABLE IF NOT EXISTS backup_health (
        id TEXT PRIMARY KEY DEFAULT 'singleton',
        last_dump_at TIMESTAMPTZ,
        last_restore_at TIMESTAMPTZ,
        last_restore_ok BOOLEAN DEFAULT false,
        last_row_count INT,
        updated_at TIMESTAMPTZ DEFAULT now()
      );
      INSERT INTO backup_health (id, last_restore_ok, last_row_count, updated_at)
      VALUES ('singleton', false, 0, now())
      ON CONFLICT (id) DO UPDATE SET last_restore_ok = false, updated_at = now();
    " >/dev/null 2>&1 || echo "[backup] could not record the failure either"
    sleep 86400
    continue
  fi

  find /backup -name '*.sql.gz' -mtime +7 -delete

  psql "$POSTGRES_URL" -c "DROP DATABASE IF EXISTS $DRILL_DB;" >/dev/null 2>&1
  psql "$POSTGRES_URL" -c "CREATE DATABASE $DRILL_DB;" >/dev/null 2>&1

  RESTORE_OK=false
  ROW_COUNT=0
  if gunzip -c "$DUMP_FILE" | psql "$DRILL_URL" -q -v ON_ERROR_STOP=1 >/tmp/restore.log 2>&1; then
    ROW_COUNT=$(psql "$DRILL_URL" -t -A -c "SELECT count(*) FROM users;" 2>/dev/null)
    ROW_COUNT=${ROW_COUNT:-0}
    ORIG_COUNT=$(psql "$MAIN_URL" -t -A -c "SELECT count(*) FROM users;" 2>/dev/null)
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

  psql "$MAIN_URL" -v ON_ERROR_STOP=1 -c "
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

  psql "$POSTGRES_URL" -c "DROP DATABASE IF EXISTS $DRILL_DB;" >/dev/null 2>&1

  sleep 86400
done
