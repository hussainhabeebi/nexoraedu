/** Student management (SRS §10). */
import { Router, type Request } from 'express';
import path from 'path';
import { z } from 'zod';
import type { Prisma, StudentStatus } from '#prisma';
import { prisma } from '../lib/prisma';
import { ah, badRequest, conflict, forbidden, notFound, paging } from '../lib/http';
import { bumpAuthVersion, can, revokeUserSessions, userCan } from '../lib/auth';
import { canAccessDocument, studentScope } from '../lib/policy';
import { audit } from '../lib/audit';
import { nextNumber } from '../lib/sequence';
import { getSettings } from '../lib/settings';
import { normalizeEmail, normalizePhone, toCsv } from '../lib/util';
import { upload, storedName, verifyUploads } from '../lib/upload';
import { getFile } from '../lib/files';
import { Readable } from 'node:stream';
import { applicationDataSchema, admitApplication, assertBatchAvailable, assertNoDuplicateStudent, guardianSchema, educationSchema, validateApplicationData } from '../services/admissions';
import { createApproval } from '../services/approvals';
import { studentBalance } from '../services/finance';
import { studentAttendancePct } from './academics';
import { cancelEnrollment, syncEnrollmentWithStudentStatus } from '../services/enrollments';
import { atomic, type Tx } from '../lib/db';
import { UNUSABLE_PASSWORD } from '../lib/password';
import { issueActivationLink } from '../lib/activation';
import { notifyLater } from '../services/notify';

const r = Router();

/** FR-AZ-02 / API-08: all, own batches (faculty) or own converted leads (counselor) — see lib/policy.ts. */
async function scope(req: Request): Promise<Prisma.StudentWhereInput> {
  const s = await studentScope(req.user!);
  if (!s) throw forbidden();
  return s;
}
const READ = ['students:read', 'students:read_batch', 'students:read_own'];

r.get('/', can(...READ), ah(async (req, res) => {
  const { skip, take, page, pageSize } = paging(req.query);
  const q = String(req.query.q || '').trim();
  const where: Prisma.StudentWhereInput = {
    AND: [await scope(req)],
    ...(req.query.status && { status: { in: String(req.query.status).split(',') as StudentStatus[] } }),
    ...(req.query.courseId && { courseId: String(req.query.courseId) }),
    ...(req.query.batchId && { batchId: String(req.query.batchId) }),
    ...((req.query.from || req.query.to) && { admissionDate: { gte: req.query.from ? new Date(String(req.query.from)) : undefined, lte: req.query.to ? new Date(String(req.query.to)) : undefined } }),
    ...(q && {
      OR: [
        { fullName: { contains: q } },
        { studentCode: { contains: q } },
        { email: { contains: q } },
        { phoneNormalized: { contains: q.replace(/\D/g, '') || q } },
      ],
    }),
  };
  const include = { course: { select: { id: true, name: true, code: true } }, batch: { select: { id: true, code: true, name: true } } };
  if (req.query.format === 'csv') {
    const all = await prisma.student.findMany({ where, include, orderBy: { studentCode: 'asc' }, take: 10000 });
    await audit(prisma, req, 'EXPORT', 'student', null, null, { format: 'csv', rows: all.length, filters: req.query }); // RPT-08
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="students.csv"');
    return res.send(toCsv(all.map((s) => ({ id: s.studentCode, name: s.fullName, phone: s.phone, email: s.email, course: s.course.name, batch: s.batch?.code, status: s.status, admitted: s.admissionDate }))));
  }
  const sort = String(req.query.sort || 'createdAt');
  const orderBy = ['createdAt', 'fullName', 'studentCode', 'admissionDate', 'status'].includes(sort) ? { [sort]: req.query.dir === 'asc' ? 'asc' : 'desc' } : { createdAt: 'desc' as const };
  let [items, total] = await Promise.all([prisma.student.findMany({ where, include, skip, take, orderBy }), prisma.student.count({ where })]);
  // FR STU-16 fee status filter (computed)
  const balances = await prisma.ledgerEntry.groupBy({ by: ['studentId'], where: { studentId: { in: items.map((i) => i.id) } }, _sum: { debit: true, credit: true } });
  const bal = Object.fromEntries(balances.map((b) => [b.studentId, Number(b._sum.debit ?? 0) - Number(b._sum.credit ?? 0)]));
  let out = items.map((s) => ({ ...s, balance: Math.round((bal[s.id] ?? 0) * 100) / 100 }));
  if (req.query.feeStatus === 'due') out = out.filter((s) => s.balance > 0);
  if (req.query.feeStatus === 'clear') out = out.filter((s) => s.balance <= 0);
  res.json({ items: out, total, page, pageSize });
}));

