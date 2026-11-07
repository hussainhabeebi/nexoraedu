-- Rollback for 20261106090000_fee_plan_due_policy. Drops only the policy metadata; installments, invoices,
-- payments and ledger entries are untouched. Plans created under the new policy keep their (correct) due dates.
BEGIN;
ALTER TABLE "fee_plans" DROP CONSTRAINT IF EXISTS "fee_plans_dueAnchorDay_check";
ALTER TABLE "fee_plans" DROP COLUMN IF EXISTS "dueAnchorDay", DROP COLUMN IF EXISTS "dueTimeZone";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261106090000_fee_plan_due_policy';
COMMIT;
