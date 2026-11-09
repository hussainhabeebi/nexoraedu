/** Demo / legacy account names (kept separate so the Worker can check for them without the seed code). */
export const DEMO_USERNAMES = ['director', 'office', 'salesmgr', 'counselor1', 'counselor2', 'finmgr', 'accounts', 'acadmgr', 'faculty1', 'faculty2', 'examofficer'];
/** Accounts created by the pre-hardening seed (including the old default "admin"). */
export const LEGACY_DEFAULT_USERNAMES = ['admin', ...DEMO_USERNAMES];
