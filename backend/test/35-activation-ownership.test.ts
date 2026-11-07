/**
 * Decision 8 — single-use activation links instead of temporary passwords; and record-level (ownership) checks on
 * the remaining high-risk endpoints (API-08, FR-AZ-02, DSH-09).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, as, makeStudent, makeUser, prisma, sessionFor } from './helpers';
import { issueActivationLink } from '../src/lib/activation';

describe('Activation links (decision 8)', () => {
  let adminTok: string;
  beforeAll(async () => {
    adminTok = await sessionFor('office');
  });

  it('new staff accounts have no password; only a redacted activation message is logged', async () => {
    const r = await request(app).post('/api/v1/admin/users').set(as(adminTok)).send({ name: 'New Counselor', email: 'newc@example.invalid', username: 'newcounselor', roles: ['counselor'] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.activationSent).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/password/i);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(u.passwordHash.startsWith('$2')).toBe(false);
    expect(await prisma.passwordReset.count({ where: { userId: u.id, purpose: 'ENROLL', usedAt: null } })).toBe(1);
    await new Promise((res) => setTimeout(res, 200));
    const logs = await prisma.notificationLog.findMany({ where: { templateKey: 'user.welcome', recipient: { in: ['newc@example.invalid'] } } });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => l.body.startsWith('[redacted') && !l.body.includes('token='))).toBe(true);
    expect(await prisma.notification.count({ where: { userId: u.id } })).toBe(0); // never stored in-app
    expect((await request(app).post('/api/v1/auth/login').send({ identifier: 'newcounselor', password: 'anything' })).status).toBe(401);
  });

  it('activation works once, honours the policy, and a re-sent link invalidates the previous one', async () => {
    const u = await makeUser(['counselor']);
    await prisma.user.update({ where: { id: u.id }, data: { passwordHash: '!unusable' } });
    const first = await issueActivationLink(prisma, u.id);
    const second = await issueActivationLink(prisma, u.id); // e.g. "Resend activation"
    expect((await request(app).post('/api/v1/auth/reset-password').send({ token: first.token, newPassword: 'Velvet#Comet-Trail-2026' })).status).toBe(400);
    expect((await request(app).post('/api/v1/auth/reset-password').send({ token: second.token, newPassword: 'short' })).status).toBe(400);
    expect((await request(app).post('/api/v1/auth/reset-password').send({ token: second.token, newPassword: 'Velvet#Comet-Trail-2026' })).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/reset-password').send({ token: second.token, newPassword: 'Quartz#Meadow-Lantern-7' })).status).toBe(400);
    expect((await request(app).post('/api/v1/auth/login').send({ identifier: u.username, password: 'Velvet#Comet-Trail-2026' })).status).toBe(200);
  });

  it('resend-activation: only for never-activated accounts; Admin cannot target privileged accounts', async () => {
    const u = await makeUser(['counselor']);
    expect((await request(app).post(`/api/v1/admin/users/${u.id}/resend-activation`).set(as(adminTok))).status).toBe(400); // already has a password
    await prisma.user.update({ where: { id: u.id }, data: { passwordHash: '!unusable' } });
    expect((await request(app).post(`/api/v1/admin/users/${u.id}/resend-activation`).set(as(adminTok))).status).toBe(200);
    const fin = await makeUser(['finance_manager']);
    await prisma.user.update({ where: { id: fin.id }, data: { passwordHash: '!unusable' } });
    expect((await request(app).post(`/api/v1/admin/users/${fin.id}/resend-activation`).set(as(adminTok))).status).toBe(403);
  });

  it('bulk import sends activation links and returns no passwords', async () => {
    const r = await request(app).post('/api/v1/admin/users/import').set(as(adminTok)).send({ rows: [{ name: 'Imported One', email: 'imp1@example.invalid', username: 'imported1', roles: ['counselor'] }] });
    expect(r.body.results[0].ok).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/password/i);
  });

  it('no template references a password any more', async () => {
    expect(await prisma.notificationTemplate.count({ where: { body: { contains: '{{password}}' } } })).toBe(0);
  });
});

describe('Ownership checks on high-risk endpoints', () => {
  let c1: string, c2: string, fac1: string, fac2: string, acad: string, otherBatchId: string, ownBatchId: string;
  beforeAll(async () => {
    [c1, c2, fac1, fac2, acad] = await Promise.all([sessionFor('counselor1'), sessionFor('counselor2'), sessionFor('faculty1'), sessionFor('faculty2'), sessionFor('acadmgr')]);
    const f1 = await prisma.user.findUniqueOrThrow({ where: { username: 'faculty1' } });
    const own = await prisma.batch.findFirstOrThrow({ where: { code: { startsWith: 'ACC-' } }, orderBy: { startDate: 'asc' } });
    const other = await prisma.batch.findFirstOrThrow({ where: { code: { startsWith: 'FSD-' } }, orderBy: { startDate: 'desc' } });
    ownBatchId = own.id;
    otherBatchId = other.id;
    const subject = await prisma.subject.findFirst({ where: { courseId: own.courseId } }) ?? await prisma.subject.create({ data: { courseId: own.courseId, code: 'GST', name: 'GST basics' } });
    await prisma.facultyAllocation.create({ data: { batchId: own.id, subjectId: subject.id, facultyId: f1.id } });
  });

  it('WhatsApp: counselors cannot message students outside their scope or a whole batch', async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: 'counselor1' } });
    const st = await makeStudent({ ownerId: owner.id });
    expect((await request(app).post(`/api/v1/whatsapp/students/${st.id}/send`).set(as(c2)).send({ content: 'hi' })).status).toBe(404);
    expect((await request(app).post('/api/v1/whatsapp/bulk').set(as(c1)).send({ content: 'hi', batchId: otherBatchId })).status).toBe(404);
    expect((await request(app).get('/api/v1/whatsapp/conversations/999999/messages').set(as(c2))).status).toBe(404);
    expect((await request(app).post('/api/v1/whatsapp/conversations/999999/reply').set(as(c2)).send({ content: 'x' })).status).toBe(404);
  });

  it('Faculty: batch detail, materials, assignments and grading only for own batches', async () => {
    expect((await request(app).get(`/api/v1/academics/batches/${ownBatchId}`).set(as(fac1))).status).toBe(200);
    expect((await request(app).get(`/api/v1/academics/batches/${otherBatchId}`).set(as(fac1))).status).toBe(404);
    const course = (await prisma.batch.findUniqueOrThrow({ where: { id: otherBatchId } })).courseId;
    expect((await request(app).post('/api/v1/academics/materials').set(as(fac1)).send({ courseId: course, batchId: otherBatchId, title: 'Notes', type: 'LINK', url: 'https://example.org/x' })).status).toBe(403);
    const ownCourse = (await prisma.batch.findUniqueOrThrow({ where: { id: ownBatchId } })).courseId;
    const mat = await request(app).post('/api/v1/academics/materials').set(as(fac1)).send({ courseId: ownCourse, batchId: ownBatchId, title: 'Notes', type: 'LINK', url: 'https://example.org/x' });
    expect(mat.status).toBe(201);
    expect((await request(app).delete(`/api/v1/academics/materials/${mat.body.id}`).set(as(fac2))).status).toBe(404); // not theirs
    expect((await request(app).post('/api/v1/academics/assignments').set(as(fac1)).send({ batchId: otherBatchId, title: 'HW', dueAt: new Date(Date.now() + 864e5) })).status).toBe(403);
    const asg = await prisma.assignment.create({ data: { batchId: otherBatchId, title: 'Other HW', dueAt: new Date(), createdById: (await prisma.user.findUniqueOrThrow({ where: { username: 'acadmgr' } })).id } });
    const st = await makeStudent({ batchId: otherBatchId });
    const sub = await prisma.submission.create({ data: { assignmentId: asg.id, studentId: st.id, content: 'answer' } });
    expect((await request(app).get(`/api/v1/academics/assignments/${asg.id}/submissions`).set(as(fac1))).status).toBe(404);
    expect((await request(app).patch(`/api/v1/academics/submissions/${sub.id}`).set(as(fac1)).send({ marks: 100 })).status).toBe(404);
    expect((await request(app).patch(`/api/v1/academics/submissions/${sub.id}`).set(as(acad)).send({ marks: 5 })).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'GRADE', entityId: sub.id } })).toBe(1);
  });

  it('Faculty: course modules only for allocated subjects, completion flag only', async () => {
    const otherModule = await prisma.module.findFirstOrThrow({ where: { subject: { course: { batches: { some: { id: otherBatchId } } } } } });
    expect((await request(app).patch(`/api/v1/academics/modules/${otherModule.id}`).set(as(fac1)).send({ completed: true })).status).toBe(404);
    const f1 = await prisma.user.findUniqueOrThrow({ where: { username: 'faculty1' } });
    const alloc = await prisma.facultyAllocation.findFirstOrThrow({ where: { facultyId: f1.id } });
    const mod = await prisma.module.create({ data: { subjectId: alloc.subjectId, name: 'Own module' } });
    expect((await request(app).patch(`/api/v1/academics/modules/${mod.id}`).set(as(fac1)).send({ completed: true })).status).toBe(200);
    expect((await request(app).patch(`/api/v1/academics/modules/${mod.id}`).set(as(fac1)).send({ isActive: false })).status).toBe(403);
  });

  it('Faculty: result corrections only for exams of own batches', async () => {
    const exOfficer = await prisma.user.findUniqueOrThrow({ where: { username: 'examofficer' } });
    const course = (await prisma.batch.findUniqueOrThrow({ where: { id: otherBatchId } })).courseId;
    const exam = await prisma.exam.create({ data: { code: `EX-T-${Date.now()}`, title: 'Other batch exam', courseId: course, batchId: otherBatchId, startAt: new Date(), endAt: new Date() } });
    const st = await makeStudent({ batchId: otherBatchId });
    const res = await prisma.result.create({ data: { examId: exam.id, studentId: st.id, marks: 10, percentage: 10, grade: 'F', passed: false } });
    expect((await request(app).post(`/api/v1/exams/results/${res.id}/correction`).set(as(fac1)).send({ newMarks: 90, reason: 'Wrong total', evidence: 'Answer sheet' })).status).toBe(404);
    expect(exOfficer).toBeTruthy();
  });
});