/** STU-01 direct registration (staff). Goes through the same admission path so fee plan & portal login are created. */
r.post('/', can('students:manage'), ah(async (req, res) => {
  const body = z.object({ data: applicationDataSchema, installments: z.number().int().min(1).max(24).optional() }).parse(req.body);
  const data = body.data;
  validateApplicationData(data);
  if (!data.preferences.batchId) throw badRequest('Batch is mandatory.');
  const s = await getSettings();
  const studentId = await atomic(async (tx) => {
    await assertNoDuplicateStudent(tx, data.personal.phone, data.personal.email);
    await assertBatchAvailable(tx, data.preferences.batchId!, data.preferences.courseId);
    const code = await nextNumber('application:{year}', s.ids.application, tx);
    const app = await tx.application.create({ data: { code, courseId: data.preferences.courseId, batchId: data.preferences.batchId, data: data as any, status: 'APPROVED', source: 'direct' } });
    const id = await admitApplication(tx, app.id, { batchId: data.preferences.batchId, installments: body.installments }, req.user!.id);
    await audit(tx, req, 'CREATE', 'student', id, null, data.personal);
    return id;
  });
  res.status(201).json({ id: studentId });
}));

/** STU-03 similar-name warning (same DOB). */
r.post('/check-duplicate', can('students:manage', 'leads:update'), ah(async (req, res) => {
  const { phone, email, fullName, dob } = z.object({ phone: z.string().optional(), email: z.string().optional(), fullName: z.string().optional(), dob: z.coerce.date().optional() }).parse(req.body);
  const exact = await prisma.student.findFirst({ where: { OR: [...(phone ? [{ phoneNormalized: normalizePhone(phone) }] : []), ...(email ? [{ emailNormalized: normalizeEmail(email)! }] : [])] }, select: { studentCode: true, fullName: true } });
  const similar = fullName && dob ? await prisma.student.findMany({ where: { dob, fullName: { contains: fullName.split(' ')[0] } }, select: { studentCode: true, fullName: true }, take: 5 }) : [];
  res.json({ duplicate: exact, similar });
}));

r.get('/:id', can(...READ), ah(async (req, res) => {
  const s = await prisma.student.findFirst({
    where: { AND: [{ id: req.params.id }, await scope(req)] },
    include: {
      course: true,
      batch: true,
      guardians: true,
      education: true,
      documents: { orderBy: { createdAt: 'desc' } },
      lead: { select: { id: true, code: true, source: true, ownerId: true, chatwootConversationId: true } },
      history: { orderBy: { createdAt: 'desc' }, take: 100 },
      results: { include: { exam: { select: { title: true, type: true, resultsPublished: true } } }, orderBy: { createdAt: 'desc' } },
      certificates: true,
      user: { select: { id: true, isActive: true, lastLoginAt: true } },
    },
  });
  if (!s) throw notFound('Student not found');
  const canFin = userCan(req, 'finance:read') || userCan(req, 'students:manage') || userCan(req, 'students:read');
  const [attendance, balance, plans, payments, docTypes] = await Promise.all([
    studentAttendancePct(s.id),
    canFin ? studentBalance(s.id) : null,
    canFin ? prisma.feePlan.findMany({ where: { studentId: s.id }, include: { installments: { orderBy: { seq: 'asc' } } } }) : [],
    canFin ? prisma.payment.findMany({ where: { studentId: s.id }, orderBy: { paidAt: 'desc' } }) : [],
    prisma.masterItem.findMany({ where: { type: 'document_type', isActive: true } }),
  ]);
  // STU-12: flag missing mandatory documents
  const mandatory = docTypes.filter((d) => (d.meta as any)?.mandatory);
  const missingDocuments = mandatory.filter((m) => !s.documents.some((d) => d.type === m.code && d.status !== 'REJECTED')).map((m) => m.label);
  res.json({ ...s, attendance, balance, feePlans: plans, payments, missingDocuments });
}));

