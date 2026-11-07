-- AlterTable
ALTER TABLE "fee_plans" ADD COLUMN     "waived" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "installments" ADD COLUMN     "adjustmentId" TEXT,
ADD COLUMN     "supersededAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "fee_adjustments" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "feePlanId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "schedule" JSONB,
    "before" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requestedById" TEXT NOT NULL,
    "approvalRequestId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fee_adjustments_studentId_createdAt_idx" ON "fee_adjustments"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "fee_adjustments_feePlanId_idx" ON "fee_adjustments"("feePlanId");

-- AddForeignKey
ALTER TABLE "installments" ADD CONSTRAINT "installments_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "fee_adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_feePlanId_fkey" FOREIGN KEY ("feePlanId") REFERENCES "fee_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Hand-written (not expressible in the Prisma schema) ──
-- Kinds, statuses and amounts.
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_kind_check" CHECK ("kind" IN ('WAIVER','RESCHEDULE'));
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_status_check" CHECK ("status" IN ('PENDING_APPROVAL','APPLIED','REJECTED'));
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_amount_check" CHECK ("amount" > 0);
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_schedule_check" CHECK (("kind" = 'RESCHEDULE') = ("schedule" IS NOT NULL));
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_applied_check" CHECK (("status" = 'APPLIED') = ("appliedAt" IS NOT NULL));
ALTER TABLE "fee_plans" ADD CONSTRAINT "fee_plans_waived_check" CHECK ("waived" >= 0);
-- A superseded installment carries nothing (its unpaid part moved to the custom schedule).
ALTER TABLE "installments" ADD CONSTRAINT "installments_superseded_check" CHECK ("status" <> 'SUPERSEDED' OR ("amount" = 0 AND "paidAmount" = 0 AND "supersededAt" IS NOT NULL));
-- At most one pending adjustment per fee plan (two pending reschedules could not both be applied).
CREATE UNIQUE INDEX "fee_adjustments_one_pending_per_plan" ON "fee_adjustments"("feePlanId") WHERE "status" = 'PENDING_APPROVAL';

-- SRS 22.6 default workflow: Finance Manager; Management above the threshold. Approvals fail closed without it.
-- The threshold (10000, same as discounts) is a PLACEHOLDER pending the Finance decision (P9); a Super Administrator
-- can change it under Settings → Approval workflows. Existing rows are never overwritten.
INSERT INTO "approval_workflows" ("id", "type", "name", "levels", "isActive")
VALUES ('wf_fee_adjustment', 'FEE_ADJUSTMENT', 'Fee adjustment (waiver / custom installment plan)',
        '[{"level":1,"role":"finance_manager"},{"level":2,"role":"management","minAmount":10000}]'::jsonb, true)
ON CONFLICT ("type") DO NOTHING;
