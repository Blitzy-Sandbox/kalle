#!/bin/sh
# =============================================================================
# wait-for-it.sh — Wait for a TCP service to become available
# =============================================================================
#
# Generic TCP port readiness wait script for Docker service dependencies.
# Used by entrypoint scripts (e.g., entrypoint.api.sh) to block until a
# service is accepting TCP connections on a given host:port.
#
# This script is POSIX-compliant (no bash-isms) and works in Alpine Linux
# (BusyBox ash shell). It uses netcat (nc -z) for TCP connection probing.
#
# Usage:
#   wait-for-it.sh host:port [-t timeout] [-s] [-q] [-- command args]
#
# Examples:
#   # Wait for PostgreSQL with 30s timeout (default)
#   ./scripts/wait-for-it.sh postgres:5432
#
#   # Wait for Redis with 15s timeout in strict mode
#   ./scripts/wait-for-it.sh redis:6379 -t 15 -s
#
#   # Wait for PostgreSQL then run migrations
#   ./scripts/wait-for-it.sh postgres:5432 -t 30 -s -- npx prisma migrate deploy
#
#   # Wait quietly (no progress output)
#   ./scripts/wait-for-it.sh postgres:5432 -q -s
#
# Options:
#   host:port        Required. The host and port to wait for (colon-separated)
#   -t TIMEOUT       Timeout in seconds (default: 30, 0 = wait forever)
#   -s, --strict     Exit with error code 1 if timeout is reached
#   -q, --quiet      Suppress all non-error output
#   -h, --help       Show this help message
#   -- CMD ARGS      Execute command with args after the service is available
#
# Exit Codes:
#   0   Service became available (or timeout in non-strict mode)
#   1   Timeout reached in strict mode, or missing required arguments
#
# =============================================================================

# Configuration defaults
WAITFORIT_TIMEOUT=30
WAITFORIT_STRICT=0
WAITFORIT_QUIET=0
WAITFORIT_HOST=""
WAITFORIT_PORT=""
WAITFORIT_CMD=""
WAITFORIT_PROGRESS_INTERVAL=5
WAITFORIT_TCP_METHOD=""

# -----------------------------------------------------------------------------
# usage — Print help text and exit with code 1
# -----------------------------------------------------------------------------
usage() {
  cat >&2 <<'USAGE_EOF'
Usage: wait-for-it.sh host:port [-t timeout] [-s] [-q] [-- command args]

Wait for a TCP service to become available before proceeding.

Arguments:
  host:port        The host and port to connect to (required)

Options:
  -t TIMEOUT       Timeout in seconds (default: 30, 0 for infinite wait)
  --timeout=N      Same as -t N
  -s, --strict     Exit non-zero if the service is not ready before timeout
  -q, --quiet      Suppress non-error output messages
  -h, --help       Display this help message and exit
  -- CMD ARGS      Execute CMD with ARGS after the service becomes available

Examples:
  wait-for-it.sh postgres:5432 -t 30 -s
  wait-for-it.sh redis:6379 -t 15 -- echo "Redis is ready"
  wait-for-it.sh db:3306 --timeout=60 --strict -- node server.js
USAGE_EOF
  exit 1
}

# -----------------------------------------------------------------------------
# log — Print a message to stdout if not in quiet mode
# Arguments:
#   $1 — message string
# -----------------------------------------------------------------------------
log() {
  if [ "$WAITFORIT_QUIET" -eq 0 ]; then
    echo "$1"
  fi
}

# -----------------------------------------------------------------------------
# log_error — Print an error message to stderr (always, regardless of quiet)
# Arguments:
#   $1 — error message string
# -----------------------------------------------------------------------------
log_error() {
  echo "ERROR: $1" >&2
}

# -----------------------------------------------------------------------------
# detect_tcp_method — Detect the best available TCP check method
#
# Probes for available TCP connection test tools in order of preference:
#   1. nc (netcat) — Available by default in Alpine Linux (BusyBox)
#   2. bash /dev/tcp — Available in bash environments
#   3. python3 socket — Fallback using Python's socket module
#
# Sets WAITFORIT_TCP_METHOD to the name of the detected method.
# Returns 1 if no method is available.
# -----------------------------------------------------------------------------
detect_tcp_method() {
  # Prefer nc (netcat) — native in Alpine/BusyBox
  if command -v nc > /dev/null 2>&1; then
    WAITFORIT_TCP_METHOD="nc"
    return 0
  fi

  # Fallback: bash /dev/tcp pseudo-device
  if command -v bash > /dev/null 2>&1; then
    WAITFORIT_TCP_METHOD="bash"
    return 0
  fi

  # Fallback: Python3 socket module
  if command -v python3 > /dev/null 2>&1; then
    WAITFORIT_TCP_METHOD="python3"
    return 0
  fi

  # Fallback: Python (2 or 3)
  if command -v python > /dev/null 2>&1; then
    WAITFORIT_TCP_METHOD="python"
    return 0
  fi

  return 1
}

