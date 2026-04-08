#!/bin/bash
# =============================================================================
# Kalle — PostgreSQL Initialization Script
# =============================================================================
# Creates a non-superuser application role (kalle_app) for use by the API
# and worker services. This enforces Rule R32 (Immutable Audit Log) by
# ensuring the application connects with a role whose UPDATE/DELETE
# permissions on audit_logs can be effectively revoked — REVOKE has no
# effect on superusers.
#
# EXECUTION CONTEXT:
#   This script is mounted into the postgres container at:
#     /docker-entrypoint-initdb.d/init-db.sh
#   It runs automatically during FIRST-TIME database initialization only
#   (when the data directory is empty). On subsequent starts it is skipped.
#
# ENVIRONMENT VARIABLES (set by docker-compose.yml):
#   POSTGRES_USER     — Superuser name (default: kalle)
#   POSTGRES_DB       — Database name (default: kalle_db)
#   APP_DB_USER       — Application role name (default: kalle_app)
#   APP_DB_PASSWORD   — Application role password (default: kalle_app_password)
#
# DEPENDENCIES:
#   scripts/post-migrate.sql — Grants table-level permissions after migrations
#   docker-compose.yml api command — Applies post-migrate.sql on each startup
# =============================================================================

set -e

# Application role credentials — overridable via docker-compose environment
APP_DB_USER="${APP_DB_USER:-kalle_app}"
APP_DB_PASSWORD="${APP_DB_PASSWORD:-kalle_app_password}"

echo "=== Kalle DB Init: Creating application role '${APP_DB_USER}' ==="

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    -- =========================================================================
    -- Create non-superuser application role
    -- =========================================================================
    -- This role is used by the API server and BullMQ worker for all runtime
    -- database operations. It is NOT a superuser, so REVOKE statements on
    -- specific tables (e.g., audit_logs) are enforced by PostgreSQL.
    -- =========================================================================
    CREATE ROLE ${APP_DB_USER} WITH LOGIN PASSWORD '${APP_DB_PASSWORD}';

    -- Grant database-level connect privilege
    GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${APP_DB_USER};

    -- Grant schema-level usage privilege (required to see tables)
    GRANT USAGE ON SCHEMA public TO ${APP_DB_USER};
    GRANT CREATE ON SCHEMA public TO ${APP_DB_USER};

    -- Set default privileges so tables and sequences created by the superuser
    -- (via Prisma migrations) are automatically accessible to the app role.
    -- Table-level REVOKE for audit_logs is applied separately after migrations
    -- via scripts/post-migrate.sql.
    ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA public
        GRANT ALL PRIVILEGES ON TABLES TO ${APP_DB_USER};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA public
        GRANT ALL PRIVILEGES ON SEQUENCES TO ${APP_DB_USER};
EOSQL

echo "=== Kalle DB Init: Role '${APP_DB_USER}' created successfully ==="
