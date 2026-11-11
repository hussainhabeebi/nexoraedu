-- Owner decision 2026-11-11: no sign-out after inactivity. Only changes the saved security setting, if one was
-- saved; the default (no saved row) is already 0. Sessions still end at their absolute lifetime (SESSION_MAX_HOURS).
UPDATE "settings" SET "value" = json_set("value", '$.sessionTimeoutMin', 0) WHERE "key" = 'security' AND json_valid("value");