const updateSchema = z.object({
  fullName: z.string().min(2).optional(),
  dob: z.coerce.date().optional(),
  gender: z.enum(['Male', 'Female', 'Other']).optional(),
  phone: z.string().min(7).optional(),
  email: z.string().email().optional(),
  address: z.string().min(5).optional(),
  city: z.string().optional().nullable(),
});
r.patch('/:id', can('students:manage'), ah(async (req, res) => {
  const d = updateSchema.parse(req.body);
  const before = await prisma.student.findUniqueOrThrow({ where: { id: req.params.id } });
  if (d.phone || d.email) await assertNoDuplicateStudent(prisma, d.phone ?? before.phone, d.email ?? before.email, before.id);
  const s = await atomic(async (tx) => {
    const s = await tx.student.update({ where: { id: before.id }, data: { ...d, ...(d.phone && { phoneNormalized: normalizePhone(d.phone) }), ...(d.email && { emailNormalized: normalizeEmail(d.email)! }) } });
    await tx.studentHistory.create({ data: { studentId: s.id, type: 'PROFILE', message: `Profile updated: ${Object.keys(d).join(', ')}`, userId: req.user!.id } });
    await audit(tx, req, 'UPDATE', 'student', s.id, before, d);
    return s;
  });
  res.json(s);
}));

