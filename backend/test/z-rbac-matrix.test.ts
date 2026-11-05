/**
 * SEC-T30 — role × endpoint matrix derived from SRS §6.12 (with the documented decisions C3–C9).
 * Expectation: allowed roles never get 401/403; every other role gets 403.
 * Placeholder IDs and empty bodies are used, so "allowed" requests stop at validation (400/404/422) without
 * changing data. Rows marked LOOKUP are deliberate read-only deviations needed by forms in other modules.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, as, makeStudent, makeUser, prisma, sessionFor } from './helpers';

type Role = 'sa' | 'mgmt' | 'admin' | 'sales' | 'couns' | 'finmgr' | 'finstaff' | 'acad' | 'fac' | 'exam' | 'student';
const ALL: Role[] = ['sa', 'mgmt', 'admin', 'sales', 'couns', 'finmgr', 'finstaff', 'acad', 'fac', 'exam', 'student'];
const STAFF = ALL.filter((r) => r !== 'student');

const X = 'nonexistent-id';
// [method, path, allowed roles, SRS reference / note]
const MATRIX: [string, string, Role[], string][] = [
  // Users / Roles: SA CRUD, Mgmt R, Admin CRU
  ['get', '/admin/users', ['sa', 'mgmt', 'admin'], '6.12 Users/Roles R'],
  ['post', '/admin/users', ['sa', 'admin'], '6.12 Users C'],
  ['patch', `/admin/users/${X}`, ['sa', 'admin'], '6.12 Users U'],
  ['get', '/admin/roles', ['sa', 'mgmt', 'admin'], '6.12 Roles R'],
  ['post', '/admin/roles', ['sa'], '§9 Rules: only Super Admin changes roles (C3)'],
  ['put', '/admin/workflows/ADMISSION', ['sa'], '§9 Rules: only Super Admin changes workflows'],
  ['put', '/admin/settings/security', ['sa'], 'ADM-09 settings'],
  ['get', '/admin/audit-logs', ['sa', 'mgmt'], '6.12 Audit Logs R'],
  ['get', '/admin/login-logs', ['sa', 'mgmt'], '6.12 Audit Logs R'],
  // Leads / CRM: SA CRUD, Mgmt R, Admin R, Sales CRUDA, Counselor CRU(O)
  ['get', '/crm/leads', ['sa', 'mgmt', 'admin', 'sales', 'couns'], '6.12 Leads R'],
  ['post', '/crm/leads', ['sa', 'sales', 'couns'], '6.12 Leads C'],
  ['patch', `/crm/leads/${X}`, ['sa', 'sales', 'couns'], '6.12 Leads U'],
  ['post', '/crm/leads/assign', ['sa', 'sales'], 'CRM-15 reassignment'],
  ['post', `/crm/leads/${X}/merge`, ['sa', 'sales'], 'CRM-16 merge (Sales Manager)'],
  // Students: everyone on staff R (scoped for counselor/faculty), Admin CRU, Student own via portal
  ['get', '/students', STAFF, '6.12 Students R (counselor own C8, faculty batch)'],
  ['post', '/students', ['sa', 'admin'], '6.12 Students C'],
  ['patch', `/students/${X}`, ['sa', 'admin'], '6.12 Students U'],
  ['get', '/documents/pending', ['sa', 'admin'], '22.8 document verification (Administrator)'],
  ['get', `/documents/${X}/download`, ['sa', 'admin', 'mgmt', 'sales', 'couns'], 'FR-DOC-02 (gate; object-level policy then refuses mgmt — see 30-access-control)'],
  // Fees / Payments: Mgmt R, Admin R, FinMgr CRUDA, FinStaff CRU, Student R(O) via portal
  ['get', '/finance/payments', ['sa', 'mgmt', 'admin', 'finmgr', 'finstaff'], '6.12 Fees R'],
  ['post', '/finance/payments', ['sa', 'finmgr', 'finstaff'], '6.12 Fees C'],
  ['post', '/finance/discounts', ['sa', 'finmgr', 'finstaff'], 'FIN-09 (staff request → approval)'],
  ['post', `/finance/refunds/${X}/pay`, ['sa', 'finmgr'], 'FIN-11 refund payment (Finance Manager)'],
  ['post', `/finance/students/${X}/fee-plan`, ['sa', 'finmgr'], 'FIN-03 custom plan'],
  ['get', '/finance/outstanding', ['sa', 'mgmt', 'admin', 'finmgr', 'finstaff'], '6.12 Fees R'],
  // Academics: Mgmt R, Admin R, AcadMgr CRUDA, Faculty CRU(batch)
  ['get', '/academics/batches', ['sa', 'mgmt', 'admin', 'sales', 'couns', 'finmgr', 'finstaff', 'acad', 'fac', 'exam'], 'LOOKUP: batch picker for admission/fees/exams (read-only)'],
  ['post', '/academics/batches', ['sa', 'acad'], '6.12 Academics C'],
  ['post', '/academics/timetable', ['sa', 'acad'], 'ACD-06'],
  ['post', `/academics/sessions/${X}/attendance`, ['sa', 'acad', 'fac'], 'ACD-07 Faculty marks attendance'],
  ['post', '/academics/materials', ['sa', 'acad', 'fac'], 'ACD-10'],
  // Examinations: Mgmt R, Admin R, AcadMgr R, Faculty R, ExamOfficer CRUDA
  ['get', '/exams/exams', ['sa', 'mgmt', 'admin', 'acad', 'fac', 'exam'], '6.12 Examinations R'],
  ['post', '/exams/exams', ['sa', 'exam'], '6.12 Examinations C'],
  ['post', `/exams/exams/${X}/publish`, ['sa', 'exam'], 'EXM-16 publish'],
  ['get', '/exams/questions', ['sa', 'mgmt', 'admin', 'acad', 'fac', 'exam'], 'EXM-03 (answer keys hidden unless exam manager)'],
  // Reports: all staff R (scoped), Student none
  ['get', '/dashboard/reports', STAFF, '6.12 Reports R'],
  ['get', '/dashboard/reports/collections', ['sa', 'mgmt', 'admin', 'finmgr', 'finstaff'], '15.6 collection report'],
  ['get', '/dashboard/reports/leads', ['sa', 'mgmt', 'admin', 'sales'], '15.3 lead report (counselor own view: dashboard)'],
  // Approvals: A for SA, Mgmt, Sales, FinMgr, AcadMgr, ExamOfficer
  ['post', `/approvals/${X}/act`, ['sa', 'mgmt', 'sales', 'finmgr', 'acad', 'exam'], '6.12 Approvals A'],
  // Student portal
  ['get', '/portal/me', ['student'], '6.11 Student own profile'],
  ['get', '/portal/fees', ['student'], '6.11 Student own fees'],
];

const tokens = {} as Record<Role, string>;
beforeAll(async () => {
  const sa = await makeUser(['super_admin']);
  const st = await makeUser(['student']);
  const rec = await makeStudent({});
  await prisma.student.update({ where: { id: rec.id }, data: { userId: st.id } });
  const map: Record<Role, string> = { sa: sa.username, mgmt: 'director', admin: 'office', sales: 'salesmgr', couns: 'counselor1', finmgr: 'finmgr', finstaff: 'accounts', acad: 'acadmgr', fac: 'faculty1', exam: 'examofficer', student: st.username };
  for (const r of ALL) tokens[r] = await sessionFor(map[r]);
});

describe('SEC-T30 RBAC matrix (SRS 6.12)', () => {
  for (const [method, path, allowed, ref] of MATRIX) {
    it(`${method.toUpperCase()} ${path} — ${ref}`, async () => {
      const problems: string[] = [];
      for (const role of ALL) {
        const res = await (request(app) as any)[method](`/api/v1${path}`).set(as(tokens[role])).send({});
        const ok = allowed.includes(role);
        if (ok && (res.status === 401 || res.status === 403)) problems.push(`${role}: expected access, got ${res.status} ${res.body?.error?.code ?? ''}`);
        if (!ok && res.status !== 403) problems.push(`${role}: expected 403, got ${res.status}`);
      }
      expect(problems, problems.join('\n')).toEqual([]);
    });
  }

  it('unauthenticated requests are refused on every matrix endpoint', async () => {
    for (const [method, path] of MATRIX) {
      const res = await (request(app) as any)[method](`/api/v1${path}`).send({});
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});
