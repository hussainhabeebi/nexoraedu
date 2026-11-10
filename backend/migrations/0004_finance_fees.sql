-- Finance & fee management enhancement (fee month, reminders, receipts, parent access, collection assignment).
-- ADDITIVE ONLY: new nullable columns, one new table, indexes, triggers and reference rows. No existing row is
-- changed or deleted, and no table is rebuilt (SQLite ALTER TABLE ADD COLUMN keeps data, triggers and indexes).

-- Fee month an installment bills ("YYYY-MM", academy zone). Existing installments keep NULL (derived on read).
ALTER TABLE "installments" ADD COLUMN "feeMonth" TEXT;

-- Student balance right after a payment was posted (printed on the receipt; NULL on existing payments).
ALTER TABLE "payments" ADD COLUMN "balanceAfter" DECIMAL;
CREATE TRIGGER "payments_balanceAfter_money_insert" BEFORE INSERT ON "payments" WHEN NOT (NEW."balanceAfter" IS NULL OR NEW."balanceAfter" = round(NEW."balanceAfter", 2))
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: payments_balanceAfter_money'); END;
CREATE TRIGGER "payments_balanceAfter_money_update" BEFORE UPDATE ON "payments" WHEN NOT (NEW."balanceAfter" IS NULL OR NEW."balanceAfter" = round(NEW."balanceAfter", 2))
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: payments_balanceAfter_money'); END;
-- The receipt's balance is frozen once written.
CREATE TRIGGER "payments_balanceAfter_frozen" BEFORE UPDATE ON "payments" WHEN OLD."balanceAfter" IS NOT NULL AND NEW."balanceAfter" IS NOT OLD."balanceAfter"
BEGIN SELECT RAISE(ABORT, 'payments: balanceAfter cannot change once recorded'); END;

-- Finance Staff member assigned to a student's collection and follow-ups.
ALTER TABLE "students" ADD COLUMN "financeOwnerId" TEXT REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "students_financeOwnerId_idx" ON "students"("financeOwnerId");

-- Parent portal account linked to a guardian record.
ALTER TABLE "guardians" ADD COLUMN "userId" TEXT REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "guardians_userId_idx" ON "guardians"("userId");

-- Fee reminders: one row per installment stage, channel and recipient (the unique key prevents duplicates).
CREATE TABLE "fee_reminders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "installmentId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipientType" TEXT NOT NULL,
    "recipientRef" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" DATETIME,
    "sentAt" DATETIME,
    "trigger" TEXT NOT NULL DEFAULT 'AUTO',
    "sentById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "fee_reminders_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "installments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "fee_reminders_installmentId_stage_channel_recipientRef_key" ON "fee_reminders"("installmentId", "stage", "channel", "recipientRef");
CREATE INDEX "fee_reminders_studentId_createdAt_idx" ON "fee_reminders"("studentId", "createdAt");
CREATE INDEX "fee_reminders_status_nextAttemptAt_idx" ON "fee_reminders"("status", "nextAttemptAt");
CREATE TRIGGER "fee_reminders_no_delete" BEFORE DELETE ON "fee_reminders" BEGIN SELECT RAISE(ABORT, 'Rows in fee_reminders are never deleted (history)'); END;
CREATE TRIGGER "fee_reminders_frozen_columns" BEFORE UPDATE ON "fee_reminders" WHEN NEW."installmentId" IS NOT OLD."installmentId" OR NEW."studentId" IS NOT OLD."studentId" OR NEW."stage" IS NOT OLD."stage" OR NEW."channel" IS NOT OLD."channel" OR NEW."recipientType" IS NOT OLD."recipientType" OR NEW."recipientRef" IS NOT OLD."recipientRef" OR NEW."address" IS NOT OLD."address" OR NEW."trigger" IS NOT OLD."trigger" OR NEW."createdAt" IS NOT OLD."createdAt"
BEGIN SELECT RAISE(ABORT, 'fee_reminders: only delivery status may change'); END;

-- Parent role (portal access to linked children's fee records and receipts only).
INSERT INTO "roles" ("id", "key", "name", "description", "permissions", "isSystem", "createdAt") VALUES ('cmw7fin0parent0role0000001', 'parent', 'Parent / Guardian', NULL, '["portal:parent"]', 1, '2026-11-10T00:00:00.000+00:00') ON CONFLICT DO NOTHING;

-- Reminder templates addressed to a parent / guardian (the student's own templates are unchanged).
INSERT INTO "notification_templates" ("id", "key", "name", "subject", "body", "waTemplateName", "waLanguage", "waCategory", "channels", "version", "isActive", "updatedAt") VALUES ('cmw7fin0tpl0guardianup0001', 'fee.reminder_upcoming_guardian', 'Fee reminder to parent (upcoming)', 'Fee for {{student}} due on {{dueDate}}', 'Dear {{name}}, a gentle reminder that the {{feeMonth}} fee of ₹{{amount}} for {{student}} is due on {{dueDate}}. Please ignore if already paid.', NULL, 'en', 'UTILITY', '["IN_APP","EMAIL","WHATSAPP"]', 1, 1, '2026-11-10T00:00:00.000+00:00') ON CONFLICT DO NOTHING;
INSERT INTO "notification_templates" ("id", "key", "name", "subject", "body", "waTemplateName", "waLanguage", "waCategory", "channels", "version", "isActive", "updatedAt") VALUES ('cmw7fin0tpl0guardianod0001', 'fee.reminder_overdue_guardian', 'Fee reminder to parent (overdue)', 'Fee for {{student}} is overdue', 'Dear {{name}}, the {{feeMonth}} fee of ₹{{amount}} for {{student}} was due on {{dueDate}} and is {{days}} day(s) overdue. Please pay at the earliest or contact accounts.', NULL, 'en', 'UTILITY', '["IN_APP","EMAIL","WHATSAPP"]', 1, 1, '2026-11-10T00:00:00.000+00:00') ON CONFLICT DO NOTHING;

-- Activation message for a new parent portal account (the link is never stored in the notification log).
INSERT INTO "notification_templates" ("id", "key", "name", "subject", "body", "waTemplateName", "waLanguage", "waCategory", "channels", "version", "isActive", "updatedAt") VALUES ('cmw7fin0tpl0parentwelc0001', 'parent.welcome', 'Parent portal welcome', 'Your Nexora parent portal account', 'Dear {{name}}, a Nexora parent portal account (username {{username}}) has been created for you to view the fees and receipts of {{student}}. Set your password with this single-use link, valid {{hours}} hours: {{link}}', NULL, 'en', 'UTILITY', '["EMAIL","WHATSAPP"]', 1, 1, '2026-11-10T00:00:00.000+00:00') ON CONFLICT DO NOTHING;