# -----------------------------------------------------------------------------
# check_tcp — Attempt a single TCP connection using the detected method
#
# Uses the method selected by detect_tcp_method to probe the target host:port.
# Each method has a 1-second timeout to avoid blocking.
#
# Returns:
#   0 — Connection succeeded (port is accepting connections)
#   1 — Connection failed (port not reachable or refused)
# -----------------------------------------------------------------------------
check_tcp() {
  case "$WAITFORIT_TCP_METHOD" in
    nc)
      # netcat zero-I/O mode: probe TCP without sending data
      nc -z "$WAITFORIT_HOST" "$WAITFORIT_PORT" > /dev/null 2>&1
      return $?
      ;;
    bash)
      # bash /dev/tcp pseudo-device: open and immediately close a TCP socket
      bash -c "echo > /dev/tcp/$WAITFORIT_HOST/$WAITFORIT_PORT" > /dev/null 2>&1
      return $?
      ;;
    python3)
      # Python3 socket: connect with 1-second timeout
      python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(1)
try:
    s.connect(('$WAITFORIT_HOST', $WAITFORIT_PORT))
    s.close()
except Exception:
    exit(1)
" > /dev/null 2>&1
      return $?
      ;;
    python)
      # Python (2/3) socket: connect with 1-second timeout
      python -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(1)
try:
    s.connect(('$WAITFORIT_HOST', $WAITFORIT_PORT))
    s.close()
except Exception:
    exit(1)
" > /dev/null 2>&1
      return $?
      ;;
    *)
      return 1
      ;;
  esac
}

# -----------------------------------------------------------------------------
# wait_for — Core TCP connection wait loop
#
# Repeatedly attempts a TCP connection to WAITFORIT_HOST:WAITFORIT_PORT
# using the best available method (nc, bash /dev/tcp, or python). Retries
# every 1 second until either the connection succeeds or the configured
# timeout expires.
#
# Prints progress messages every WAITFORIT_PROGRESS_INTERVAL seconds for
# Docker log visibility during long waits.
#
# Returns:
#   0 — Connection successful (or timeout reached in non-strict mode)
#   1 — Timeout reached in strict mode
# -----------------------------------------------------------------------------
wait_for() {
  log "wait-for-it: waiting ${WAITFORIT_TIMEOUT}s for ${WAITFORIT_HOST}:${WAITFORIT_PORT} (method: ${WAITFORIT_TCP_METHOD})"

  WAITFORIT_START_TS=$(date +%s)
  WAITFORIT_LAST_PROGRESS=0

  while :; do
    # Attempt TCP connection using detected method
    if check_tcp; then
      WAITFORIT_END_TS=$(date +%s)
      WAITFORIT_ELAPSED=$((WAITFORIT_END_TS - WAITFORIT_START_TS))
      log "wait-for-it: ${WAITFORIT_HOST}:${WAITFORIT_PORT} is available after ${WAITFORIT_ELAPSED}s"
      return 0
    fi

    # Calculate elapsed time
    WAITFORIT_END_TS=$(date +%s)
    WAITFORIT_ELAPSED=$((WAITFORIT_END_TS - WAITFORIT_START_TS))

    # Print progress message at regular intervals for Docker log visibility
    if [ "$WAITFORIT_ELAPSED" -ge "$((WAITFORIT_LAST_PROGRESS + WAITFORIT_PROGRESS_INTERVAL))" ]; then
      WAITFORIT_LAST_PROGRESS=$WAITFORIT_ELAPSED
      if [ "$WAITFORIT_TIMEOUT" -gt 0 ]; then
        WAITFORIT_REMAINING=$((WAITFORIT_TIMEOUT - WAITFORIT_ELAPSED))
        log "wait-for-it: still waiting for ${WAITFORIT_HOST}:${WAITFORIT_PORT} (${WAITFORIT_ELAPSED}s elapsed, ${WAITFORIT_REMAINING}s remaining)"
      else
        log "wait-for-it: still waiting for ${WAITFORIT_HOST}:${WAITFORIT_PORT} (${WAITFORIT_ELAPSED}s elapsed, no timeout)"
      fi
    fi

    # Check if timeout has been reached (only when timeout > 0)
    if [ "$WAITFORIT_TIMEOUT" -gt 0 ] && [ "$WAITFORIT_ELAPSED" -ge "$WAITFORIT_TIMEOUT" ]; then
      log_error "wait-for-it: timeout after ${WAITFORIT_TIMEOUT}s waiting for ${WAITFORIT_HOST}:${WAITFORIT_PORT}"
      if [ "$WAITFORIT_STRICT" -eq 1 ]; then
        return 1
      fi
      return 0
    fi

    # Sleep 1 second before retrying to avoid CPU spin
    sleep 1
  done
}

