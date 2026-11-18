-- WhatsApp AI chatbot (through the existing Chatwoot inbox). ADDITIVE ONLY: two new tables, one nullable column on
-- guardians (ALTER TABLE ADD COLUMN, no rebuild) with a backfill, and one permission added to the Administrator role.
-- Numbered 0007 so it never collides with the separate, unmerged Meta Cloud API branch (0006).

-- Parents' phones in normalised form (same rule as normalizePhone() in lib/util.ts), so an incoming WhatsApp from a
-- parent is recognised instead of becoming a new lead.
ALTER TABLE "guardians" ADD COLUMN "phoneNormalized" TEXT;
CREATE INDEX "guardians_phoneNormalized_idx" ON "guardians"("phoneNormalized");
UPDATE "guardians" SET "phoneNormalized" = (
  WITH p(d) AS (SELECT replace(replace(replace(replace(replace(replace(trim("phone"), ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '/', ''))
  SELECT CASE
    WHEN d LIKE '+%' THEN '+' || replace(substr(d, 2), '+', '')
    WHEN d LIKE '00%' THEN '+' || substr(d, 3)
    WHEN length(d) = 10 THEN '+91' || d
    WHEN length(d) = 11 AND d LIKE '0%' THEN '+91' || substr(d, 2)
    ELSE '+' || d
  END FROM p
) WHERE "phoneNormalized" IS NULL AND "phone" IS NOT NULL AND trim("phone") <> '';

-- One row per incoming Chatwoot message (unique id = duplicate-event protection).
CREATE TABLE "chatwoot_message_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatwootMessageId" TEXT NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "contactKind" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "leadId" TEXT,
    "botStatus" TEXT NOT NULL DEFAULT 'OFF',
    "botReason" TEXT,
    "botReplyText" TEXT,
    "botReplyMessageId" TEXT,
    "botModel" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "chatwoot_message_events_chatwootMessageId_key" ON "chatwoot_message_events"("chatwootMessageId");
CREATE INDEX "chatwoot_message_events_conversationId_createdAt_idx" ON "chatwoot_message_events"("conversationId", "createdAt");
CREATE INDEX "chatwoot_message_events_botStatus_createdAt_idx" ON "chatwoot_message_events"("botStatus", "createdAt");
CREATE TRIGGER "chatwoot_message_events_no_delete" BEFORE DELETE ON "chatwoot_message_events" BEGIN SELECT RAISE(ABORT, 'Rows in chatwoot_message_events are never deleted (history)'); END;

CREATE TABLE "chatbot_conversations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" INTEGER NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'BOT',
    "botReplies" INTEGER NOT NULL DEFAULT 0,
    "handedOverAt" DATETIME,
    "handoverReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "chatbot_conversations_conversationId_key" ON "chatbot_conversations"("conversationId");

-- Administrators may manage the chatbot (Super Administrators have every permission already).
UPDATE "roles" SET "permissions" = json_insert("permissions", '$[#]', 'chatbot:manage')
WHERE "key" = 'admin' AND json_valid("permissions") AND NOT EXISTS (SELECT 1 FROM json_each("roles"."permissions") WHERE value = 'chatbot:manage');