// STU-13 status with reason
r.post('/:id/status', can('students:manage', 'academics:manage'), ah(async (req, res) => {
  const { status, reason } = z.object({ status: z.enum(['APPLIED', 'ADMITTED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'WITHDRAWN', 'TERMINATED']), reason: z.string().min(3) }).parse(req.body);
  const s = await prisma.student.findUniqueOrThrow({ where: { id: req.params.id } });
  let note: string | null = null;
  await atomic(async (tx) => {
    // Enrollment history stays in step with the student status (E5); a re-activation opens a new enrollment.
    note = await syncEnrollmentWithStudentStatus(tx, s.id, s.status, status, reason, req.user!.id);
    await tx.student.update({ where: { id: s.id }, data: { status } });
    await tx.studentHistory.create({ data: { studentId: s.id, type: 'STATUS', message: `${s.status} → ${status}: ${reason}${note ? ` ${note}` : ''}`, userId: req.user!.id } });
    if (['WITHDRAWN', 'TERMINATED'].includes(status) && s.userId) {
      await tx.user.update({ where: { id: s.userId }, data: { isActive: false, authVersion: { increment: 1 } } });
      await tx.session.updateMany({ where: { userId: s.userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'STUDENT_' + status } });
    }
    await audit(tx, req, 'STATUS', 'student', s.id, { status: s.status }, { status, reason });
  });
  res.json({ ok: true, note });
}));

// ── Enrollment history (20.4, STU-10) ──
r.get('/:id/enrollments', can(...READ), ah(async (req, res) => {
  const st = await prisma.student.findFirst({ where: { AND: [{ id: req.params.id }, await scope(req)] }, select: { id: true } });
  if (!st) throw notFound('Student not found');
  const showFees = userCan(req, 'finance:read') || userCan(req, 'students:manage');
  const items = await prisma.enrollment.findMany({
    where: { studentId: st.id },
    orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
    include: {
      course: { select: { id: true, code: true, name: true } },
      batch: { select: { id: true, code: true, name: true, status: true } },
      application: { select: { id: true, code: true } },
      _count: { select: { attendance: true } },
      ...(showFees && { feePlans: { select: { id: true, grossAmount: true, discount: true, installments: { select: { amount: true, paidAmount: true } } } } }),
    },
  });
  res.json({
    items: items.map(({ feePlans, ...e }: any) => ({
      ...e,
      current: e.status === 'ACTIVE' || e.status === 'ON_HOLD',
      ...(showFees && { fees: (feePlans ?? []).map((f: any) => ({ id: f.id, gross: Number(f.grossAmount), discount: Number(f.discount), outstanding: Math.round(f.installments.reduce((t: number, i: any) => t + Number(i.amount) - Number(i.paidAmount), 0) * 100) / 100 })) }),
    })),
  });
}));

// E6: cancel an enrollment recorded in error / abandoned before any study or payment (Admin, reason required).
r.post('/:id/enrollments/:eid/cancel', can('students:manage'), ah(async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(5).max(500) }).parse(req.body);
  const s = await prisma.student.findUniqueOrThrow({ where: { id: req.params.id } });
  const out = await atomic(async (tx) => {
    const out = await cancelEnrollment(tx, { studentId: s.id, enrollmentId: req.params.eid, reason, actorId: req.user!.id });
    // No remaining current enrollment → the student is withdrawn (STU-13 has no "cancelled" student status).
    if (['ADMITTED', 'ACTIVE', 'ON_HOLD', 'APPLIED'].includes(s.status)) {
      await tx.student.update({ where: { id: s.id }, data: { status: 'WITHDRAWN' } });
      if (s.userId) {
        await tx.user.update({ where: { id: s.userId }, data: { isActive: false, authVersion: { increment: 1 } } });
        await tx.session.updateMany({ where: { userId: s.userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'ENROLLMENT_CANCELLED' } });
      }
    }
    await tx.studentHistory.create({ data: { studentId: s.id, type: 'STATUS', message: `Enrollment cancelled: ${reason}${out.openFeePlanInstallments ? ` — ${out.openFeePlanInstallments} unpaid installment(s) remain; a fee adjustment needs Finance approval (22.6).` : ''}`, userId: req.user!.id } });
    await audit(tx, req, 'CANCEL_ENROLLMENT', 'student', s.id, { status: s.status }, { enrollmentId: req.params.eid, reason });
    return out;
  });
  res.json({ ok: true, enrollment: out.enrollment, unpaidInstallments: out.openFeePlanInstallments });
}));

// STU-10 batch transfer / course change via approval
r.post('/:id/transfer', can('students:manage', 'academics:manage'), ah(async (req, res) => {
  const { toBatchId, reason } = z.object({ toBatchId: z.string(), reason: z.string().min(3) }).parse(req.body);
  const s = await prisma.student.findUniqueOrThrow({ where: { id: req.params.id } });
  const to = await prisma.batch.findUniqueOrThrow({ where: { id: toBatchId } });
  const cur = await prisma.enrollment.findFirst({ where: { studentId: s.id, status: { in: ['ACTIVE', 'ON_HOLD'] } } });
  if (!cur) throw badRequest('The student has no current enrollment. Re-activate the student before a transfer.');
  if (cur.batchId === toBatchId) throw badRequest('The student is already enrolled in this batch.');
  await assertBatchAvailable(prisma, toBatchId, to.courseId);
  const a = await atomic(async (tx) => {
    const a = await createApproval(tx, { type: 'BATCH_TRANSFER', entityType: 'student', entityId: s.id, title: `Batch transfer: ${s.fullName} → ${to.code}`, payload: { toBatchId, reason }, requestedById: req.user!.id });
    await audit(tx, req, 'REQUEST_TRANSFER', 'student', s.id, { batchId: s.batchId }, { toBatchId, reason, approvalId: a.id });
    return a;
  });
  res.json({ approval: a });
}));

// Guardians / education
r.post('/:id/guardians', can('students:manage'), ah(async (req, res) => {
  const d = guardianSchema.parse(req.body);
  const g = await atomic(async (tx) => {
    const g = await tx.guardian.create({ data: { ...d, email: d.email || null, studentId: req.params.id } });
    await audit(tx, req, 'CREATE', 'guardian', g.id, null, { studentId: req.params.id, ...d });
    return g;
  });
  res.status(201).json(g);
}));
r.delete('/:id/guardians/:gid', can('students:manage'), ah(async (req, res) => {
  await atomic(async (tx) => {
    const g = await tx.guardian.findFirst({ where: { id: req.params.gid, studentId: req.params.id } });
    if (!g) throw notFound('Guardian not found');
    await tx.guardian.delete({ where: { id: g.id } });
    await audit(tx, req, 'DELETE', 'guardian', g.id, g, null);
    if (g.userId) await closeParentAccountIfUnlinked(tx, req, g.userId, g.id);
  });
  res.json({ ok: true });
}));

// ── Parent / guardian portal accounts (fees and receipts of linked children only) ──

/** A parent account whose last guardian link is removed is deactivated and signed out. */
async function closeParentAccountIfUnlinked(tx: Tx, req: Request, userId: string, removedGuardianId: string) {
  const left = await tx.guardian.count({ where: { userId, id: { not: removedGuardianId } } });
  if (left > 0) return;
  await tx.user.update({ where: { id: userId }, data: { isActive: false } });
  await revokeUserSessions(tx, userId, 'PARENT_UNLINKED');
  await bumpAuthVersion(tx, userId);
  await audit(tx, req, 'DEACTIVATE', 'user', userId, { isActive: true }, { isActive: false, reason: 'No linked children' });
}

// Create (or link an existing parent account to) a guardian. Needs the guardian's email; an activation link is sent.
r.post('/:id/guardians/:gid/parent-account', can('students:manage'), ah(async (req, res) => {
  const g = await prisma.guardian.findFirst({ where: { id: req.params.gid, studentId: req.params.id }, include: { student: { select: { fullName: true } } } });
  if (!g) throw notFound('Guardian not found');
  if (g.userId) throw badRequest('This guardian already has a parent portal account.');
  const email = normalizeEmail(g.email);
  if (!email) throw badRequest("Add the guardian's email address first; it is the parent's sign-in.");
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'parent' } });
  const existing = await prisma.user.findFirst({ where: { email }, include: { roles: { include: { role: true } } } });
  if (existing && !(existing.roles.length === 1 && existing.roles[0].role.key === 'parent')) {
    throw conflict('This email already belongs to another account. Use a different email for the parent portal.');
  }
  let username = `p${(normalizePhone(g.phone) ?? g.phone).replace(/\D/g, '').slice(-10)}`;
  if (!existing) {
    for (let n = 2; await prisma.user.count({ where: { username } }); n++) username = `${username.replace(/-\d+$/, '')}-${n}`;
  }
  const out = await atomic(async (tx) => {
    const u = existing ?? (await tx.user.create({ data: { name: g.name, email, username, phone: g.phone, passwordHash: UNUSABLE_PASSWORD, mustChangePassword: false, roles: { create: [{ roleId: role.id }] } } }));
    if (existing && !existing.isActive) await tx.user.update({ where: { id: existing.id }, data: { isActive: true } });
    const linked = await tx.guardian.updateMany({ where: { id: g.id, userId: null }, data: { userId: u.id } });
    if (linked.count !== 1) throw badRequest('This guardian already has a parent portal account.');
    const act = existing?.passwordHash.startsWith('$2') ? null : await issueActivationLink(tx, u.id);
    await audit(tx, req, existing ? 'LINK_PARENT' : 'CREATE_PARENT', 'guardian', g.id, null, { userId: u.id, studentId: g.studentId, newAccount: !existing });
    return { u, act };
  });
  if (out.act) notifyLater('parent.welcome', { userId: out.u.id, name: out.u.name, email: out.u.email, phone: out.u.phone }, { name: out.u.name, username: out.u.username, student: g.student.fullName, link: out.act.link, hours: out.act.hours }, { channels: ['EMAIL', 'WHATSAPP'], sensitive: true });
  res.status(existing ? 200 : 201).json({ userId: out.u.id, username: out.u.username, linkedExisting: !!existing, activationSent: !!out.act, activationHours: out.act?.hours });
}));

