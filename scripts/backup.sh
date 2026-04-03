#!/bin/sh
set -e

# ============================================================================
# Kalle — PostgreSQL Backup Script
# ============================================================================
#
# Purpose:
#   Creates a compressed PostgreSQL database backup using pg_dump with gzip
#   compression, then removes backup files older than the configured retention
#   period. Designed to run on a daily cron schedule inside the backup Docker
#   service container (Alpine Linux).
#
# Usage:
#   This script is invoked by cron inside the Dockerfile.backup container.
#   All PostgreSQL connection parameters are supplied via environment variables
#   set in docker-compose.yml (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE).
#
# Environment Variables:
#   PGHOST                 - PostgreSQL host (default: "postgres")
#   PGPORT                 - PostgreSQL port (default: 5432)
#   PGUSER                 - PostgreSQL username (required)
#   PGPASSWORD             - PostgreSQL password (required, used by libpq)
#   PGDATABASE             - PostgreSQL database name (required)
#   BACKUP_RETENTION_DAYS  - Number of days to retain backups (default: 7)
#
# Output:
#   Compressed backup files at /backups/kalle_db_YYYYMMDD_HHMMSS.sql.gz
#
# Rules:
#   R36 — Daily pg_dump archives to ./backups/ with 7-day retention
#   R38 — Zero external dependencies; runs inside Docker only
# ============================================================================

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Backup destination directory — mounted from host ./backups via Docker volume
BACKUP_DIR="/backups"

# Retention period in days (default 7 per Rule R36)
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"

# Generate unique timestamped filename for this backup run
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/kalle_db_${TIMESTAMP}.sql.gz"

# PostgreSQL connection defaults (Docker Compose service name)
PGHOST="${PGHOST:-postgres}"
PGPORT="${PGPORT:-5432}"
export PGHOST PGPORT

# ---------------------------------------------------------------------------
# Pre-flight Checks
# ---------------------------------------------------------------------------

# Validate required environment variables are set
if [ -z "${PGUSER}" ]; then
  echo "ERROR: PGUSER environment variable is not set." >&2
  exit 1
fi

if [ -z "${PGDATABASE}" ]; then
  echo "ERROR: PGDATABASE environment variable is not set." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Startup Banner
# ---------------------------------------------------------------------------

echo "========================================"
echo " Kalle DB Backup"
echo " Started: $(date)"
echo " Host:    ${PGHOST}:${PGPORT}"
echo " Database: ${PGDATABASE}"
echo " User:    ${PGUSER}"
echo " Retention: ${RETENTION_DAYS} days"
echo "========================================"

# ---------------------------------------------------------------------------
# Ensure Backup Directory Exists
# ---------------------------------------------------------------------------

mkdir -p "${BACKUP_DIR}"

# ---------------------------------------------------------------------------
# Execute pg_dump with Gzip Compression
# ---------------------------------------------------------------------------

echo "Creating backup: ${BACKUP_FILE}"

# ---------------------------------------------------------------------------
# Two-step dump-then-compress pattern for reliable failure detection.
# ---------------------------------------------------------------------------
# A piped `pg_dump | gzip > file` silently masks pg_dump failures because
# gzip creates a valid (but empty-content) .gz file from empty stdin, and
# the `-s` size check passes on the gzip headers (~20 bytes). By writing
# the raw SQL to a temp file first, we can detect pg_dump failures via
# exit code and verify actual content before compressing.
# ---------------------------------------------------------------------------

TEMP_DUMP="${BACKUP_DIR}/kalle_db_${TIMESTAMP}.sql.tmp"

# pg_dump outputs SQL in plain text format to a temporary file.
# --no-owner:      Omit ownership assignment commands (portable across roles)
# --no-privileges: Omit GRANT/REVOKE statements (portable across environments)
# PGPASSWORD is read automatically by libpq from the environment variable.
if ! pg_dump \
  -h "${PGHOST}" \
  -p "${PGPORT}" \
  -U "${PGUSER}" \
  -d "${PGDATABASE}" \
  --no-owner \
  --no-privileges \
  > "${TEMP_DUMP}" 2>&1; then
  echo "ERROR: pg_dump command failed!" >&2
  rm -f "${TEMP_DUMP}"
  exit 1
fi

# ---------------------------------------------------------------------------
# Verify pg_dump Output Integrity
# ---------------------------------------------------------------------------

# Ensure the raw dump file is non-empty before compressing. An empty file
# indicates pg_dump produced no output (connection or auth failure).
if [ ! -s "${TEMP_DUMP}" ]; then
  echo "ERROR: pg_dump produced empty output — backup failed!" >&2
  rm -f "${TEMP_DUMP}"
  exit 1
fi

# Compress the verified dump into the final backup file and remove the temp
gzip -c "${TEMP_DUMP}" > "${BACKUP_FILE}"
rm -f "${TEMP_DUMP}"

# ---------------------------------------------------------------------------
# Verify Compressed Backup Integrity
# ---------------------------------------------------------------------------

# Final safety check: verify the gzip file exists and has meaningful size
if [ ! -s "${BACKUP_FILE}" ]; then
  echo "ERROR: Backup compression failed — gzip file is empty!" >&2
  rm -f "${BACKUP_FILE}"
  exit 1
fi

# Report backup size for operational visibility in cron logs
BACKUP_SIZE=$(du -h "${BACKUP_FILE}" | cut -f1)
echo "Backup created successfully: ${BACKUP_FILE} (${BACKUP_SIZE})"

# ---------------------------------------------------------------------------
# Retention Cleanup — Remove Backups Older Than RETENTION_DAYS
# ---------------------------------------------------------------------------

echo "Cleaning up backups older than ${RETENTION_DAYS} days..."

# Count files that will be deleted for log reporting. Only target files
# matching the backup naming pattern to avoid deleting unrelated files
# in the same directory.
DELETED_COUNT=$(find "${BACKUP_DIR}" -name "kalle_db_*.sql.gz" -type f -mtime +"${RETENTION_DAYS}" 2>/dev/null | wc -l)

# Delete expired backup files. The || true guard prevents a non-zero exit
# when no files match the criteria (find returns 0, but defensive coding).
find "${BACKUP_DIR}" -name "kalle_db_*.sql.gz" -type f -mtime +"${RETENTION_DAYS}" -delete 2>/dev/null || true

echo "Deleted ${DELETED_COUNT} expired backup(s)."

# ---------------------------------------------------------------------------
# Completion Summary
# ---------------------------------------------------------------------------

REMAINING=$(find "${BACKUP_DIR}" -name "kalle_db_*.sql.gz" -type f | wc -l)

echo "========================================"
echo " Backup Complete"
echo " File:     ${BACKUP_FILE}"
echo " Size:     ${BACKUP_SIZE}"
echo " Retained: ${REMAINING} backup(s)"
echo " Finished: $(date)"
echo "========================================"

exit 0
