-- Rollback for 20261108090000_approval_policy_decisions (run as the migration owner, in a maintenance window).
-- Refused while REBILL adjustments exist: an applied one created a real fee plan (ledger FEE entry) that must stay
-- linked to its approval. Reverse a re-billed plan through Finance, not by rollback.
\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM fee_adjustments WHERE kind = 'REBILL') THEN
    RAISE EXCEPTION 'REBILL fee adjustments exist — rollback refused.';
  END IF;
END $$;
-- Receipt cancellation back to Finance Manager only, unless a Super Administrator changed it since.
UPDATE "approval_workflows" SET "levels" = '[{"level":1,"role":"finance_manager"}]'::jsonb
WHERE "type" = 'PAYMENT_CANCELLATION' AND "levels" = '[{"level":1,"role":"finance_manager"},{"level":2,"role":"management","minAmount":10000}]'::jsonb;
DROP INDEX IF EXISTS "fee_adjustments_created_plan_key";
ALTER TABLE "fee_adjustments" DROP CONSTRAINT IF EXISTS "fee_adjustments_created_plan_check";
ALTER TABLE "fee_adjustments" DROP CONSTRAINT IF EXISTS "fee_adjustments_newplan_check";
ALTER TABLE "fee_adjustments" DROP CONSTRAINT IF EXISTS "fee_adjustments_kind_check";
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_kind_check" CHECK ("kind" IN ('WAIVER','RESCHEDULE'));
ALTER TABLE "fee_adjustments" DROP CONSTRAINT IF EXISTS "fee_adjustments_createdFeePlanId_fkey";
ALTER TABLE "fee_adjustments" DROP COLUMN IF EXISTS "createdFeePlanId", DROP COLUMN IF EXISTS "newPlan";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261108090000_approval_policy_decisions';
COMMIT;