# =============================================================================
# Argument Parsing
# =============================================================================
# Supports the standard wait-for-it interface:
#   host:port as positional argument
#   -t / --timeout= for timeout configuration
#   -s / --strict for strict mode
#   -q / --quiet for quiet mode
#   -- for command passthrough
# =============================================================================

while [ $# -gt 0 ]; do
  case "$1" in
    # Match host:port pattern (contains a colon with non-empty parts)
    *:*)
      WAITFORIT_HOST=$(printf '%s' "$1" | cut -d: -f1)
      WAITFORIT_PORT=$(printf '%s' "$1" | cut -d: -f2)
      shift
      ;;
    # Short timeout flag: -t N
    -t)
      if [ -z "$2" ] || [ "$2" = "--" ]; then
        log_error "option -t requires a numeric argument"
        usage
      fi
      WAITFORIT_TIMEOUT="$2"
      shift 2
      ;;
    # Long timeout flag: --timeout=N
    --timeout=*)
      WAITFORIT_TIMEOUT="${1#*=}"
      shift
      ;;
    # Separate host flag: --host=X
    --host=*)
      WAITFORIT_HOST="${1#*=}"
      shift
      ;;
    # Separate host flag: --host X
    --host)
      if [ -z "$2" ]; then
        log_error "option --host requires a value"
        usage
      fi
      WAITFORIT_HOST="$2"
      shift 2
      ;;
    # Separate port flag: --port=Y
    --port=*)
      WAITFORIT_PORT="${1#*=}"
      shift
      ;;
    # Separate port flag: --port Y
    --port)
      if [ -z "$2" ]; then
        log_error "option --port requires a value"
        usage
      fi
      WAITFORIT_PORT="$2"
      shift 2
      ;;
    # Strict mode flags
    -s|--strict)
      WAITFORIT_STRICT=1
      shift
      ;;
    # Quiet mode flags
    -q|--quiet)
      WAITFORIT_QUIET=1
      shift
      ;;
    # Command separator — everything after this is the command to execute
    --)
      shift
      WAITFORIT_CMD="$*"
      break
      ;;
    # Help flags
    -h|--help)
      usage
      ;;
    # Unknown argument — show usage and exit
    *)
      log_error "unknown argument: $1"
      usage
      ;;
  esac
done

# =============================================================================
# Input Validation
# =============================================================================

# Verify that both host and port were provided
if [ -z "$WAITFORIT_HOST" ] || [ -z "$WAITFORIT_PORT" ]; then
  log_error "host and port are required"
  usage
fi

# Validate that timeout is a non-negative integer
case "$WAITFORIT_TIMEOUT" in
  ''|*[!0-9]*)
    log_error "timeout must be a non-negative integer, got: ${WAITFORIT_TIMEOUT}"
    usage
    ;;
esac

# Validate that port is a positive integer in the valid range (1-65535)
case "$WAITFORIT_PORT" in
  ''|*[!0-9]*)
    log_error "port must be a positive integer, got: ${WAITFORIT_PORT}"
    usage
    ;;
esac

if [ "$WAITFORIT_PORT" -lt 1 ] || [ "$WAITFORIT_PORT" -gt 65535 ]; then
  log_error "port must be between 1 and 65535, got: ${WAITFORIT_PORT}"
  usage
fi

# =============================================================================
# TCP Method Detection
# =============================================================================

# Detect the best available TCP connection check method before starting
# the wait loop. Supports nc (Alpine/BusyBox native), bash /dev/tcp, and
# python3 socket as fallbacks for portability across environments.
if ! detect_tcp_method; then
  log_error "no TCP check tool available (need nc, bash, or python3)"
  exit 1
fi

# =============================================================================
# Execution
# =============================================================================

# Execute the wait loop
# Note: We capture the return code manually rather than relying on set -e,
# because we need to conditionally proceed to command execution even when
# the wait times out in non-strict mode.
WAITFORIT_RESULT=0
wait_for || WAITFORIT_RESULT=$?

# If the wait failed (strict timeout), exit with the error code
if [ "$WAITFORIT_RESULT" -ne 0 ]; then
  exit "$WAITFORIT_RESULT"
fi

# Execute the passthrough command if one was provided after --
# Uses exec to replace the current shell process with the command,
# ensuring proper signal propagation (e.g., SIGTERM from Docker)
if [ -n "$WAITFORIT_CMD" ]; then
  log "wait-for-it: executing command: $WAITFORIT_CMD"
  exec $WAITFORIT_CMD
fi
