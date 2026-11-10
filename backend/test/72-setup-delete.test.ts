/**
 * Edit / delete of admin setup items (services/setupDelete.ts): deleted only while unused, otherwise 409 IN_USE
 * with the reason and the safe alternative; permission-gated; every delete is audit-logged. Synthetic data only.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, as, makeStudent, makeUser, prisma, sessionFor } from './helpers';

let admin: string, acad: string, exam: string, counselor: string;
let n = 0;
const uid = () => `${Date.now().toString(36)}${++n}`;

beforeAll(async () => {
  [admin, acad, exam, counselor] = await Promise.all(['office', 'acadmgr', 'examofficer', 'counselor1'].map((u) => sessionFor(u)));
});

const del = (path: string, tok: string) => request(app).delete(`/api/v1${path}`).set(as(tok));
const audited = (entity: string, id: string) => prisma.auditLog.count({ where: { action: 'DELETE', entity, entityId: id } });

async function newCourse() {
  const u = uid().toUpperCase();
  const r = await request(app).post('/api/v1/academics/courses').set(as(acad)).send({ code: `D${u}`.slice(0, 20), name: `Delete Test ${u}`, durationMonths: 3, feeComponents: [{ name: 'Tuition', amount: 1000 }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string };
}
async function newSubject(courseId: string) {
  const r = await request(app).post(`/api/v1/academics/courses/${courseId}/subjects`).set(as(acad)).send({ code: `S${uid()}`, name: 'Subject' });
  expect(r.status).toBe(201);
  return r.body as { id: string };
}
async function newBatch(courseId: string) {
  return prisma.batch.create({ data: { code: `B-${uid()}`, name: 'Delete test batch', courseId, startDate: new Date(), capacity: 10, status: 'PLANNED' } });
}

describe('courses, subjects and modules', () => {
  it('an unused course is deleted with its subjects, modules and fee components, and audited', async () => {
    const c = await newCourse();
    const s = await newSubject(c.id);
    await request(app).post(`/api/v1/academics/subjects/${s.id}/modules`).set(as(acad)).send({ name: 'Module 1' }).expect(201);
    const r = await del(`/academics/courses/${c.id}`, acad);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await prisma.course.count({ where: { id: c.id } })).toBe(0);
    expect(await prisma.subject.count({ where: { courseId: c.id } })).toBe(0);
    expect(await prisma.module.count({ where: { subjectId: s.id } })).toBe(0);
    expect(await prisma.feeComponent.count({ where: { courseId: c.id } })).toBe(0);
    expect(await audited('course', c.id)).toBe(1);
  });

  it('a course in use is refused with the reason and the alternative, and nothing changes', async () => {
    const fsd = await prisma.course.findUniqueOrThrow({ where: { code: 'FSD' } });
    const subjects = await prisma.subject.count({ where: { courseId: fsd.id } });
    const r = await del(`/academics/courses/${fsd.id}`, acad);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('IN_USE');
    expect(r.body.error.message).toMatch(/batches/);
    expect(r.body.error.message).toMatch(/inactive/);
    expect(await prisma.course.count({ where: { id: fsd.id } })).toBe(1);
    expect(await prisma.subject.count({ where: { courseId: fsd.id } })).toBe(subjects);
  });

  it('a course whose subject is used (e.g. by a question) is refused', async () => {
    const c = await newCourse();
    const s = await newSubject(c.id);
    await prisma.question.create({ data: { courseId: c.id, subjectId: s.id, type: 'MCQ_SINGLE', text: 'Q?' } });
    const r = await del(`/academics/courses/${c.id}`, acad);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/questions/);
  });

  it('subjects and modules: deleted when unused; a used subject is refused', async () => {
    const c = await newCourse();
    const s1 = await newSubject(c.id);
    const m = await request(app).post(`/api/v1/academics/subjects/${s1.id}/modules`).set(as(acad)).send({ name: 'M' });
    expect((await del(`/academics/modules/${m.body.id}`, acad)).status).toBe(200);
    expect(await audited('module', m.body.id)).toBe(1);
    expect((await del(`/academics/subjects/${s1.id}`, acad)).status).toBe(200);
    const s2 = await newSubject(c.id);
    const b = await newBatch(c.id);
    await prisma.timetableSession.create({ data: { batchId: b.id, subjectId: s2.id, startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000) } });
    const r = await del(`/academics/subjects/${s2.id}`, acad);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/timetable sessions/);
  });
});

describe('batches and timetable sessions', () => {
  it('an unused batch is deleted; a batch with students is refused (use Cancelled/Completed)', async () => {
    const c = await newCourse();
    const b = await newBatch(c.id);
    expect((await del(`/academics/batches/${b.id}`, acad)).status).toBe(200);
    expect(await audited('batch', b.id)).toBe(1);
    const st = await makeStudent({});
    const r = await del(`/academics/batches/${st.batchId}`, acad);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/students/);
    expect(r.body.error.message).toMatch(/Cancelled or Completed/);
  });

  it('a session without attendance is deleted; a session with attendance is refused (cancel instead)', async () => {
    const st = await makeStudent({});
    const s1 = await prisma.timetableSession.create({ data: { batchId: st.batchId!, startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000) } });
    expect((await del(`/academics/timetable/${s1.id}`, acad)).status).toBe(200);
    const s2 = await prisma.timetableSession.create({ data: { batchId: st.batchId!, startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000) } });
    const marker = await prisma.user.findUniqueOrThrow({ where: { username: 'faculty1' } });
    await prisma.attendance.create({ data: { sessionId: s2.id, studentId: st.id, status: 'PRESENT', markedById: marker.id } });
    const r = await del(`/academics/timetable/${s2.id}`, acad);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/attendance/);
    expect(await prisma.timetableSession.count({ where: { id: s2.id } })).toBe(1);
  });
});

describe('question bank and exams', () => {
  it('an unused question is deleted; a question used in an exam is refused (retire instead)', async () => {
    const fsd = await prisma.course.findUniqueOrThrow({ where: { code: 'FSD' } });
    const q1 = await prisma.question.create({ data: { courseId: fsd.id, type: 'MCQ_SINGLE', text: 'Unused?' } });
    expect((await del(`/exams/questions/${q1.id}`, exam)).status).toBe(200);
    expect(await audited('question', q1.id)).toBe(1);
    const q2 = await prisma.question.create({ data: { courseId: fsd.id, type: 'MCQ_SINGLE', text: 'Used?' } });
    const e = await prisma.exam.create({ data: { code: `EX-${uid()}`, title: 'Uses q2', courseId: fsd.id, startAt: new Date(), endAt: new Date(Date.now() + 3600_000) } });
    await prisma.examQuestion.create({ data: { examId: e.id, questionId: q2.id, order: 1 } });
    const r = await del(`/exams/questions/${q2.id}`, exam);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/Retire/);
  });

  it('a draft exam with only a question list is deleted (with that list); an assigned exam is refused', async () => {
    const fsd = await prisma.course.findUniqueOrThrow({ where: { code: 'FSD' } });
    const q = await prisma.question.create({ data: { courseId: fsd.id, type: 'MCQ_SINGLE', text: 'Draft q' } });
    const e1 = await prisma.exam.create({ data: { code: `EX-${uid()}`, title: 'Draft', courseId: fsd.id, startAt: new Date(), endAt: new Date(Date.now() + 3600_000) } });
    await prisma.examQuestion.create({ data: { examId: e1.id, questionId: q.id, order: 1 } });
    expect((await del(`/exams/exams/${e1.id}`, exam)).status).toBe(200);
    expect(await prisma.examQuestion.count({ where: { examId: e1.id } })).toBe(0);
    expect(await audited('exam', e1.id)).toBe(1);
    const st = await makeStudent({});
    const e2 = await prisma.exam.create({ data: { code: `EX-${uid()}`, title: 'Assigned', courseId: fsd.id, startAt: new Date(), endAt: new Date(Date.now() + 3600_000) } });
    await prisma.examAssignment.create({ data: { examId: e2.id, studentId: st.id } });
    const r = await del(`/exams/exams/${e2.id}`, exam);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/assigned students/);
  });
});

describe('departments', () => {
  it('an empty department is deleted; one with users is refused', async () => {
    const d = await prisma.department.create({ data: { name: `Dept ${uid()}` } });
    expect((await del(`/admin/departments/${d.id}`, admin)).status).toBe(200);
    expect(await audited('department', d.id)).toBe(1);
    const used = await prisma.department.create({ data: { name: `Dept ${uid()}` } });
    const u = await makeUser(['faculty']);
    await prisma.user.update({ where: { id: u.id }, data: { departmentId: used.id } });
    const r = await del(`/admin/departments/${used.id}`, admin);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/users/);
  });
});

describe('permissions and not found', () => {
  it('deletes need the same permission as creating the item; unknown ids are 404', async () => {
    const c = await newCourse();
    expect((await del(`/academics/courses/${c.id}`, counselor)).status).toBe(403);
    expect((await del(`/academics/batches/does-not-exist`, acad)).status).toBe(404);
    expect((await request(app).delete(`/api/v1/academics/courses/${c.id}`)).status).toBe(401);
    expect(await prisma.course.count({ where: { id: c.id } })).toBe(1);
  });
});
