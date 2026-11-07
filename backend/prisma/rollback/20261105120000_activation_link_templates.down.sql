-- Rollback for 20261105120000_activation_link_templates. Run BEFORE 20261105063959_security_hardening.down.sql
-- and only when redeploying the pre-hardening application (e476404), whose messages expect {{password}}.
BEGIN;
UPDATE "notification_templates"
SET "body" = 'Hi {{name}}, your admission to {{course}} ({{batch}}) is confirmed. Student ID: {{studentCode}}. Portal login: {{username}} / {{password}} at {{portalUrl}}/login. Please change your password after the first sign-in.',
    "channels" = ARRAY['IN_APP', 'EMAIL', 'WHATSAPP'], "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'admission.confirmed' AND "body" LIKE '%{{link}}%';
UPDATE "notification_templates"
SET "body" = 'Hi {{name}}, your Nexora staff account is ready. Username: {{username}}, temporary password: {{password}}. You will be asked to change it at first login.',
    "channels" = ARRAY['IN_APP', 'EMAIL', 'WHATSAPP'], "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'user.welcome' AND "body" LIKE '%{{link}}%';
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261105120000_activation_link_templates';
COMMIT;
