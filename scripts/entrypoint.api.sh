#!/bin/sh
# =============================================================================
# entrypoint.api.sh — Backend API Docker Entrypoint
# =============================================================================
#
# Docker entrypoint script for the Kalle API container. Orchestrates the
# complete startup sequence: service readiness checks, database migrations,
# optional seed data population, and application launch.
#
# Execution sequence:
#   1. Waits for PostgreSQL to accept TCP connections
#   2. Waits for Redis to accept TCP connections
#   3. Runs Prisma database migrations (prisma migrate deploy)
#   4. Optionally seeds the database (when SEED_ON_INIT=true)
#   5. Starts the application via exec "$@" (CMD passthrough)
#
# Required environment variables:
#   DATABASE_URL        — PostgreSQL connection string (used by Prisma)
#   REDIS_URL           — Redis connection string
#
# Optional environment variables:
#   PGHOST              — PostgreSQL hostname (default: postgres)
#   PGPORT              — PostgreSQL port (default: 5432)
#   REDIS_HOST          — Redis hostname (default: parsed from REDIS_URL, or redis)
#   REDIS_PORT          — Redis port (default: parsed from REDIS_URL, or 6379)
#   WAIT_TIMEOUT        — Service wait timeout in seconds (default: 30)
#   SEED_ON_INIT        — Set to "true" to run seed on boot (default: false)
#
# Docker usage:
#   ENTRYPOINT ["sh", "scripts/entrypoint.api.sh"]
#   CMD ["node", "apps/api/dist/server.js"]
#
# For development (docker-compose override):
#   CMD ["npx", "tsx", "watch", "apps/api/src/server.ts"]
#
# Notes:
#   - Uses #!/bin/sh (POSIX-compliant) for Alpine Linux compatibility
#   - Uses nc -z (netcat zero-I/O mode) for TCP readiness checks
#   - exec "$@" replaces the shell with the Node.js process for signal handling
#   - set -e ensures the container fails to start if any step fails (Rule R26)
#   - Environment variable defaults use Docker Compose service names
#
# Related files:
#   - scripts/wait-for-it.sh  — Standalone TCP wait utility (alternative approach)
#   - Dockerfile.api           — References this script as ENTRYPOINT
#   - docker-compose.yml       — Defines service dependencies and env vars
#   - prisma/schema.prisma     — Database schema for migrations
#   - prisma/seed.ts           — Deterministic seed data script
#
# =============================================================================

set -e

# =============================================================================
# Startup Banner
# =============================================================================
# Print a clearly visible banner with timestamp for Docker log visibility.
# Using date -u for consistent UTC timestamps across all environments.
# =============================================================================

echo "========================================"
echo " Kalle API — Entrypoint"
echo " $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "========================================"

# =============================================================================
# Environment Variable Resolution
# =============================================================================
# Resolve PostgreSQL and Redis connection parameters from available environment
# variables. Supports both explicit host/port variables and URL parsing.
#
# Priority for PostgreSQL:
#   1. PGHOST / PGPORT if explicitly set
#   2. Defaults to Docker Compose service names (postgres:5432)
#
# Priority for Redis:
#   1. REDIS_HOST / REDIS_PORT if explicitly set
#   2. Parsed from REDIS_URL if available
#   3. Defaults to Docker Compose service names (redis:6379)
# =============================================================================

# PostgreSQL connection parameters — PGHOST/PGPORT are standard libpq env vars
# and are typically set in .env.example for Docker environments
PG_HOST="${PGHOST:-postgres}"
PG_PORT="${PGPORT:-5432}"

# Redis connection parameters — parse from REDIS_URL if individual vars not set
# REDIS_URL format: redis://[[:password]@]host[:port][/db]
if [ -z "${REDIS_HOST}" ] && [ -n "${REDIS_URL}" ]; then
  # Strip the redis:// scheme prefix
  REDIS_URL_STRIPPED=$(echo "${REDIS_URL}" | sed 's|^redis://||')
  # Strip authentication (everything before @) if present
  REDIS_URL_HOSTPORT=$(echo "${REDIS_URL_STRIPPED}" | sed 's|^.*@||')
  # Extract host (everything before the first colon or slash)
  REDIS_HOST=$(echo "${REDIS_URL_HOSTPORT}" | sed 's|[:/ ].*||')
