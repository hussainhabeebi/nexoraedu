/**
 * R2 (Super Admin takeover), R3 (privilege escalation), R5 (object-level scoping) — SEC-T06…T09, T14…T17.
 * SRS: §9 Rules, 22.2, SEC-02, SEC-03, FR-AZ-02, API-08, FR-DOC-02, SEC-09, DSH-09, RPT-02.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { app, as, makeStudent, makeUser, prisma, sessionFor } from './helpers';
import { config } from '../src/config';

let saA: string, saB: string, adminTok: string, saAId: string, saBId: string;
beforeAll(async () => {
  const a = await makeUser(['super_admin']);
  const b = await makeUser(['super_admin']);
  saAId = a.id;
  saBId = b.id;
  [saA, saB, adminTok] = await Promise.all([sessionFor(a.username), sessionFor(b.username), sessionFor('office')]);
});

describe('R2 Super Administrator accounts', () => {
  it('SEC-T06 an Administrator cannot reset, edit or deactivate a Super Administrator', async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: saAId } });
    const reset = await request(app).post(`/api/v1/admin/users/${saAId}/reset-password`).set(as(adminTok));
    expect(reset.status).toBe(403);
    expect(JSON.stringify(reset.body)).not.toMatch(/temporaryPassword/);
    expect((await request(app).patch(`/api/v1/admin/users/${saAId}`).set(as(adminTok)).send({ email: 'attacker@example.invalid' })).status).toBe(403);
    expect((await request(app).patch(`/api/v1/admin/users/${saAId}`).set(as(adminTok)).send({ username: 'pwned' })).status).toBe(403);
    expect((await request(app).patch(`/api/v1/admin/users/${saAId}`).set(as(adminTok)).send({ isActive: false })).status).toBe(403);
    expect((await request(app).post(`/api/v1/admin/users/${saAId}/mfa/reset`).set(as(adminTok))).status).toBe(403);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: saAId } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.email).toBe(before.email);
    expect(after.isActive).toBe(true);
  });

  it('SEC-T06 resetting a privileged account sends a link instead of revealing a password', async () => {
    const r = await request(app).post(`/api/v1/admin/users/${saBId}/reset-password`).set(as(saA));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, delivery: 'reset-link' });
    // Decision 8: non-privileged accounts also get a single-use link — no password is ever returned or sent.
    const c = await makeUser(['counselor']);
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: c.id } })).passwordHash;
    const r2 = await request(app).post(`/api/v1/admin/users/${c.id}/reset-password`).set(as(adminTok));
    expect(r2.body).toEqual({ ok: true, delivery: 'reset-link' });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: c.id } })).passwordHash).toBe(before);
    expect(await prisma.passwordReset.count({ where: { userId: c.id, purpose: 'RESET', usedAt: null } })).toBe(1);
    expect((await request(app).post(`/api/v1/admin/users/${(await prisma.user.findUniqueOrThrow({ where: { username: 'office' } })).id}/reset-password`).set(as(adminTok))).status).toBe(400); // not on own account
  });

  it('SEC-T07 an email change revokes the user’s sessions and notifies the old address', async () => {
    const c = await makeUser(['counselor']);
    const t = await sessionFor(c.username);
    expect((await request(app).get('/api/v1/crm/leads').set(as(t))).status).toBe(200);
    expect((await request(app).patch(`/api/v1/admin/users/${c.id}`).set(as(adminTok)).send({ email: 'new-address@example.invalid' })).status).toBe(200);
    expect((await request(app).get('/api/v1/crm/leads').set(as(t))).status).toBe(401);
    await new Promise((r) => setTimeout(r, 300)); // notification is sent after commit
    expect(await prisma.notificationLog.count({ where: { templateKey: 'security.email_changed', recipient: c.email } })).toBe(1);
  });
});

describe('R3 privilege escalation', () => {
  it('SEC-T08 an Administrator cannot grant privileged roles, set overrides, or change their own roles', async () => {
    const c = await makeUser(['counselor']);
    for (const role of ['super_admin', 'admin', 'management', 'finance_manager', 'finance_staff']) {
      expect((await request(app).patch(`/api/v1/admin/users/${c.id}`).set(as(adminTok)).send({ roles: ['counselor', role] })).status, role).toBe(403);
    }
    expect((await request(app).post('/api/v1/admin/users').set(as(adminTok)).send({ name: 'New Mgmt', email: 'nm@example.invalid', username: 'newmgmt', roles: ['management'] })).status).toBe(403);
    expect((await request(app).patch(`/api/v1/admin/users/${c.id}`).set(as(adminTok)).send({ extraPermissions: ['finance:manage'] })).status).toBe(403);
    const office = await prisma.user.findUniqueOrThrow({ where: { username: 'office' } });
    expect((await request(app).patch(`/api/v1/admin/users/${office.id}`).set(as(adminTok)).send({ roles: ['admin', 'counselor'] })).status).toBe(403);
    expect((await request(app).patch(`/api/v1/admin/users/${saAId}`).set(as(saA)).send({ roles: ['super_admin', 'finance_manager'] })).status).toBe(403); // SA: not own roles either
    expect((await request(app).patch(`/api/v1/admin/users/${c.id}`).set(as(saA)).send({ extraPermissions: ['*'] })).status).toBe(400);
    expect((await request(app).patch(`/api/v1/admin/users/${c.id}`).set(as(saA)).send({ roles: ['no_such_role'] })).status).toBe(400);
    expect((await request(app).post('/api/v1/admin/users/import').set(as(adminTok)).send({ rows: [{ name: 'Imp', email: 'imp@example.invalid', username: 'impfin', roles: ['finance_manager'] }] })).body.results[0].ok).toBe(false);
    // Non-privileged changes by an Administrator still work.
    expect((await request(app).patch(`/api/v1/admin/users/${c.id}`).set(as(adminTok)).send({ roles: ['counselor', 'faculty'] })).status).toBe(200);
  });

  it('SEC-T08 roles: only catalogue permissions; "*" reserved; Admin cannot edit roles', async () => {
    expect((await request(app).post('/api/v1/admin/roles').set(as(adminTok)).send({ key: 'helpdesk', name: 'Helpdesk', permissions: [] })).status).toBe(403);
    expect((await request(app).post('/api/v1/admin/roles').set(as(saA)).send({ key: 'helpdesk', name: 'Helpdesk', permissions: ['*'] })).status).toBe(400);
    expect((await request(app).post('/api/v1/admin/roles').set(as(saA)).send({ key: 'helpdesk', name: 'Helpdesk', permissions: ['made:up'] })).status).toBe(400);
    const ok = await request(app).post('/api/v1/admin/roles').set(as(saA)).send({ key: 'helpdesk', name: 'Helpdesk' });
    expect(ok.status).toBe(201);
    expect(ok.body.permissions).toEqual([]); // SEC-03 least privilege
  });

  it('SEC-T09 a privileged grant needs approval by a second Super Administrator', async () => {
    const c = await makeUser(['counselor']);
    const r = await request(app).patch(`/api/v1/admin/users/${c.id}`).set(as(saA)).send({ roles: ['counselor', 'management'] });
    expect(r.status).toBe(200);
    expect(r.body.pendingRoles).toEqual(['management']);
    const roles = async () => (await prisma.userRole.findMany({ where: { userId: c.id }, include: { role: true } })).map((x) => x.role.key).sort();
    expect(await roles()).toEqual(['counselor']); // not applied yet
    expect((await request(app).post(`/api/v1/approvals/${r.body.approval.id}/act`).set(as(saA)).send({ action: 'APPROVE' })).status).toBe(403); // own request
    const saBFresh = await sessionFor((await prisma.user.findUniqueOrThrow({ where: { id: saBId } })).username); // earlier reset ended B's sessions
    const ap = await request(app).post(`/api/v1/approvals/${r.body.approval.id}/act`).set(as(saBFresh)).send({ action: 'APPROVE' });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect(await roles()).toEqual(['counselor', 'management']);
    expect(await prisma.auditLog.count({ where: { action: 'GRANT_PRIVILEGED_ROLES', entityId: c.id } })).toBe(1);
  });
});

describe('R5 object-level scoping', () => {
  let c1: string, c2: string, fac: string, studentId: string, docId: string, photoName: string;
  beforeAll(async () => {
    const counselor1 = await prisma.user.findUniqueOrThrow({ where: { username: 'counselor1' } });
    [c1, c2, fac] = await Promise.all([sessionFor('counselor1'), sessionFor('counselor2'), sessionFor('faculty2')]);
    const st = await makeStudent({ ownerId: counselor1.id, batchId: null });
    studentId = st.id;
    const dir = path.resolve(config.uploadDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'scopetest-id.pdf'), '%PDF-1.4 synthetic');
    fs.writeFileSync(path.join(dir, 'scopetest-photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    photoName = 'scopetest-photo.png';
    await prisma.student.update({ where: { id: st.id }, data: { photoUrl: `/api/v1/files/${photoName}` } });
    docId = (await prisma.document.create({ data: { studentId: st.id, type: 'id_proof', fileName: 'id.pdf', storagePath: 'scopetest-id.pdf', mimeType: 'application/pdf', size: 18 } })).id;
  });

  it('SEC-T14 identity documents: Administration staff and Super Admin only (decision 2)', async () => {
    expect((await request(app).get(`/api/v1/documents/${docId}/download`).set(as(adminTok))).status).toBe(200);
    expect((await request(app).get(`/api/v1/documents/${docId}/download`).set(as(saA))).status).toBe(200);
    for (const u of ['counselor1', 'counselor2', 'salesmgr', 'finmgr', 'accounts', 'acadmgr', 'faculty2', 'examofficer', 'director']) {
      expect((await request(app).get(`/api/v1/documents/${docId}/download`).set(as(await sessionFor(u)))).status, u).toBe(403);
    }
    expect(await prisma.auditLog.count({ where: { action: 'DOWNLOAD', entity: 'document', entityId: docId } })).toBe(2);
    const r = await request(app).get(`/api/v1/documents/${docId}/download`).set(as(adminTok));
    expect(r.headers['content-disposition']).toMatch(/^attachment/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('SEC-T15 student records follow scope: own leads (counselor), own batches (faculty)', async () => {
    expect((await request(app).get(`/api/v1/students/${studentId}`).set(as(c1))).status).toBe(200);
    expect((await request(app).get(`/api/v1/students/${studentId}`).set(as(c2))).status).toBe(404);
    expect((await request(app).get(`/api/v1/students/${studentId}`).set(as(fac))).status).toBe(404);
    const list = await request(app).get('/api/v1/students?pageSize=200').set(as(c2));
    expect(list.status).toBe(200);
    expect(list.body.items.map((s: any) => s.id)).not.toContain(studentId);
    const all = await request(app).get('/api/v1/students?pageSize=200').set(as(adminTok));
    expect(all.body.items.map((s: any) => s.id)).toContain(studentId);
  });

  it('SEC-T15 faculty reports and attendance summaries are limited to own batches', async () => {
    const faculty2 = await prisma.user.findUniqueOrThrow({ where: { username: 'faculty2' } });
    const own = await prisma.batch.findFirstOrThrow({ where: { code: { startsWith: 'DM-' } } });
    const other = await prisma.batch.findFirstOrThrow({ where: { code: { startsWith: 'DSA-' } } });
    const subject = await prisma.subject.findFirstOrThrow({ where: { courseId: own.courseId } });
    await prisma.facultyAllocation.create({ data: { batchId: own.id, subjectId: subject.id, facultyId: faculty2.id } });
    expect((await request(app).get(`/api/v1/academics/batches/${own.id}/attendance-summary`).set(as(fac))).status).toBe(200);
    expect((await request(app).get(`/api/v1/academics/batches/${other.id}/attendance-summary`).set(as(fac))).status).toBe(404);
    const rep = await request(app).get('/api/v1/dashboard/reports/attendance?from=2000-01-01').set(as(fac));
    expect(rep.status).toBe(200);
    expect(rep.body.rows.every((r: any) => r.Batch === own.code)).toBe(true);
  });

  it('SEC-T16 uploads whose content does not match the declared type are rejected and deleted', async () => {
    const dir = path.resolve(config.uploadDir);
    const before = fs.readdirSync(dir).length;
    const r = await request(app).post(`/api/v1/students/${studentId}/documents`).set(as(adminTok)).field('type', 'id_proof')
      .attach('file', Buffer.from('MZ\x90\x00 this is not a pdf'), { filename: 'id.pdf', contentType: 'application/pdf' });
    expect(r.status).toBe(400);
    expect(fs.readdirSync(dir).length).toBe(before);
    const ok = await request(app).post(`/api/v1/students/${studentId}/documents`).set(as(adminTok)).field('type', 'id_proof')
      .attach('file', Buffer.from('%PDF-1.7 synthetic'), { filename: 'id.pdf', contentType: 'application/pdf' });
    expect(ok.status).toBe(201);
  });

  it('SEC-T17 photos need sign-in and scope; answer keys hidden from non-exam-managers', async () => {
    expect((await request(app).get(`/api/v1/files/${photoName}`)).status).toBe(401);
    expect((await request(app).get(`/api/v1/files/${photoName}`).set(as(c2))).status).toBe(404);
    expect((await request(app).get(`/api/v1/files/${photoName}`).set(as(c1))).status).toBe(200);
    expect((await request(app).get('/api/v1/files/scopetest-id.pdf').set(as(adminTok))).status).toBe(404); // documents never via /files
    const exOff = await sessionFor('examofficer');
    const courseId = (await prisma.course.findFirstOrThrow({ where: { code: 'FSD' } })).id;
    await request(app).post('/api/v1/exams/questions').set(as(exOff)).send({ courseId, type: 'MCQ_SINGLE', text: 'Scope test?', options: ['a', 'b'], correct: 'a', marks: 1 });
    const qf = await request(app).get('/api/v1/exams/questions').set(as(fac));
    expect(qf.status).toBe(200);
    expect(qf.body.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(qf.body)).not.toContain('"correct"');
    expect(JSON.stringify((await request(app).get('/api/v1/exams/questions').set(as(exOff))).body)).toContain('"correct"');
  });

  it('counselors can only act on applications of their own leads', async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { username: 'counselor1' } });
    const course = await prisma.course.findFirstOrThrow({ where: { code: 'FSD' } });
    const lead = await prisma.lead.create({ data: { code: `LD-APP-${Date.now()}`, name: 'App Scope', phone: '+917000000999', phoneNormalized: '+917000000999', ownerId: owner.id } });
    const appRow = await prisma.application.create({ data: { code: `APP-T-${Date.now()}`, leadId: lead.id, courseId: course.id, data: {}, status: 'UNDER_REVIEW' } });
    expect((await request(app).patch(`/api/v1/crm/applications/${appRow.id}`).set(as(c2)).send({ remarks: 'x' })).status).toBe(404);
    expect((await request(app).post(`/api/v1/crm/applications/${appRow.id}/admit`).set(as(c2)).send({})).status).toBe(404);
    expect((await request(app).patch(`/api/v1/crm/applications/${appRow.id}`).set(as(c1)).send({ remarks: 'ok' })).status).toBe(200);
  });
});