// Remove a guardian's portal access to this student (the account is deactivated when no children remain).
r.delete('/:id/guardians/:gid/parent-account', can('students:manage'), ah(async (req, res) => {
  await atomic(async (tx) => {
    const g = await tx.guardian.findFirst({ where: { id: req.params.gid, studentId: req.params.id } });
    if (!g) throw notFound('Guardian not found');
    if (!g.userId) throw badRequest('This guardian has no parent portal account.');
    await tx.guardian.update({ where: { id: g.id }, data: { userId: null } });
    await audit(tx, req, 'UNLINK_PARENT', 'guardian', g.id, { userId: g.userId }, { userId: null });
    await closeParentAccountIfUnlinked(tx, req, g.userId, g.id);
  });
  res.json({ ok: true });
}));
r.post('/:id/education', can('students:manage'), ah(async (req, res) => {
  const d = educationSchema.parse(req.body);
  const e = await atomic(async (tx) => {
    const e = await tx.education.create({ data: { ...d, studentId: req.params.id } });
    await audit(tx, req, 'CREATE', 'education', e.id, null, { studentId: req.params.id, ...d });
    return e;
  });
  res.status(201).json(e);
}));
r.delete('/:id/education/:eid', can('students:manage'), ah(async (req, res) => {
  await atomic(async (tx) => {
    const e = await tx.education.findFirst({ where: { id: req.params.eid, studentId: req.params.id } });
    if (!e) throw notFound('Record not found');
    await tx.education.delete({ where: { id: e.id } });
    await audit(tx, req, 'DELETE', 'education', e.id, e, null);
  });
  res.json({ ok: true });
}));

