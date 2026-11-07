-- Rollback for 20261107090000_fee_adjustments (run as the migration owner, inside a maintenance window).
--
-- SAFE ONLY IF NO ADJUSTMENT HAS BEEN APPLIED. Applied waivers posted immutable WAIVER ledger entries and changed
-- installment amounts; applied reschedules superseded installments and created new ones. Dropping the table would
-- leave those without their source record (reconciliation R10 errors). The guard below refuses in that case:
-- reverse an applied adjustment through Finance (new adjustment / discount reversal policy), not by rollback.
\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM fee_adjustments WHERE status = 'APPLIED')
     OR EXISTS (SELECT 1 FROM installments WHERE "adjustmentId" IS NOT NULL OR status = 'SUPERSEDED')
     OR EXISTS (SELECT 1 FROM ledger_entries WHERE "refType" = 'fee_adjustment') THEN
    RAISE EXCEPTION 'Applied fee adjustments exist — rollback refused (data would become inconsistent).';
  END IF;
END $$;
-- Pending / rejected requests are lost: export them first if needed (their approval requests and audit rows stay).
DELETE FROM "approval_workflows" WHERE "type" = 'FEE_ADJUSTMENT' AND NOT EXISTS (SELECT 1 FROM approval_requests WHERE type = 'FEE_ADJUSTMENT');
ALTER TABLE "installments" DROP CONSTRAINT IF EXISTS "installments_superseded_check";
ALTER TABLE "installments" DROP CONSTRAINT IF EXISTS "installments_adjustmentId_fkey";
ALTER TABLE "installments" DROP COLUMN IF EXISTS "adjustmentId", DROP COLUMN IF EXISTS "supersededAt";
ALTER TABLE "fee_plans" DROP CONSTRAINT IF EXISTS "fee_plans_waived_check";
ALTER TABLE "fee_plans" DROP COLUMN IF EXISTS "waived";
DROP TABLE IF EXISTS "fee_adjustments";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261107090000_fee_adjustments';
COMMIT;
