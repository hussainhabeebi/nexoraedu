/**
 * End-to-end lifecycle (SRS §21): Enquiry → Application → Admission approval → Student → Fees → Exam → Result.
 * Runs against the disposable test database as the restricted app role. Privileged users (MFA roles) use
 * fixture sessions; non-privileged users sign in over HTTP.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, as, login, prisma, sessionFor } from './helpers';

let counselor: string, salesmgr: string, accounts: string, examOfficer: string, admin: string;
let courseId: string, batchId: string, studentId: string, studentToken: string;

beforeAll(async () => {
  counselor = await login('counselor1');
  // MFA roles (Sales Manager and Exam Officer included per decision 3) use fixture sessions.
  [salesmgr, examOfficer, accounts, admin] = await Promise.all([sessionFor('salesmgr'), sessionFor('examofficer'), sessionFor('accounts'), sessionFor('owner2')]);
  const c = await prisma.course.findUniqueOrThrow({ where: { code: 'FSD' }, include: { batches: true } });
  courseId = c.id;
  batchId = c.batches.find((b) => b.status === 'RUNNING')!.id;
});

describe('auth & RBAC', () => {
  it('rejects bad credentials with a generic message', async () => {
    const r = await request(app).post('/api/v1/auth/login').send({ identifier: 'admin', password: 'wrong' });
    expect(r.status).toBe(401);
    expect(r.body.error.message).toMatch(/username or password/);
  });
  it('blocks counselors from finance and admin APIs', async () => {
    expect((await request(app).get('/api/v1/finance/payments').set(as(counselor))).status).toBe(403);
    expect((await request(app).post('/api/v1/admin/users').set(as(counselor)).send({})).status).toBe(403);
  });
  it('requires auth on private endpoints', async () => {
    expect((await request(app).get('/api/v1/students')).status).toBe(401);
  });
});

describe('CRM', () => {
  it('creates a lead from the website and detects duplicates', async () => {
    const r = await request(app).post('/api/v1/public/enquiry').send({ name: 'Test Person', phone: '98950 11111', email: 'tp@example.com', courseId });
    expect(r.status).toBe(201);
    const dup = await request(app).post('/api/v1/crm/leads').set(as(salesmgr)).send({ name: 'Other', phone: '+919895011111' });
    expect(dup.status).toBe(409);
  });
  it('requires a reason to close a lead as lost', async () => {
    const lead = await prisma.lead.findFirstOrThrow({ where: { phoneNormalized: '+919895011111' } });
    const r = await request(app).post(`/api/v1/crm/leads/${lead.id}/status`).set(as(salesmgr)).send({ status: 'LOST' });
    expect(r.status).toBe(400);
  });
});

describe('admission lifecycle', () => {
  let appId: string;
  it('accepts an online application (under-18 needs guardian)', async () => {
    const data = { personal: { fullName: 'Minor Applicant', dob: '2012-01-01', gender: 'Male', phone: '9895022222', email: 'minor@example.com', address: '12 MG Road, Kochi' }, guardians: [], education: [], preferences: { courseId, batchId }, declaration: true };
    const bad = await request(app).post('/api/v1/public/applications').field('data', JSON.stringify(data));
    expect(bad.status).toBe(400);
    const ok = await request(app)
      .post('/api/v1/public/applications')
      .field('data', JSON.stringify({ ...data, personal: { ...data.personal, fullName: 'Asha Varma', dob: '2003-05-05', phone: '9895033333', email: 'asha@example.com' }, education: [{ level: 'plus_two', institution: 'GHSS Kochi', year: 2021, marks: '88%' }] }))
      .attach('files', Buffer.from('%PDF-1.4 test'), { filename: 'id.pdf', contentType: 'application/pdf' })
      .field('fileTypes', 'id_proof');
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const app0 = await prisma.application.findUniqueOrThrow({ where: { code: ok.body.code }, include: { documents: true } });
    expect(app0.documents).toHaveLength(1);
    appId = app0.id;
    const track = await request(app).get('/api/v1/public/applications/status').query({ code: ok.body.code, phone: '+91 98950 33333' });
    expect(track.body.status).toBe('SUBMITTED');
  });

  it('admission needs Sales Manager approval and creates student, portal login and fee plan', async () => {
    const r = await request(app).post(`/api/v1/crm/applications/${appId}/admit`).set(as(salesmgr)).send({ batchId, installments: 3 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.approval.status).toBe('PENDING');
    // requester cannot self-approve
    expect((await request(app).post(`/api/v1/approvals/${r.body.approval.id}/act`).set(as(salesmgr)).send({ action: 'APPROVE' })).status).toBe(403);
    const ap = await request(app).post(`/api/v1/approvals/${r.body.approval.id}/act`).set(as(admin)).send({ action: 'APPROVE' });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    const st = await prisma.student.findFirstOrThrow({ where: { emailNormalized: 'asha@example.com' }, include: { feePlans: { include: { installments: true } }, lead: true, documents: true } });
    studentId = st.id;
    expect(st.studentCode).toMatch(/^NXA-\d{4}-\d{5}$/);
    expect(st.feePlans[0].installments).toHaveLength(3);
    expect(st.lead?.status).toBe('ADMITTED');
    expect(st.documents).toHaveLength(1);
    const total = st.feePlans[0].installments.reduce((s, i) => s + Number(i.amount), 0);
    expect(total).toBeCloseTo(5000 + 45000 * 1.18 + 2000, 2);
  });

  it('blocks duplicate student registration', async () => {
    const r = await request(app).post('/api/v1/students').set(as(admin)).send({ data: { personal: { fullName: 'Asha V', dob: '2003-05-05', gender: 'Female', phone: '9895033333', email: 'x@example.com', address: 'Somewhere 123' }, preferences: { courseId, batchId } } });
    expect(r.status).toBe(409);
  });
});

describe('finance', () => {
  it('records payments idempotently, allocates FIFO and posts the ledger', async () => {
    const body = { studentId, amount: 10000, mode: 'UPI', reference: 'UPI123' };
    const a = await request(app).post('/api/v1/finance/payments').set(as(accounts)).set('Idempotency-Key', 'k-1').send(body);
    const b = await request(app).post('/api/v1/finance/payments').set(as(accounts)).set('Idempotency-Key', 'k-1').send(body);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    const acct = await request(app).get(`/api/v1/finance/students/${studentId}/account`).set(as(accounts));
    expect(acct.body.payments).toHaveLength(1);
    expect(acct.body.plans[0].installments[0].status).toBe('PARTIAL');
    const pdf = await request(app).get(`/api/v1/finance/payments/${a.body.id}/receipt.pdf`).set(as(accounts));
    expect(pdf.headers['content-type']).toBe('application/pdf');
  });
  it('rejects overpayment and keeps the ledger immutable', async () => {
    const r = await request(app).post('/api/v1/finance/payments').set(as(accounts)).send({ studentId, amount: 9999999, mode: 'CASH' });
    expect(r.status).toBe(409);
    await expect(prisma.ledgerEntry.deleteMany({ where: { studentId } })).rejects.toThrow();
  });
  it('payment cancellation goes through approval and posts a reversal', async () => {
    const p = await prisma.payment.findFirstOrThrow({ where: { studentId } });
    const req1 = await request(app).post(`/api/v1/finance/payments/${p.id}/cancel-request`).set(as(accounts)).send({ reason: 'Wrong student selected' });
    expect(req1.status).toBe(200);
    const finmgr = await sessionFor('finmgr');
    await request(app).post(`/api/v1/approvals/${req1.body.approval.id}/act`).set(as(finmgr)).send({ action: 'APPROVE' });
    const types = (await prisma.ledgerEntry.findMany({ where: { studentId } })).map((e) => e.type);
    expect(types).toContain('REVERSAL');
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('CANCELLED');
  });
});

describe('online exam', () => {
  it('runs an auto-graded exam end to end and hides answers', async () => {
    const q = await request(app).post('/api/v1/exams/questions').set(as(examOfficer)).send({ courseId, type: 'MCQ_SINGLE', text: '2+2?', options: ['3', '4', '5'], correct: '4', marks: 5 });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    const now = Date.now();
    const ex = await request(app).post('/api/v1/exams/exams').set(as(examOfficer)).send({ title: 'Quiz 1', courseId, batchId, type: 'MODULE_TEST', mode: 'ONLINE', startAt: new Date(now - 60000), endAt: new Date(now + 3600000), durationMin: 30, totalMarks: 5, passMarks: 2 });
    expect(ex.status, JSON.stringify(ex.body)).toBe(201);
    await request(app).put(`/api/v1/exams/exams/${ex.body.id}/questions`).set(as(examOfficer)).send({ questionIds: [q.body.id] });
    const asg = await request(app).post(`/api/v1/exams/exams/${ex.body.id}/assign`).set(as(examOfficer)).send({ studentIds: [studentId] });
    expect(asg.body.assigned).toBe(1);
    expect((await request(app).post(`/api/v1/exams/exams/${ex.body.id}/schedule`).set(as(examOfficer))).status).toBe(200);

    const st = await prisma.student.findUniqueOrThrow({ where: { id: studentId }, include: { user: true } });
    // Decision 8: admission creates the portal account WITHOUT a password and sends a single-use activation link.
    const u = await prisma.user.findUniqueOrThrow({ where: { id: st.userId! } });
    expect(u.passwordHash.startsWith('$2')).toBe(false);
    expect(await prisma.passwordReset.count({ where: { userId: u.id, purpose: 'ENROLL', usedAt: null } })).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    const logs = await prisma.notificationLog.findMany({ where: { templateKey: 'admission.confirmed' } });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => l.body.startsWith('[redacted'))).toBe(true); // the link never sits in the log
    // The student activates with the link (a fresh link is issued here because only its hash is stored).
    const { issueActivationLink } = await import('../src/lib/activation');
    const act = await issueActivationLink(prisma, u.id);
    const activated = await request(app).post('/api/v1/auth/reset-password').send({ token: act.token, newPassword: 'Velvet#Comet-Trail-2026' });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    studentToken = await login(st.studentCode.toLowerCase(), 'Velvet#Comet-Trail-2026');

    const start = await request(app).post(`/api/v1/portal/exams/${ex.body.id}/start`).set(as(studentToken)).send({ acknowledged: true });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    expect(JSON.stringify(start.body)).not.toContain('"correct"');
    await request(app).put(`/api/v1/portal/attempts/${start.body.attemptId}/answers`).set(as(studentToken)).send({ answers: { [q.body.id]: '4' } });
    const sub = await request(app).post(`/api/v1/portal/attempts/${start.body.attemptId}/submit`).set(as(studentToken)).send({});
    expect(sub.body.status).toBe('EVALUATED');
    // attempt limit
    expect((await request(app).post(`/api/v1/portal/exams/${ex.body.id}/start`).set(as(studentToken)).send({ acknowledged: true })).status).toBe(409);

    expect((await request(app).post(`/api/v1/exams/exams/${ex.body.id}/process`).set(as(examOfficer))).body.processed).toBe(1);
    // unpublished results are hidden from the student
    expect((await request(app).get('/api/v1/portal/results').set(as(studentToken))).body.items).toHaveLength(0);
    await request(app).post(`/api/v1/exams/exams/${ex.body.id}/publish`).set(as(examOfficer));
    const res = await request(app).get('/api/v1/portal/results').set(as(studentToken));
    expect(res.body.items[0]).toMatchObject({ marks: 5, grade: 'A+', passed: true });
  });

  it('students cannot read other students or staff APIs', async () => {
    expect((await request(app).get('/api/v1/students').set(as(studentToken))).status).toBe(403);
    const other = await prisma.payment.findFirst({ where: { NOT: { studentId } } });
    if (other) expect((await request(app).get(`/api/v1/portal/payments/${other.id}/receipt.pdf`).set(as(studentToken))).status).toBe(404);
  });
});

describe('dashboards & audit', () => {
  it('returns role-specific widgets', async () => {
    const s = await request(app).get('/api/v1/dashboard').set(as(salesmgr));
    expect(s.body.sales).toBeDefined();
    expect(s.body.finance).toBeUndefined();
    const a = await request(app).get('/api/v1/dashboard').set(as(admin));
    expect(a.body.management.kpis.activeStudents).toBeGreaterThan(0);
  });
  it('audit log is append-only', async () => {
    expect(await prisma.auditLog.count()).toBeGreaterThan(0);
    await expect(prisma.auditLog.updateMany({ data: { action: 'X' } })).rejects.toThrow();
  });
});

describe('chatwoot webhook', () => {
  it('creates a lead from an inbound WhatsApp message', async () => {
    const r = await request(app).post('/api/v1/webhooks/chatwoot').send({
      event: 'message_created', message_type: 'incoming', content: 'Hi, I want details of Data Science course', id: 991,
      conversation: { id: 55, inbox_id: 1 }, sender: { id: 77, name: 'WA Prospect', phone_number: '+919895044444' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const lead = await prisma.lead.findFirstOrThrow({ where: { phoneNormalized: '+919895044444' }, include: { activities: true } });
    expect(lead.source).toBe('whatsapp');
    expect(lead.chatwootConversationId).toBe(55);
    expect(lead.activities.some((a) => a.type === 'WHATSAPP' && a.direction === 'INBOUND')).toBe(true);
  });
});