// STU-05 photo / STU-11 documents
r.post('/:id/photo', can('students:manage'), upload.single('file'), verifyUploads, ah(async (req, res) => {
  if (!req.file || !req.file.mimetype.startsWith('image/')) throw badRequest('Please upload a JPG or PNG image.');
  const file = req.file;
  const s = await atomic(async (tx) => {
    const before = await tx.student.findUniqueOrThrow({ where: { id: req.params.id }, select: { photoUrl: true } });
    const s = await tx.student.update({ where: { id: req.params.id }, data: { photoUrl: `/api/v1/files/${file.filename}` } });
    await audit(tx, req, 'UPDATE_PHOTO', 'student', s.id, before, { photoUrl: s.photoUrl });
    return s;
  });
  res.json({ photoUrl: s.photoUrl });
}));
r.post('/:id/documents', can('students:manage'), upload.single('file'), verifyUploads, ah(async (req, res) => {
  const { type } = z.object({ type: z.string().min(1) }).parse(req.body);
  if (!req.file) throw badRequest('Please choose a file to upload.');
  const file = req.file;
  const doc = await atomic(async (tx) => {
    const doc = await tx.document.create({ data: { studentId: req.params.id, type, fileName: file.originalname, storagePath: file.filename, mimeType: file.mimetype, size: file.size } });
    await tx.studentHistory.create({ data: { studentId: req.params.id, type: 'DOCUMENT', message: `Document uploaded: ${type}`, userId: req.user!.id } });
    await audit(tx, req, 'UPLOAD', 'document', doc.id, null, { studentId: req.params.id, type, size: file.size, mimeType: file.mimetype });
    return doc;
  });
  res.status(201).json(doc);
}));

export const documentsRouter = Router();
documentsRouter.get('/pending', can('documents:verify'), ah(async (_req, res) => {
  res.json({ items: await prisma.document.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 200, include: { student: { select: { id: true, fullName: true, studentCode: true } }, application: { select: { id: true, code: true } } } }) });
}));
documentsRouter.post('/:id/verify', can('documents:verify'), ah(async (req, res) => {
  const { status, remarks } = z.object({ status: z.enum(['VERIFIED', 'REJECTED']), remarks: z.string().optional() }).parse(req.body);
  if (status === 'REJECTED' && !remarks) throw badRequest('Please give a reason for rejection.');
  const d = await atomic(async (tx) => {
    const before = await tx.document.findUniqueOrThrow({ where: { id: req.params.id }, select: { status: true, remarks: true } });
    const d = await tx.document.update({ where: { id: req.params.id }, data: { status, remarks, verifiedById: req.user!.id, verifiedAt: new Date() } });
    if (d.studentId) await tx.studentHistory.create({ data: { studentId: d.studentId, type: 'DOCUMENT', message: `Document ${d.type} ${status.toLowerCase()}${remarks ? `: ${remarks}` : ''}`, userId: req.user!.id } });
    await audit(tx, req, 'VERIFY', 'document', d.id, before, { status, remarks });
    return d;
  });
  res.json(d);
}));
documentsRouter.get('/:id/download', can('documents:verify', 'students:manage'), ah(async (req, res) => {
  const d = await prisma.document.findUnique({ where: { id: req.params.id } });
  // S6 / FR-DOC-02: object-level check; out-of-scope documents look identical to missing ones.
  if (!d || !(await canAccessDocument(req.user!, d))) throw notFound('Document not found');
  const obj = await getFile(storedName(d.storagePath));
  if (!obj) throw notFound('File missing from storage');
  await audit(prisma, req, 'DOWNLOAD', 'document', d.id, null, { studentId: d.studentId, applicationId: d.applicationId, type: d.type });
  const safeName = d.fileName.replace(/[^\w.\- ]/g, '_');
  res.setHeader('Content-Type', d.mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `${d.mimeType.startsWith('image/') ? 'inline' : 'attachment'}; filename="${safeName}"`);
  res.setHeader('Content-Length', String(obj.size));
  Readable.fromWeb(obj.body as any).pipe(res);
}));

export default r;
