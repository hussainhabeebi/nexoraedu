-- Finance MVP task 1: record the due-date policy used for each fee plan (additive, nullable).
-- Existing plans keep NULL ("legacy") and their installment due dates are NOT modified.
ALTER TABLE "fee_plans" ADD COLUMN "dueAnchorDay" INTEGER;
ALTER TABLE "fee_plans" ADD COLUMN "dueTimeZone" TEXT;
ALTER TABLE "fee_plans" ADD CONSTRAINT "fee_plans_dueAnchorDay_check" CHECK ("dueAnchorDay" IS NULL OR ("dueAnchorDay" BETWEEN 1 AND 31));
