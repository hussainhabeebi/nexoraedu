-- AlterTable
ALTER TABLE "fee_adjustments" ADD COLUMN     "createdFeePlanId" TEXT,
ADD COLUMN     "newPlan" JSONB;

-- AddForeignKey
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_createdFeePlanId_fkey" FOREIGN KEY ("createdFeePlanId") REFERENCES "fee_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Hand-written: decisions approved on 2026-11-06 ──
-- B2: a second fee plan for a course the student was already billed for is created only through an approved
-- FEE_ADJUSTMENT of kind REBILL. The request stores the plan to create; once applied it links the created plan.
ALTER TABLE "fee_adjustments" DROP CONSTRAINT "fee_adjustments_kind_check";
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_kind_check" CHECK ("kind" IN ('WAIVER','RESCHEDULE','REBILL'));
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_newplan_check" CHECK (("kind" = 'REBILL') = ("newPlan" IS NOT NULL));
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_created_plan_check" CHECK (
  ("createdFeePlanId" IS NULL OR ("kind" = 'REBILL' AND "status" = 'APPLIED'))
  AND ("kind" <> 'REBILL' OR "status" <> 'APPLIED' OR "createdFeePlanId" IS NOT NULL));
CREATE UNIQUE INDEX "fee_adjustments_created_plan_key" ON "fee_adjustments"("createdFeePlanId") WHERE "createdFeePlanId" IS NOT NULL;

-- SRS 22.6 receipt cancellation: Finance Manager, then Management at or above 10,000 (decision 2026-11-06).
-- Only replaces the original default; a workflow customised by a Super Administrator is left untouched.
UPDATE "approval_workflows"
SET "levels" = '[{"level":1,"role":"finance_manager"},{"level":2,"role":"management","minAmount":10000}]'::jsonb
WHERE "type" = 'PAYMENT_CANCELLATION' AND "levels" = '[{"level":1,"role":"finance_manager"}]'::jsonb;