fi

if [ -z "${REDIS_PORT}" ] && [ -n "${REDIS_URL}" ]; then
  # Strip the redis:// scheme prefix
  REDIS_URL_STRIPPED=$(echo "${REDIS_URL}" | sed 's|^redis://||')
  # Strip authentication (everything before @) if present
  REDIS_URL_HOSTPORT=$(echo "${REDIS_URL_STRIPPED}" | sed 's|^.*@||')
  # Extract port (between first colon and next slash or end of string)
  REDIS_PORT=$(echo "${REDIS_URL_HOSTPORT}" | sed -n 's|^[^:]*:\([0-9]*\).*|\1|p')
fi

# Apply defaults for Redis if parsing yielded empty values
RD_HOST="${REDIS_HOST:-redis}"
RD_PORT="${REDIS_PORT:-6379}"

# Service wait timeout — configurable via environment, defaults to 30 seconds
WAIT_TIMEOUT="${WAIT_TIMEOUT:-30}"

echo "Configuration:"
echo "  PostgreSQL : ${PG_HOST}:${PG_PORT}"
echo "  Redis      : ${RD_HOST}:${RD_PORT}"
echo "  Timeout    : ${WAIT_TIMEOUT}s"
echo "  Seed       : ${SEED_ON_INIT:-false}"
echo ""

# =============================================================================
# wait_for_service — Wait for a TCP service to become available
# =============================================================================
# Repeatedly attempts a TCP connection to the given host:port using netcat
# (nc -z) in zero-I/O mode. Retries every 2 seconds until either the service
# responds or the configured timeout is exceeded.
#
# Uses timestamp-based elapsed time tracking (via date +%s) for accuracy,
# rather than counting sleep iterations which can drift.
#
# Arguments:
#   $1 — Human-readable service name (for log messages)
#   $2 — Hostname or IP address to connect to
#   $3 — TCP port number to probe
#   $4 — Timeout in seconds (0 = wait indefinitely)
#
# Returns:
#   0 — Service became available
#   Exits with code 1 if timeout is reached (fail-fast via set -e)
#
# Example:
#   wait_for_service "PostgreSQL" "postgres" "5432" "30"
# =============================================================================
wait_for_service() {
  _wfs_name="$1"
  _wfs_host="$2"
  _wfs_port="$3"
  _wfs_timeout="$4"

  echo "--- Waiting for ${_wfs_name} at ${_wfs_host}:${_wfs_port} ---"

  _wfs_start=$(date +%s)

  while true; do
    # Attempt TCP connection using netcat zero-I/O mode
    # nc -z: scan for listening daemons without sending data
    # Redirect stderr to /dev/null to suppress connection refused messages
    if nc -z "${_wfs_host}" "${_wfs_port}" 2>/dev/null; then
      _wfs_end=$(date +%s)
      _wfs_elapsed=$((_wfs_end - _wfs_start))
      echo "${_wfs_name} is ready! (connected after ${_wfs_elapsed}s)"
      return 0
    fi

    # Calculate elapsed time for timeout check and progress logging
    _wfs_now=$(date +%s)
    _wfs_elapsed=$((_wfs_now - _wfs_start))

    # Check if timeout has been exceeded (only when timeout > 0)
    if [ "${_wfs_timeout}" -gt 0 ] && [ "${_wfs_elapsed}" -ge "${_wfs_timeout}" ]; then
      echo "ERROR: Timeout after ${_wfs_timeout}s waiting for ${_wfs_name} at ${_wfs_host}:${_wfs_port}" >&2
      echo "  Possible causes:" >&2
      echo "    - ${_wfs_name} container has not started yet" >&2
      echo "    - ${_wfs_name} is misconfigured or crashed on startup" >&2
      echo "    - Network issue between containers" >&2
      echo "    - Incorrect host (${_wfs_host}) or port (${_wfs_port})" >&2
      exit 1
    fi

    # Calculate remaining time for progress message
    if [ "${_wfs_timeout}" -gt 0 ]; then
      _wfs_remaining=$((_wfs_timeout - _wfs_elapsed))
      echo "  ${_wfs_name} is unavailable — retrying in 2s (${_wfs_elapsed}s elapsed, ${_wfs_remaining}s remaining)"
    else
      echo "  ${_wfs_name} is unavailable — retrying in 2s (${_wfs_elapsed}s elapsed)"
    fi

    # Sleep 2 seconds before retrying to balance responsiveness and CPU usage
    sleep 2
  done
}

