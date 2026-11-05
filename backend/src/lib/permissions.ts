/** Permission catalogue (ADM-03) and default role grants mirroring SRS §6.12 matrix. */
export const PERMISSIONS = {
  'users:read': 'View users', 'users:manage': 'Create / edit / deactivate users',
  'roles:manage': 'Manage roles & permissions', 'settings:manage': 'System settings, workflows & integrations',
  'masters:manage': 'Master data & courses',
  'leads:read': 'View own leads', 'leads:read_all': 'View all leads', 'leads:create': 'Create leads',
  'leads:update': 'Update leads', 'leads:delete': 'Delete / merge leads', 'leads:assign': 'Assign & reassign leads',
  'students:read': 'View all students', 'students:read_batch': 'View students in own batches',
  'students:read_own': 'View students converted from own leads',
  'students:manage': 'Register & update students', 'documents:verify': 'Verify documents',
  'finance:read': 'View finance', 'finance:collect': 'Record payments & invoices', 'finance:manage': 'Fee structures, discounts, refunds',
  'academics:read': 'View academics', 'academics:manage': 'Batches, timetable, faculty allocation',
  'attendance:mark': 'Mark attendance', 'materials:manage': 'Materials & assignments',
  'exams:read': 'View exams', 'exams:manage': 'Question bank, exams, results',
  'reports:read': 'View & export reports', 'approvals:act': 'Act on approvals', 'audit:read': 'View audit logs',
  'whatsapp:send': 'Send WhatsApp messages (Chatwoot)', 'notifications:manage': 'Manage notification templates',
} as const;
export type Permission = keyof typeof PERMISSIONS | '*' | 'portal:student';

export const DEFAULT_ROLES: { key: string; name: string; permissions: Permission[] }[] = [
  { key: 'super_admin', name: 'Super Administrator', permissions: ['*'] },
  {
    key: 'management', name: 'Management',
    permissions: ['users:read', 'leads:read', 'leads:read_all', 'students:read', 'finance:read', 'academics:read', 'exams:read', 'reports:read', 'approvals:act', 'audit:read'],
  },
  {
    key: 'admin', name: 'Administrator',
    permissions: ['users:read', 'users:manage', 'masters:manage', 'leads:read', 'leads:read_all', 'students:read', 'students:manage', 'documents:verify', 'finance:read', 'academics:read', 'exams:read', 'reports:read', 'notifications:manage', 'whatsapp:send'],
  },
  {
    key: 'sales_manager', name: 'Sales Manager',
    permissions: ['leads:read', 'leads:read_all', 'leads:create', 'leads:update', 'leads:delete', 'leads:assign', 'students:read', 'reports:read', 'approvals:act', 'whatsapp:send'],
  },
  // C8: counselors see only students converted from their own leads (students:read_own). Granting
  // students:read instead widens this to all students — a management decision (SRS 6.12 "R").
  { key: 'counselor', name: 'Counselor', permissions: ['leads:read', 'leads:create', 'leads:update', 'students:read_own', 'reports:read', 'whatsapp:send'] },
  { key: 'finance_manager', name: 'Finance Manager', permissions: ['finance:read', 'finance:collect', 'finance:manage', 'students:read', 'reports:read', 'approvals:act', 'whatsapp:send'] },
  { key: 'finance_staff', name: 'Finance Staff', permissions: ['finance:read', 'finance:collect', 'students:read', 'reports:read', 'whatsapp:send'] },
  {
    key: 'academic_manager', name: 'Academic Manager',
    permissions: ['academics:read', 'academics:manage', 'attendance:mark', 'materials:manage', 'students:read', 'exams:read', 'reports:read', 'approvals:act', 'whatsapp:send'],
  },
  { key: 'faculty', name: 'Faculty', permissions: ['academics:read', 'attendance:mark', 'materials:manage', 'students:read_batch', 'exams:read', 'reports:read'] },
  { key: 'exam_officer', name: 'Examination Officer', permissions: ['exams:read', 'exams:manage', 'students:read', 'reports:read', 'approvals:act', 'whatsapp:send'] },
  { key: 'student', name: 'Student', permissions: ['portal:student'] },
];

/**
 * Roles that only a Super Administrator may grant or revoke, and whose grant needs a second Super Admin's
 * approval (SRS §9 Rules, 22.2). The same roles must use MFA (SEC-06).
 */
export const PRIVILEGED_ROLES = ['super_admin', 'admin', 'management', 'finance_manager', 'finance_staff'] as const;
export const MFA_REQUIRED_ROLES = PRIVILEGED_ROLES;
export const isPrivilegedRole = (key: string) => (PRIVILEGED_ROLES as readonly string[]).includes(key);

/** Valid permission keys that may be stored on a role or as a user override ('*' is reserved for super_admin). */
export const isKnownPermission = (p: string) => p in PERMISSIONS || p === 'portal:student';

export function hasPerm(perms: string[], p: string) {
  return perms.includes('*') || perms.includes(p);
}
