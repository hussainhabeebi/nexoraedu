/**
 * SEC-T30 — complete role × endpoint matrix (SRS §6.12 + management decisions of 2026-11-05).
 *
 * 1. Route inventory: every route registered in src/routes/*.ts and src/app.ts must have an explicit entry
 *    below — the test fails on any unlisted route (new endpoints cannot slip in without a permission decision).
 * 2. For every authenticated route, all 11 roles are exercised: allowed roles must not get 401/403, all other
 *    roles must get 403; unauthenticated callers must get 401.
 * 3. PUBLIC routes (website forms, webhooks, sign-in steps) must not require a session.
 *
 * Placeholder IDs / empty bodies stop allowed requests at validation (400/404/409/422/503) without data changes.
 * Notes: LOOKUP = read-only reference data deliberately available to more roles than the SRS matrix row
 * (pickers in forms of other modules). SELF = the caller's own account / notifications.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { app, as, makeStudent, makeUser, prisma, sessionFor } from './helpers';

type Role = 'sa' | 'mgmt' | 'admin' | 'sales' | 'couns' | 'finmgr' | 'finstaff' | 'acad' | 'fac' | 'exam' | 'student' | 'parent';
const ALL: Role[] = ['sa', 'mgmt', 'admin', 'sales', 'couns', 'finmgr', 'finstaff', 'acad', 'fac', 'exam', 'student', 'parent'];
const STAFF = ALL.filter((r) => r !== 'student' && r !== 'parent');
const PUBLIC = 'PUBLIC' as const;
type Exp = Role[] | typeof PUBLIC;

// Role groups taken from SRS §6.12 rows.
const USERS_R: Role[] = ['sa', 'mgmt', 'admin'];
const USERS_W: Role[] = ['sa', 'admin'];
const SA: Role[] = ['sa'];
const AUDIT: Role[] = ['sa', 'mgmt'];
const LEADS_R: Role[] = ['sa', 'mgmt', 'admin', 'sales', 'couns'];
const LEADS_W: Role[] = ['sa', 'sales', 'couns'];
const LEADS_A: Role[] = ['sa', 'sales'];
const APPS_W: Role[] = ['sa', 'admin', 'sales', 'couns'];
const STU_W: Role[] = ['sa', 'admin'];
const DOCS: Role[] = ['sa', 'admin']; // decision 2
const FIN_R: Role[] = ['sa', 'mgmt', 'admin', 'finmgr', 'finstaff'];
const FIN_C: Role[] = ['sa', 'finmgr', 'finstaff'];
const FIN_M: Role[] = ['sa', 'finmgr'];
const ACD_R: Role[] = ['sa', 'mgmt', 'admin', 'acad', 'fac'];
const ACD_M: Role[] = ['sa', 'acad'];
const ACD_F: Role[] = ['sa', 'acad', 'fac'];
const COURSE_W: Role[] = ['sa', 'admin', 'acad']; // ADM-08 (Admin) + ACD-01 (Academic Manager)
const EXM_R: Role[] = ['sa', 'mgmt', 'admin', 'acad', 'fac', 'exam'];
const EXM_M: Role[] = ['sa', 'exam'];
const APPROVERS: Role[] = ['sa', 'mgmt', 'sales', 'finmgr', 'acad', 'exam'];
const WA: Role[] = ['sa', 'admin', 'sales', 'couns', 'finmgr', 'finstaff', 'acad', 'exam'];
const STUDENT: Role[] = ['student'];
const PARENT: Role[] = ['sa', 'parent']; // Super Admin oversight: sees no children unless linked

const MATRIX: Record<string, Exp> = {
  // ── Sign-in & self-service ──
  'POST /auth/login': PUBLIC, 'POST /auth/mfa/verify': PUBLIC, 'POST /auth/refresh': PUBLIC, 'POST /auth/logout': PUBLIC,
  'POST /auth/forgot-password': PUBLIC, 'POST /auth/bootstrap': PUBLIC, 'POST /auth/bootstrap/reissue-activation': PUBLIC, 'POST /auth/reset-password': PUBLIC,
  'GET /auth/me': ALL, 'POST /auth/mfa/enroll/start': ALL, 'POST /auth/mfa/enroll/confirm': ALL, 'POST /auth/change-password': ALL,
  'GET /auth/sessions': ALL, 'DELETE /auth/sessions/:id': ALL, 'POST /auth/sessions/revoke-others': ALL, // SELF
  'GET /notifications': ALL, 'POST /notifications/read': ALL, // SELF
  'GET /dashboard': ALL, // role-specific widgets, scoped server-side
  'GET /files/:name': ALL, // student photos; object-level scope in handler
  // ── Public website & webhooks (own authentication: API key / HMAC / token) ──
  'GET /public/site': PUBLIC, 'GET /public/courses/:slug': PUBLIC, 'POST /public/enquiry': PUBLIC, 'POST /public/applications': PUBLIC,
  'GET /public/applications/status': PUBLIC, 'GET /public/certificates/verify/:code': PUBLIC,
  'POST /webhooks/chatwoot': PUBLIC, 'POST /webhooks/website-leads': PUBLIC, 'POST /webhooks/payment': PUBLIC,
  // ── Administration: Users/Roles (SA CRUD, Mgmt R, Admin CRU; roles/workflows SA only) ──
  'GET /admin/users': USERS_R, 'POST /admin/users': USERS_W, 'PATCH /admin/users/:id': USERS_W, 'POST /admin/users/:id/reset-password': USERS_W,
  'POST /admin/users/:id/resend-activation': USERS_W, 'POST /admin/users/:id/mfa/reset': SA, 'POST /admin/users/import': USERS_W,
  'GET /admin/roles': USERS_R, 'POST /admin/roles': SA, 'PATCH /admin/roles/:id': SA, 'DELETE /admin/roles/:id': SA,
  'GET /admin/departments': USERS_R, 'POST /admin/departments': USERS_W, 'PATCH /admin/departments/:id': USERS_W, 'DELETE /admin/departments/:id': USERS_W,
  'GET /admin/masters': ALL, // LOOKUP (dropdowns)
  'POST /admin/masters': USERS_W, 'PATCH /admin/masters/:id': USERS_W,
  'GET /admin/settings': USERS_W, 'GET /admin/email': SA, 'POST /admin/email/test': SA, 'PUT /admin/settings/:key': SA,
  'GET /admin/workflows': APPROVERS, 'PUT /admin/workflows/:type': SA,
  'GET /admin/templates': USERS_W, 'PATCH /admin/templates/:id': USERS_W,
  'GET /admin/audit-logs': AUDIT, 'GET /admin/login-logs': AUDIT, 'GET /admin/notification-logs': USERS_R, 'GET /admin/integration-logs': AUDIT,
  // ── CRM (SA CRUD, Mgmt R, Admin R, Sales CRUDA, Counselor CRU own) ──
  'GET /crm/leads': LEADS_R, 'POST /crm/leads/check-duplicate': LEADS_W, 'POST /crm/leads': LEADS_W, 'GET /crm/leads/:id': LEADS_R,
  'PATCH /crm/leads/:id': LEADS_W, 'POST /crm/leads/:id/status': LEADS_W, 'POST /crm/leads/assign': LEADS_A, 'POST /crm/leads/:id/activities': LEADS_W,
  'POST /crm/leads/:id/follow-ups': LEADS_W, 'POST /crm/follow-ups/:id/complete': LEADS_W, 'GET /crm/follow-ups': LEADS_R,
  'POST /crm/leads/:id/counselling': LEADS_W, 'POST /crm/leads/import': LEADS_W, 'POST /crm/leads/:id/merge': LEADS_A,
  'GET /crm/applications': LEADS_R, 'GET /crm/applications/:id': LEADS_R, 'POST /crm/leads/:id/application': LEADS_W,
  'PATCH /crm/applications/:id': APPS_W, 'POST /crm/applications/:id/admit': APPS_W,
  // ── Students (all staff R — scoped for counselor/faculty — Admin CRU) & documents (decision 2) ──
  'GET /students': STAFF, 'POST /students': STU_W, 'POST /students/check-duplicate': APPS_W, 'GET /students/:id': STAFF,
  'PATCH /students/:id': STU_W, 'POST /students/:id/status': ['sa', 'admin', 'acad'], 'POST /students/:id/transfer': ['sa', 'admin', 'acad'],
  'POST /students/:id/guardians': STU_W, 'DELETE /students/:id/guardians/:gid': STU_W, 'POST /students/:id/education': STU_W,
  'DELETE /students/:id/education/:eid': STU_W, 'POST /students/:id/photo': STU_W, 'POST /students/:id/documents': STU_W,
  'GET /students/:id/enrollments': STAFF, 'POST /students/:id/enrollments/:eid/cancel': STU_W, // 20.4 history (scoped); cancel = Admin
  'GET /documents/pending': DOCS, 'POST /documents/:id/verify': DOCS, 'GET /documents/:id/download': DOCS,
  // ── Academics (Mgmt R, Admin R, AcadMgr CRUDA, Faculty CRU own batch) ──
  'GET /academics/courses': STAFF, 'GET /academics/courses/:id': STAFF, // LOOKUP (course pickers in CRM/finance/exams)
  'POST /academics/courses': COURSE_W, 'PATCH /academics/courses/:id': COURSE_W, 'DELETE /academics/courses/:id': COURSE_W, 'POST /academics/courses/:id/subjects': COURSE_W,
  'PATCH /academics/subjects/:id': COURSE_W, 'DELETE /academics/subjects/:id': COURSE_W, 'DELETE /academics/modules/:id': COURSE_W, 'POST /academics/subjects/:id/modules': COURSE_W, 'PATCH /academics/modules/:id': ACD_F,
  'GET /academics/batches': STAFF, // LOOKUP (batch pickers)
  'GET /academics/batches/:id': ['sa', 'mgmt', 'admin', 'sales', 'finmgr', 'finstaff', 'acad', 'fac', 'exam'],
  'POST /academics/batches': ACD_M, 'PATCH /academics/batches/:id': ACD_M, 'DELETE /academics/batches/:id': ACD_M,
  'GET /academics/faculty': EXM_R, 'PUT /academics/faculty/:userId': ACD_M,
  'POST /academics/batches/:id/allocations': ACD_M, 'DELETE /academics/allocations/:id': ACD_M,
  'GET /academics/timetable': ACD_R, 'POST /academics/timetable': ACD_M, 'PATCH /academics/timetable/:id': ACD_M, 'DELETE /academics/timetable/:id': ACD_M, 'POST /academics/timetable/publish': ACD_M,
  'GET /academics/sessions/:id/attendance': ACD_R, 'POST /academics/sessions/:id/attendance': ACD_F, 'GET /academics/batches/:id/attendance-summary': ACD_R,
  'GET /academics/materials': ACD_R, 'POST /academics/materials': ACD_F, 'DELETE /academics/materials/:id': ACD_F,
  'GET /academics/assignments': ACD_R, 'POST /academics/assignments': ACD_F, 'GET /academics/assignments/:id/submissions': ACD_F, 'PATCH /academics/submissions/:id': ACD_F,
  // ── Finance (Mgmt R, Admin R, FinMgr CRUDA, FinStaff CRU) ──
  'GET /finance/students/:id/account': FIN_R, 'POST /finance/students/:id/fee-plan': FIN_M, 'POST /finance/payments': FIN_C, 'GET /finance/payments': FIN_R,
  'GET /finance/payments/:id/receipt.pdf': FIN_R, 'POST /finance/payments/:id/cancel-request': FIN_C, 'POST /finance/discounts': FIN_C,
  'POST /finance/refunds': FIN_C, 'POST /finance/refunds/:id/pay': FIN_M, 'GET /finance/refunds': FIN_R, 'GET /finance/outstanding': FIN_R,
  'GET /finance/collections': FIN_R, 'POST /finance/reminders/run': FIN_M, 'GET /finance/summary': FIN_R, 'GET /finance/collectors': FIN_R, 'GET /finance/students/:id/fee-months': FIN_R, 'PUT /finance/students/:id/finance-owner': FIN_M, 'POST /finance/reminders/send': FIN_C, 'GET /finance/reminders': FIN_R, 'POST /finance/reminders/:id/retry': FIN_C,
  'POST /finance/adjustments': FIN_C, 'GET /finance/adjustments': FIN_R, // SRS 22.6: request = Finance Staff/Manager
  'GET /finance/reconciliation': ['sa', 'mgmt', 'finmgr'], // FIN-13: Finance Manager; Management via audit:read
  // ── Examinations (Mgmt R, Admin R, AcadMgr R, Faculty R, ExamOfficer CRUDA) — deferred in MVP, still protected ──
  'GET /exams/questions': EXM_R, 'POST /exams/questions': EXM_M, 'PATCH /exams/questions/:id': EXM_M, 'DELETE /exams/questions/:id': EXM_M, 'POST /exams/questions/import': EXM_M,
  'GET /exams/exams': EXM_R, 'GET /exams/exams/:id': EXM_R, 'POST /exams/exams': EXM_M, 'PATCH /exams/exams/:id': EXM_M, 'DELETE /exams/exams/:id': EXM_M,
  'PUT /exams/exams/:id/questions': EXM_M, 'POST /exams/exams/:id/assign': EXM_M, 'POST /exams/exams/:id/exception': EXM_M, 'POST /exams/exams/:id/schedule': EXM_M,
  'GET /exams/attempts/pending': EXM_M, 'GET /exams/attempts/:id': EXM_M, 'POST /exams/attempts/:id/evaluate': EXM_M, 'POST /exams/exams/:id/marks': EXM_M,
  'POST /exams/exams/:id/process': EXM_M, 'POST /exams/exams/:id/lock': EXM_M, 'POST /exams/exams/:id/publish': EXM_M,
  'POST /exams/results/:id/correction': ['sa', 'exam', 'acad', 'fac'], // 22.7 requested by Faculty / Exam Officer
  'GET /exams/certificates': EXM_R, 'POST /exams/certificates': EXM_M, 'GET /exams/certificates/:id/pdf': EXM_R,
  // ── Reports & approvals ──
  'GET /dashboard/reports': STAFF, 'GET /dashboard/reports/:key': STAFF, // per-report permission + scope inside
  'GET /approvals': STAFF, 'GET /approvals/:id': STAFF, 'POST /approvals/:id/act': APPROVERS,
  // ── WhatsApp (Chatwoot) — communication roles; conversation scope in handlers ──
  'GET /whatsapp/config': WA, 'PUT /whatsapp/config': SA, 'POST /whatsapp/test': WA, 'GET /whatsapp/conversations': WA,
  'GET /whatsapp/conversations/:id/messages': WA, 'POST /whatsapp/conversations/:id/status': WA, 'POST /whatsapp/conversations/:id/reply': WA,
  'POST /whatsapp/leads/:id/send': WA, 'GET /whatsapp/leads/:id/messages': WA, 'POST /whatsapp/students/:id/send': WA, 'POST /whatsapp/bulk': WA,
  // ── Student portal (own records only) ──
  'GET /portal/me': STUDENT, 'GET /portal/enrollments': STUDENT, 'GET /portal/timetable': STUDENT, 'GET /portal/attendance': STUDENT, 'GET /portal/fees': STUDENT,
  'GET /portal/payments/:id/receipt.pdf': STUDENT, 'GET /portal/materials': STUDENT, 'GET /portal/assignments': STUDENT, 'POST /portal/assignments/:id/submit': STUDENT,
  'GET /portal/results': STUDENT, 'GET /portal/certificates': STUDENT, 'GET /portal/certificates/:id/pdf': STUDENT, 'GET /portal/exams': STUDENT,
  // ── Parent portal (linked children's fees and receipts only) ──
  'GET /parent/children': PARENT, 'GET /parent/children/:studentId/fees': PARENT, 'GET /parent/children/:studentId/payments/:paymentId/receipt.pdf': PARENT,
  'POST /students/:id/guardians/:gid/parent-account': STU_W, 'DELETE /students/:id/guardians/:gid/parent-account': STU_W,
  'POST /portal/exams/:id/start': STUDENT, 'PUT /portal/attempts/:id/answers': STUDENT, 'POST /portal/attempts/:id/event': STUDENT, 'POST /portal/attempts/:id/submit': STUDENT,
};

/** Route inventory read from source: mount prefixes from app.ts, handlers from each router file. */
function inventory(): string[] {
  const src = path.resolve(__dirname, '../src');
  const mounts: Record<string, string> = { auth: '/auth', public: '/public', webhooks: '/webhooks', admin: '/admin', academics: '/academics', crm: '/crm', students: '/students', finance: '/finance', exams: '/exams', approvals: '/approvals', notifications: '/notifications', whatsapp: '/whatsapp', dashboard: '/dashboard', portal: '/portal', parent: '/parent' };
  const out: string[] = [];
  for (const f of fs.readdirSync(path.join(src, 'routes'))) {
    const name = f.replace(/\.ts$/, '');
    const text = fs.readFileSync(path.join(src, 'routes', f), 'utf8');
    for (const m of text.matchAll(/^(r|documentsRouter)\.(get|post|put|patch|delete)\('([^']+)'/gm)) {
      const prefix = m[1] === 'documentsRouter' ? '/documents' : mounts[name];
      if (!prefix) throw new Error(`Router ${name} is not mounted in the inventory`);
      out.push(`${m[2].toUpperCase()} ${prefix}${m[3] === '/' ? '' : m[3]}`);
    }
  }
  const appText = fs.readFileSync(path.join(src, 'app.ts'), 'utf8');
  for (const m of appText.matchAll(/v1\.(get|post|put|patch|delete)\('([^']+)'/g)) out.push(`${m[1].toUpperCase()} ${m[2]}`);
  return out;
}

const tokens = {} as Record<Role, string>;
beforeAll(async () => {
  const sa = await makeUser(['super_admin']);
  const st = await makeUser(['student']);
  const parent = await makeUser(['parent']);
  const rec = await makeStudent({});
  await prisma.student.update({ where: { id: rec.id }, data: { userId: st.id } });
  const map: Record<Role, string> = { sa: sa.username, mgmt: 'director', admin: 'office', sales: 'salesmgr', couns: 'counselor1', finmgr: 'finmgr', finstaff: 'accounts', acad: 'acadmgr', fac: 'faculty1', exam: 'examofficer', student: st.username, parent: parent.username };
  for (const r of ALL) tokens[r] = await sessionFor(map[r]);
});

const routes = inventory();
const concrete = (p: string) => `/api/v1${p.replace(/:[a-zA-Z]+/g, 'nonexistent-id')}`;
const call = (route: string, token?: string) => {
  const [method, p] = route.split(' ');
  const r = (request(app) as any)[method.toLowerCase()](concrete(p));
  return (token ? r.set(as(token)) : r).send({});
};

describe('SEC-T30 route inventory', () => {
  it('every registered route has an explicit permission expectation (and no stale entries)', () => {
    const missing = routes.filter((r) => !(r in MATRIX));
    const stale = Object.keys(MATRIX).filter((k) => !routes.includes(k));
    expect(missing, `Routes without an expectation:\n${missing.join('\n')}`).toEqual([]);
    expect(stale, `Expectations for routes that do not exist:\n${stale.join('\n')}`).toEqual([]);
    expect(routes.length).toBe(Object.keys(MATRIX).length);
  });
});

describe('SEC-T30 RBAC matrix (SRS 6.12)', () => {
  for (const route of routes) {
    const exp = MATRIX[route];
    if (!exp) continue;
    if (exp === PUBLIC) {
      it(`${route} — public (no session required)`, async () => {
        const res = await call(route);
        expect(res.body?.error?.code, route).not.toBe('UNAUTHENTICATED');
      });
      continue;
    }
    it(`${route} — ${exp.length === ALL.length ? 'all roles' : exp.join(', ')}`, async () => {
      const problems: string[] = [];
      const anon = await call(route);
      if (anon.status !== 401) problems.push(`anonymous: expected 401, got ${anon.status}`);
      for (const role of ALL) {
        const res = await call(route, tokens[role]);
        const ok = exp.includes(role);
        if (ok && (res.status === 401 || res.status === 403)) problems.push(`${role}: expected access, got ${res.status} ${res.body?.error?.code ?? ''}`);
        if (!ok && res.status !== 403) problems.push(`${role}: expected 403, got ${res.status}`);
      }
      expect(problems, problems.join('\n')).toEqual([]);
    });
  }
});
