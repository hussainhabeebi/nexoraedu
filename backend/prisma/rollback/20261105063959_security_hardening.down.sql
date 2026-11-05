-- Rollback for migration 20261105063959_security_hardening.
-- Run ONLY together with redeploying the previous application version (commit e476404).
-- Effects: all sessions, MFA enrolments, recovery codes and password history are lost; users must sign in again.
-- Login-log "event" values and approval-action IP/user-agent columns are dropped (audit rows themselves are kept).
BEGIN;
DROP TRIGGER IF EXISTS approval_actions_immutable ON "approval_actions";
DROP TRIGGER IF EXISTS login_logs_immutable ON "login_logs";
DROP TRIGGER IF EXISTS integration_logs_immutable ON "integration_logs";
UPDATE "roles" SET "permissions" = array_replace("permissions", 'students:read_own', 'students:read') WHERE "key" = 'counselor';
DROP TABLE IF EXISTS "sessions", "mfa_factors", "mfa_recovery_codes", "mfa_challenges", "password_history";
ALTER TABLE "users" DROP COLUMN IF EXISTS "authVersion", DROP COLUMN IF EXISTS "passwordChangedAt";
ALTER TABLE "password_resets" DROP COLUMN IF EXISTS "purpose";
ALTER TABLE "login_logs" DROP COLUMN IF EXISTS "event";
ALTER TABLE "approval_actions" DROP COLUMN IF EXISTS "ip", DROP COLUMN IF EXISTS "userAgent";
ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "requestId", DROP COLUMN IF EXISTS "userAgent";
CREATE TABLE "refresh_tokens" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "tokenHash" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261105063959_security_hardening';
COMMIT;