# =============================================================================
# Phase 1: Service Readiness Checks
# =============================================================================
# Wait for PostgreSQL and Redis to accept TCP connections before proceeding
# with database operations. This provides application-level safety beyond
# Docker Compose depends_on + healthcheck, which can have race conditions
# during initial startup.
#
# These checks ensure that:
#   - PostgreSQL is accepting connections on port 5432
#   - Redis is accepting connections on port 6379
#
# If either service does not become available within WAIT_TIMEOUT seconds,
# the entrypoint exits with code 1 and the container fails to start.
# =============================================================================

wait_for_service "PostgreSQL" "${PG_HOST}" "${PG_PORT}" "${WAIT_TIMEOUT}"
wait_for_service "Redis" "${RD_HOST}" "${RD_PORT}" "${WAIT_TIMEOUT}"

echo ""

# =============================================================================
# Phase 2: Database Migrations
# =============================================================================
# Apply all pending Prisma migrations using prisma migrate deploy.
#
# IMPORTANT: This uses "migrate deploy" (production-safe), NOT "migrate dev"
# which would attempt to generate new migrations. Per Rule R24, all schema
# changes are committed via Prisma Migrate and deployed via migrate deploy.
#
# Prerequisites:
#   - DATABASE_URL environment variable is set and points to a running PostgreSQL
#   - Prisma migration files exist in prisma/migrations/ directory
#   - Prisma client has been generated (prisma generate was run at build time)
#
# On failure:
#   - set -e causes the script to exit immediately
#   - The container will restart (if restart policy is set) or fail
#   - Docker logs will show the Prisma migration error output
# =============================================================================

echo "--- Running Database Migrations ---"
echo "Applying pending Prisma migrations..."
npx prisma migrate deploy
echo "Database migrations complete!"
echo ""

# =============================================================================
# Phase 3: Optional Database Seeding
# =============================================================================
# Seeds the database with deterministic test data when SEED_ON_INIT=true.
#
# Per Rule R10: The seed script (prisma/seed.ts) is idempotent — running it
# multiple times produces identical state. This means it's safe to set
# SEED_ON_INIT=true even on subsequent container restarts.
#
# The seed script generates:
#   - 10+ test users with valid credentials
#   - 5+ conversations (1:1 and group)
#   - Messages with valid ciphertext
#   - Encryption key bundles
#   - Media, stories, and other test data
#
# The seed command is configured in package.json via the prisma.seed field,
# typically pointing to: npx tsx prisma/seed.ts
# =============================================================================

if [ "${SEED_ON_INIT:-false}" = "true" ]; then
  echo "--- Seeding Database ---"
  echo "Running idempotent seed script..."
  npx prisma db seed
  echo "Database seeded successfully!"
  echo ""
fi

# =============================================================================
# Phase 4: Start Application
# =============================================================================
# Hand off to the application process using exec "$@".
#
# exec replaces the current shell process with the command specified by the
# Docker CMD instruction (or docker-compose command override). This is critical
# for proper Docker signal handling — SIGTERM from Docker stop/restart is
# delivered directly to the Node.js process, enabling graceful shutdown.
#
# Without exec, the shell would remain as PID 1 and the Node.js process
# would be a child process that may not receive signals properly.
#
# Production CMD:    node apps/api/dist/server.js
# Development CMD:   npx tsx watch apps/api/src/server.ts
# =============================================================================

echo "--- Starting Application ---"
echo "Executing: $*"
echo "========================================"
exec "$@"
