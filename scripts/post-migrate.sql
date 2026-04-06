-- =============================================================================
-- Kalle — Post-Migration Permission Grants
-- =============================================================================
-- Applied after every Prisma migration run to ensure the non-superuser
-- application role (kalle_app) has correct permissions on all tables.
--
-- Rule R32 (Immutable Audit Log):
--   The application role MUST NOT have UPDATE or DELETE on audit_logs.
--   Since kalle_app is NOT a superuser, REVOKE is enforced by PostgreSQL.
--
-- EXECUTION CONTEXT:
--   Runs via the docker-compose api service command after `prisma migrate deploy`.
--   Uses the superuser DATABASE_URL (MIGRATION_DATABASE_URL) to apply grants.
--   Idempotent — safe to run on every startup.
--
-- DEPENDENCIES:
--   scripts/init-db.sh — Creates the kalle_app role on first DB init
-- =============================================================================

-- Grant all privileges on ALL existing tables to the app role.
-- This covers any new tables added by migrations.
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO kalle_app;

-- Grant all privileges on ALL existing sequences (auto-increment IDs).
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO kalle_app;

-- =============================================================================
-- AUDIT LOG IMMUTABILITY (R32)
-- =============================================================================
-- Revoke UPDATE, DELETE, and TRUNCATE specifically on the audit_logs table.
-- Because kalle_app is NOT a superuser, these REVOKEs are enforced.
-- The app role can only INSERT (write new audit entries) and SELECT (read).
--
-- TRUNCATE is explicitly revoked because it bypasses row-level access
-- controls and could destroy the entire audit trail in a single operation.
-- =============================================================================
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM kalle_app;
