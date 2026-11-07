-- Decision 8 (2026-11-05): staff and student accounts are activated with single-use links; templates must never
-- carry a password. Only rewrites templates that still reference {{password}} (admin edits are otherwise kept).
UPDATE "notification_templates"
SET "body" = 'Hi {{name}}, your admission to {{course}} ({{batch}}) is confirmed. Student ID: {{studentCode}}. Activate your student portal account (username {{username}}) with this single-use link, valid {{hours}} hours: {{link}}',
    "channels" = ARRAY['EMAIL', 'WHATSAPP'], "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'admission.confirmed' AND "body" LIKE '%{{password}}%';

UPDATE "notification_templates"
SET "body" = 'Hi {{name}}, your Nexora staff account (username {{username}}) is ready. Set your password with this single-use link, valid {{hours}} hours: {{link}}. Administrative roles will then set up an authenticator app.',
    "channels" = ARRAY['EMAIL', 'WHATSAPP'], "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'user.welcome' AND "body" LIKE '%{{password}}%';
