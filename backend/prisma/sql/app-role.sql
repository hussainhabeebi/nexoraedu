-- R7 / LOG-01 / DEP-09: least-privilege runtime role for the API.
--
-- The API must NOT connect as the table owner: the owner can disable triggers and rewrite history.
-- Migrations keep running as the owner (MIGRATION_DATABASE_URL); the API uses DATABASE_URL with this role.
--
-- Apply (as the database owner / migrator), then set DATABASE_URL to the new role:
--   psql "$MIGRATION_DATABASE_URL" -v app_role=nexora_app -v app_password='<strong password>' -f prisma/sql/app-role.sql
-- Re-run after every migration that adds tables (idempotent).
-- NOT applied to any shared or production database by this change — operator action after approval.

\set ON_ERROR_STOP on

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_role', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role') \gexec

-- No DDL, no ownership, no trigger management.
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_role') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_role') \gexec
SELECT format('REVOKE CREATE ON SCHEMA public FROM %I', :'app_role') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'app_role') \gexec
SELECT format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', :'app_role') \gexec

-- Append-only tables: INSERT + SELECT only (the triggers stay as a second line of defence).
SELECT format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM %I', t, :'app_role')
FROM unnest(ARRAY['audit_logs', 'ledger_entries', 'lead_activities', 'student_history', 'login_logs', 'approval_actions', 'integration_logs']) AS t \gexec

-- Delivery-status updates on notification logs: only these columns.
SELECT format('REVOKE UPDATE, DELETE, TRUNCATE ON notification_logs FROM %I', :'app_role') \gexec
SELECT format('GRANT UPDATE (status, error, "updatedAt", attempts) ON notification_logs TO %I', :'app_role') \gexec

-- Migration bookkeeping is not the API's business.
SELECT format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON _prisma_migrations FROM %I', :'app_role') \gexec
