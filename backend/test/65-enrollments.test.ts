/**
 * Enrollment history (SRS 20.4, 20.12, STU-09, STU-10, STU-13, 21.3, CRM-13, FIN-02). Synthetic data only.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, as, makeStudent, makeUser, prisma, sessionFor } from './helpers';
import { openEnrollment } from '../src/services/enrollments';
import { reconcile } from '../src/services/reconciliation';

let sa: string, office: string, sales: string, couns: string, acad: string, fin: string, accounts: string, fac: string;
let fsdCourseId: string, fsdBatches: string[], dmCourseId: string, dmBatch: string;
let n = 0;
const uniq = () => `${Date.now()}${++n}`.slice(-8);

beforeAll(async () => {
  const s = await makeUser(['super_admin']);
  [sa, office, sales, couns, acad, fin, accounts, fac] = await Promise.all([s.username, 'office', 'salesmgr', 'counselor1', 'acadmgr', 'finmgr', 'accounts', 'faculty1'].map((u) => sessionFor(u)));
  const fsd = await prisma.course.findUniqueOrThrow({ where: { code: 'FSD' }, include: { batches: { orderBy: { startDate: 'asc' } } } });
  fsdCourseId = fsd.id;
  fsdBatches = fsd.batches.map((b) => b.id);
  const dm = await prisma.course.findUniqueOrThrow({ where: { code: 'DM' }, include: { batches: true } });
  dmCourseId = dm.id;
  dmBatch = dm.batches[0].id;
});

const act = async (approvalId: string, tok = sa) => {
  const r = await request(app).post(`/api/v1/approvals/${approvalId}/act`).set(as(tok)).send({ action: 'APPROVE' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
async function admitViaCrm(batchId: string | null) {
  const u = uniq();
  const lead = await request(app).post('/api/v1/crm/leads').set(as(couns)).send({ name: `Enrol ${u}`, phone: `+9177${u}`, email: `enrol${u}@example.invalid`, courseId: fsdCourseId, source: 'walk_in' });
  expect(lead.status, JSON.stringify(lead.body)).toBe(201);
  const data = { personal: { fullName: `Enrol Student ${u}`, dob: '2001-02-03', gender: 'Female', phone: `+9177${u}`, email: `enrol${u}@example.invalid`, address: '12 Synthetic Road' }, guardians: [], education: [], preferences: { courseId: fsdCourseId, batchId } };
  const appl = await request(app).post(`/api/v1/crm/leads/${lead.body.id}/application`).set(as(couns)).send(data);
  expect(appl.status, JSON.stringify(appl.body)).toBe(201);
  const adm = await request(app).post(`/api/v1/crm/applications/${appl.body.id}/admit`).set(as(sales)).send(batchId ? { batchId, installments: 2 } : { installments: 2 });
  return { appl: appl.body, adm };
}
const enrollmentsOf = (studentId: string) => prisma.enrollment.findMany({ where: { studentId }, orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }] });

describe('New enrollment on admission (CRM-13, 22.3 unchanged)', () => {
  it('admission still needs Sales Manager approval; the approved admission opens the first enrollment, linked to application, approval and fee plan', async () => {
    const { appl, adm } = await admitViaCrm(fsdBatches[0]);
    expect(adm.body.approval.status).toBe('PENDING');
    expect(await prisma.enrollment.count({ where: { applicationId: appl.id } })).toBe(0); // nothing before approval
    await act(adm.body.approval.id);
    const st = await prisma.student.findFirstOrThrow({ where: { lead: { applications: { some: { id: appl.id } } } } });
    const [e] = await enrollmentsOf(st.id);
    expect(e).toMatchObject({ status: 'ACTIVE', source: 'ADMISSION', courseId: fsdCourseId, batchId: fsdBatches[0], applicationId: appl.id, approvalRequestId: adm.body.approval.id, endedAt: null });
    const plan = await prisma.feePlan.findFirstOrThrow({ where: { studentId: st.id } });
    expect(plan.enrollmentId).toBe(e.id);
    expect(await prisma.auditLog.count({ where: { action: 'ENROLLMENT_CREATE', entityId: e.id } })).toBe(1);
  });

  it('direct registration by Administration (existing STU-01 path) opens a DIRECT enrollment', async () => {
    const u = uniq();
    const r = await request(app).post('/api/v1/students').set(as(office)).send({ data: { personal: { fullName: `Direct ${u}`, dob: '2000-01-01', gender: 'Male', phone: `+9176${u}`, email: `direct${u}@example.invalid`, address: '1 Synthetic Lane' }, preferences: { courseId: fsdCourseId, batchId: fsdBatches[0] } } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const [e] = await enrollmentsOf(r.body.id);
    expect(e).toMatchObject({ source: 'DIRECT', status: 'ACTIVE' });
    expect((await prisma.feePlan.findFirstOrThrow({ where: { studentId: r.body.id } })).enrollmentId).toBe(e.id);
  });
});

describe('Transfers, course changes and history (STU-10, 21.3)', () => {
  it('batch transfer and course change close the old enrollment and keep it; finance and attendance stay with their enrollment', async () => {
    const st = await makeStudent({ batchId: fsdBatches[0] });
    const [first] = await enrollmentsOf(st.id);
    // A fee plan and one attendance record on the first enrollment.
    const plan = await request(app).post(`/api/v1/finance/students/${st.id}/fee-plan`).set(as(fin)).send({ installments: 2, startDate: '2027-01-31' });
    expect(plan.status, JSON.stringify(plan.body)).toBe(201);
    expect(plan.body.enrollmentId).toBe(first.id);
    const f1 = await prisma.user.findUniqueOrThrow({ where: { username: 'faculty1' } });
    const sess = await prisma.timetableSession.create({ data: { batchId: fsdBatches[0], facultyId: f1.id, startsAt: new Date(Date.now() - 3600_000), endsAt: new Date(Date.now() - 1800_000) } });
    expect((await request(app).post(`/api/v1/academics/sessions/${sess.id}/attendance`).set(as(fac)).send({ records: [{ studentId: st.id, status: 'PRESENT' }] })).status).toBe(200);
    expect((await prisma.attendance.findFirstOrThrow({ where: { sessionId: sess.id, studentId: st.id } })).enrollmentId).toBe(first.id);

    // 1) Batch transfer (same course) — requires approval, nothing changes before it.
    const t1 = await request(app).post(`/api/v1/students/${st.id}/transfer`).set(as(office)).send({ toBatchId: fsdBatches[1], reason: 'Evening batch requested' });
    expect(t1.status, JSON.stringify(t1.body)).toBe(200);
    expect((await enrollmentsOf(st.id))).toHaveLength(1);
    await act(t1.body.approval.id, acad);
    // 2) Course change — same approval type.
    const t2 = await request(app).post(`/api/v1/students/${st.id}/transfer`).set(as(office)).send({ toBatchId: dmBatch, reason: 'Moving to Digital Marketing' });
    await act(t2.body.approval.id, acad);

    const hist = await enrollmentsOf(st.id);
    expect(hist.map((e) => [e.status, e.source])).toEqual([['TRANSFERRED', 'DIRECT'], ['TRANSFERRED', 'TRANSFER'], ['ACTIVE', 'COURSE_CHANGE']]);
    expect(hist[1].previousEnrollmentId).toBe(hist[0].id);
    expect(hist[2].previousEnrollmentId).toBe(hist[1].id);
    expect(hist[0].endedAt).not.toBeNull();
    expect(hist[0].endReason).toBe('Evening batch requested');
    expect(hist[2]).toMatchObject({ courseId: dmCourseId, batchId: dmBatch, approvalRequestId: t2.body.approval.id });
    expect(await prisma.student.findUniqueOrThrow({ where: { id: st.id } })).toMatchObject({ courseId: dmCourseId, batchId: dmBatch });
    // Fee plan and attendance stay attached to the enrollment they belong to.
    expect((await prisma.feePlan.findUniqueOrThrow({ where: { id: plan.body.id } })).enrollmentId).toBe(first.id);
    expect((await prisma.attendance.findFirstOrThrow({ where: { sessionId: sess.id, studentId: st.id } })).enrollmentId).toBe(first.id);
    // Course change: no automatic fee plan; Finance can create one for the NEW enrollment, but only one.
    expect(await prisma.feePlan.count({ where: { enrollmentId: hist[2].id } })).toBe(0);
    const p2 = await request(app).post(`/api/v1/finance/students/${st.id}/fee-plan`).set(as(fin)).send({ installments: 1 });
    expect(p2.status, JSON.stringify(p2.body)).toBe(201);
    expect(p2.body.enrollmentId).toBe(hist[2].id);
    expect((await request(app).post(`/api/v1/finance/students/${st.id}/fee-plan`).set(as(fin)).send({ installments: 1 })).status).toBe(400);
    // History API (scoped) and audit trail.
    const api = await request(app).get(`/api/v1/students/${st.id}/enrollments`).set(as(office));
    expect(api.body.items.map((e: any) => e.status)).toEqual(['ACTIVE', 'TRANSFERRED', 'TRANSFERRED']);
    expect(api.body.items[2]._count.attendance).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'ENROLLMENT_TRANSFERRED', entityId: { in: hist.map((e) => e.id) } } })).toBe(2);
    expect(await prisma.studentHistory.count({ where: { studentId: st.id, type: 'BATCH' } })).toBe(2);
    // Finance remains consistent.
    expect((await reconcile({ studentId: st.id })).issues.filter((i) => i.severity === 'ERROR')).toEqual([]);
  });

  it('allotting a batch to an enrollment admitted without one updates that enrollment (not a transfer)', async () => {
    // The CRM admission path requires a batch (existing rule, unchanged); a "batch to be allotted" enrollment
    // arises from direct registration without a batch or a re-activation after the old batch ended.
    const st = await makeStudent({ batchId: null });
    expect((await enrollmentsOf(st.id))[0].batchId).toBeNull();
    const t = await request(app).post(`/api/v1/students/${st.id}/transfer`).set(as(office)).send({ toBatchId: fsdBatches[0], reason: 'Batch allotted' });
    await act(t.body.approval.id, acad);
    const hist = await enrollmentsOf(st.id);
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ status: 'ACTIVE', batchId: fsdBatches[0] });
    expect(await prisma.auditLog.count({ where: { action: 'ENROLLMENT_BATCH_ALLOTTED', entityId: hist[0].id } })).toBe(1);
  });

  it('a transfer to the same batch, or without a current enrollment, is refused before any approval', async () => {
    const st = await makeStudent({ batchId: fsdBatches[0] });
    expect((await request(app).post(`/api/v1/students/${st.id}/transfer`).set(as(office)).send({ toBatchId: fsdBatches[0], reason: 'Same batch' })).status).toBe(400);
    const legacy = await prisma.student.create({ data: { studentCode: `LEG-${uniq()}`, fullName: 'No Enrollment', dob: new Date('2000-01-01'), gender: 'Other', phone: `+9175${uniq()}`, phoneNormalized: `+9175${uniq()}x`, email: `noenr${uniq()}@example.invalid`, emailNormalized: `noenr${uniq()}@example.invalid`, address: 'x road 1', courseId: fsdCourseId, batchId: fsdBatches[0] } });
    expect((await request(app).post(`/api/v1/students/${legacy.id}/transfer`).set(as(office)).send({ toBatchId: fsdBatches[1], reason: 'No enrollment' })).status).toBe(400);
  });
});

describe('Status changes, withdrawal, re-activation, cancellation (STU-13)', () => {
  const status = (id: string, s: string, reason = 'Synthetic reason') => request(app).post(`/api/v1/students/${id}/status`).set(as(office)).send({ status: s, reason });

  it('on hold / resume keep the same enrollment; withdrawal closes it; re-activation opens a new linked one', async () => {
    const st = await makeStudent({ batchId: fsdBatches[0] });
    expect((await status(st.id, 'ON_HOLD')).status).toBe(200);
    expect((await enrollmentsOf(st.id))[0].status).toBe('ON_HOLD');
    expect((await status(st.id, 'ACTIVE')).status).toBe(200);
    expect((await enrollmentsOf(st.id))).toHaveLength(1);
    expect((await status(st.id, 'WITHDRAWN', 'Relocated abroad')).status).toBe(200);
    let hist = await enrollmentsOf(st.id);
    expect(hist[0]).toMatchObject({ status: 'WITHDRAWN', endReason: 'Relocated abroad' });
    const re = await status(st.id, 'ACTIVE', 'Returned to the course');
    expect(re.body.note).toMatch(/new enrollment/);
    hist = await enrollmentsOf(st.id);
    expect(hist.map((e) => e.status)).toEqual(['WITHDRAWN', 'ACTIVE']);
    expect(hist[1]).toMatchObject({ source: 'REACTIVATION', previousEnrollmentId: hist[0].id, batchId: fsdBatches[0] });
    expect((await status(st.id, 'COMPLETED', 'Course finished')).status).toBe(200);
    expect((await enrollmentsOf(st.id))[1].status).toBe('COMPLETED');
  });

  it('re-activation respects batch capacity (nothing changes when the batch is full)', async () => {
    const course = await prisma.course.findUniqueOrThrow({ where: { code: 'ACC' } });
    const batch = await prisma.batch.create({ data: { code: `EN-CAP-${uniq()}`, name: 'Cap', courseId: course.id, startDate: new Date(), capacity: 1, status: 'RUNNING' } });
    const a = await makeStudent({ courseCode: 'ACC', batchId: batch.id });
    expect((await status(a.id, 'WITHDRAWN')).status).toBe(200);
    await makeStudent({ courseCode: 'ACC', batchId: batch.id }); // takes the only seat
    const r = await status(a.id, 'ACTIVE', 'Wants to return');
    expect(r.status).toBe(409);
    expect((await prisma.student.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('WITHDRAWN'); // rolled back
    expect((await enrollmentsOf(a.id)).map((e) => e.status)).toEqual(['WITHDRAWN']);
  });

  it('cancellation: only without attendance or payments; withdraws the student; fee plans are not touched', async () => {
    const st = await makeStudent({ batchId: fsdBatches[0] });
    const [e] = await enrollmentsOf(st.id);
    await request(app).post(`/api/v1/finance/students/${st.id}/fee-plan`).set(as(fin)).send({ installments: 2 });
    const before = await prisma.installment.findMany({ where: { feePlan: { studentId: st.id } } });
    expect((await request(app).post(`/api/v1/students/${st.id}/enrollments/${e.id}/cancel`).set(as(acad)).send({ reason: 'Recorded by mistake' })).status).toBe(403);
    const r = await request(app).post(`/api/v1/students/${st.id}/enrollments/${e.id}/cancel`).set(as(office)).send({ reason: 'Recorded by mistake' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.unpaidInstallments).toBe(2);
    expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: e.id } })).status).toBe('CANCELLED');
    expect((await prisma.student.findUniqueOrThrow({ where: { id: st.id } })).status).toBe('WITHDRAWN');
    expect(await prisma.installment.findMany({ where: { feePlan: { studentId: st.id } } })).toEqual(before);
    expect((await request(app).post(`/api/v1/students/${st.id}/enrollments/${e.id}/cancel`).set(as(office)).send({ reason: 'Again please' })).status).toBe(409);
    expect(await prisma.auditLog.count({ where: { action: 'ENROLLMENT_CANCELLED', entityId: e.id } })).toBe(1);

    const paid = await makeStudent({ batchId: fsdBatches[0] });
    const [pe] = await enrollmentsOf(paid.id);
    await request(app).post(`/api/v1/finance/students/${paid.id}/fee-plan`).set(as(fin)).send({ installments: 1 });
    expect((await request(app).post('/api/v1/finance/payments').set(as(accounts)).send({ studentId: paid.id, amount: 100, mode: 'CASH' })).status).toBe(201);
    expect((await request(app).post(`/api/v1/students/${paid.id}/enrollments/${pe.id}/cancel`).set(as(office)).send({ reason: 'Recorded by mistake' })).status).toBe(409);

    const attended = await makeStudent({ batchId: fsdBatches[0] });
    const [ae] = await enrollmentsOf(attended.id);
    const sess = await prisma.timetableSession.create({ data: { batchId: fsdBatches[0], startsAt: new Date(Date.now() - 3600_000), endsAt: new Date(Date.now() - 1800_000) } });
    await prisma.attendance.create({ data: { sessionId: sess.id, studentId: attended.id, enrollmentId: ae.id, status: 'PRESENT', markedById: (await prisma.user.findUniqueOrThrow({ where: { username: 'acadmgr' } })).id } });
    expect((await request(app).post(`/api/v1/students/${attended.id}/enrollments/${ae.id}/cancel`).set(as(office)).send({ reason: 'Recorded by mistake' })).status).toBe(409);
  });
});

describe('Duplicate prevention (one current enrollment per student)', () => {
  it('service, database index and constraints all refuse invalid states', async () => {
    const st = await makeStudent({ batchId: fsdBatches[0] });
    await expect(prisma.$transaction((tx) => openEnrollment(tx, { studentId: st.id, courseId: dmCourseId, batchId: dmBatch, source: 'DIRECT' }))).rejects.toThrow(/already has a current enrollment/);
    await expect(prisma.enrollment.create({ data: { studentId: st.id, courseId: dmCourseId, batchId: dmBatch, status: 'ON_HOLD', source: 'DIRECT' } })).rejects.toThrow(); // partial unique index
    await expect(prisma.enrollment.create({ data: { studentId: st.id, courseId: dmCourseId, status: 'PAUSED', source: 'DIRECT' } })).rejects.toThrow(); // status CHECK
    await expect(prisma.enrollment.create({ data: { studentId: st.id, courseId: dmCourseId, status: 'COMPLETED', source: 'DIRECT' } })).rejects.toThrow(); // closed needs endedAt
    await expect(prisma.enrollment.deleteMany({ where: { studentId: st.id } })).rejects.toThrow(/permission denied/); // history never deleted
    expect(await prisma.enrollment.count({ where: { studentId: st.id } })).toBe(1);
  });

  it('parallel transfer approvals cannot create two current enrollments', async () => {
    const st = await makeStudent({ batchId: fsdBatches[0] });
    const [e] = await enrollmentsOf(st.id);
    const out = await Promise.allSettled([1, 2].map(() => prisma.$transaction((tx) => openEnrollment(tx, { studentId: st.id, courseId: dmCourseId, batchId: dmBatch, source: 'DIRECT' }))));
    expect(out.every((o) => o.status === 'rejected')).toBe(true);
    await prisma.$transaction(async (tx) => {
      await tx.enrollment.update({ where: { id: e.id }, data: { status: 'TRANSFERRED', endedAt: new Date() } });
    });
    const two = await Promise.allSettled([1, 2].map(() => prisma.$transaction((tx) => openEnrollment(tx, { studentId: st.id, courseId: dmCourseId, batchId: dmBatch, source: 'TRANSFER' }))));
    expect(two.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.enrollment.count({ where: { studentId: st.id, status: { in: ['ACTIVE', 'ON_HOLD'] } } })).toBe(1);
  });
});

describe('Access to enrollment history', () => {
  it('scoped like the student record; students see only their own via the portal', async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: 'counselor1' } });
    const st = await makeStudent({ ownerId: owner.id, batchId: fsdBatches[2] ?? fsdBatches[0] });
    expect((await request(app).get(`/api/v1/students/${st.id}/enrollments`).set(as(couns))).status).toBe(200);
    expect((await request(app).get(`/api/v1/students/${st.id}/enrollments`).set(as(await sessionFor('counselor2')))).status).toBe(404);
    expect((await request(app).get(`/api/v1/students/${st.id}/enrollments`).set(as(await sessionFor('faculty2')))).status).toBe(404);
    const noFees = await request(app).get(`/api/v1/students/${st.id}/enrollments`).set(as(couns));
    expect(noFees.body.items[0].fees).toBeUndefined(); // counselors do not see fee figures
    expect((await request(app).get(`/api/v1/students/${st.id}/enrollments`).set(as(fin))).body.items[0].fees).toBeDefined();
    const su = await makeUser(['student']);
    await prisma.student.update({ where: { id: st.id }, data: { userId: su.id } });
    const own = await request(app).get('/api/v1/portal/enrollments').set(as(await sessionFor(su.username)));
    expect(own.status).toBe(200);
    expect(own.body.items).toHaveLength(1);
    expect(JSON.stringify(own.body)).not.toMatch(/approvalRequestId|createdById/);
  });
});
