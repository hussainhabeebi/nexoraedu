/** Student management (SRS §10). */
import { Router, type Request } from 'express';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import type { Prisma, StudentStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { ah, badRequest, forbidden, notFound, paging } from '../lib/http';
import { can, userCan } from '../lib/auth';
import { audit } from '../lib/audit';
import { nextNumber } from '../lib/sequence';
import { getSettings } from '../lib/settings';
import { normalizeEmail, normalizePhone, toCsv } from '../lib/util';
import { upload, storedPath } from '../lib/upload';
import { applicationDataSchema, admitApplication, assertBatchAvailable, assertNoDuplicateStudent, guardianSchema, educationSchema, validateApplicationData } from '../services/admissions';
import { createApproval } from '../services/approvals';
import { studentBalance } from '../services/finance';
import { facultyBatchIds, studentAttendancePct } from './academics';

const r = Router();

/** FR-AZ-02: faculty only see students of their batches. */
async function scope(req: Request): Promise<Prisma.StudentWhereInput> {
  if (userCan(req, 'students:read')) return {};
  if (userCan(req, 'students:read_batch')) return { batchId: { in: await facultyBatchIds(req.user!.id) } };
  throw forbidden();
}

r.get('/', can('students:read', 'students:read_batch'), ah(async (req, res) => {
  const { skip, take, page, pageSize } = paging(req.query);
  const q = String(req.query.q || '').trim();
  const where: Prisma.StudentWhereInput = {
    ...(await scope(req)),
    ...(req.query.status && { status: { in: String(req.query.status).split(',') as StudentStatus[] } }),
    ...(req.query.courseId && { courseId: String(req.query.courseId) }),
    ...(req.query.batchId && { batchId: String(req.query.batchId) }),
    ...((req.query.from || req.query.to) && { admissionDate: { gte: req.query.from ? new Date(String(req.query.from)) : undefined, lte: req.query.to ? new Date(String(req.query.to)) : undefined } }),
    ...(q && {
      OR: [
        { fullName: { contains: q, mode: 'insensitive' } },
        { studentCode: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phoneNormalized: { contains: q.replace(/\D/g, '') || q } },
      ],
    }),
  };
  const include = { course: { select: { id: true, name: true, code: true } }, batch: { select: { id: true, code: true, name: true } } };
  if (req.query.format === 'csv') {
    const all = await prisma.student.findMany({ where, include, orderBy: { studentCode: 'asc' }, take: 10000 });
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
  const studentId = await prisma.$transaction(async (tx) => {
    await assertNoDuplicateStudent(tx, data.personal.phone, data.personal.email);
    await assertBatchAvailable(tx, data.preferences.batchId!, data.preferences.courseId);
    const code = await nextNumber(`application:${new Date().getFullYear()}`, s.ids.application, tx);
    const app = await tx.application.create({ data: { code, courseId: data.preferences.courseId, batchId: data.preferences.batchId, data: data as any, status: 'APPROVED', source: 'direct' } });
    return admitApplication(tx, app.id, { batchId: data.preferences.batchId, installments: body.installments }, req.user!.id);
  });
  await audit(req, 'CREATE', 'student', studentId, null, data.personal);
  res.status(201).json({ id: studentId });
}));

/** STU-03 similar-name warning (same DOB). */
r.post('/check-duplicate', can('students:manage', 'leads:update'), ah(async (req, res) => {
  const { phone, email, fullName, dob } = z.object({ phone: z.string().optional(), email: z.string().optional(), fullName: z.string().optional(), dob: z.coerce.date().optional() }).parse(req.body);
  const exact = await prisma.student.findFirst({ where: { OR: [...(phone ? [{ phoneNormalized: normalizePhone(phone) }] : []), ...(email ? [{ emailNormalized: normalizeEmail(email)! }] : [])] }, select: { studentCode: true, fullName: true } });
  const similar = fullName && dob ? await prisma.student.findMany({ where: { dob, fullName: { contains: fullName.split(' ')[0], mode: 'insensitive' } }, select: { studentCode: true, fullName: true }, take: 5 }) : [];
  res.json({ duplicate: exact, similar });
}));

r.get('/:id', can('students:read', 'students:read_batch'), ah(async (req, res) => {
  const s = await prisma.student.findFirst({
    where: { id: req.params.id, ...(await scope(req)) },
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
  const s = await prisma.$transaction(async (tx) => {
    const s = await tx.student.update({ where: { id: before.id }, data: { ...d, ...(d.phone && { phoneNormalized: normalizePhone(d.phone) }), ...(d.email && { emailNormalized: normalizeEmail(d.email)! }) } });
    await tx.studentHistory.create({ data: { studentId: s.id, type: 'PROFILE', message: `Profile updated: ${Object.keys(d).join(', ')}`, userId: req.user!.id } });
    return s;
  });
  await audit(req, 'UPDATE', 'student', s.id, before, d);
  res.json(s);
}));

// STU-13 status with reason
r.post('/:id/status', can('students:manage', 'academics:manage'), ah(async (req, res) => {
  const { status, reason } = z.object({ status: z.enum(['APPLIED', 'ADMITTED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'WITHDRAWN', 'TERMINATED']), reason: z.string().min(3) }).parse(req.body);
  const s = await prisma.student.findUniqueOrThrow({ where: { id: req.params.id } });
  await prisma.$transaction([
    prisma.student.update({ where: { id: s.id }, data: { status } }),
    prisma.studentHistory.create({ data: { studentId: s.id, type: 'STATUS', message: `${s.status} → ${status}: ${reason}`, userId: req.user!.id } }),
    ...(['WITHDRAWN', 'TERMINATED'].includes(status) && s.userId ? [prisma.user.update({ where: { id: s.userId }, data: { isActive: false } })] : []),
  ]);
  await audit(req, 'STATUS', 'student', s.id, { status: s.status }, { status, reason });
  res.json({ ok: true });
}));

// STU-10 batch transfer / course change via approval
r.post('/:id/transfer', can('students:manage', 'academics:manage'), ah(async (req, res) => {
  const { toBatchId, reason } = z.object({ toBatchId: z.string(), reason: z.string().min(3) }).parse(req.body);
  const s = await prisma.student.findUniqueOrThrow({ where: { id: req.params.id } });
  const to = await prisma.batch.findUniqueOrThrow({ where: { id: toBatchId } });
  await assertBatchAvailable(prisma, toBatchId, to.courseId);
  const a = await prisma.$transaction((tx) => createApproval(tx, { type: 'BATCH_TRANSFER', entityType: 'student', entityId: s.id, title: `Batch transfer: ${s.fullName} → ${to.code}`, payload: { toBatchId, reason }, requestedById: req.user!.id }));
  res.json({ approval: a });
}));

// Guardians / education
r.post('/:id/guardians', can('students:manage'), ah(async (req, res) => {
  const d = guardianSchema.parse(req.body);
  res.status(201).json(await prisma.guardian.create({ data: { ...d, email: d.email || null, studentId: req.params.id } }));
}));
r.delete('/:id/guardians/:gid', can('students:manage'), ah(async (req, res) => {
  await prisma.guardian.delete({ where: { id: req.params.gid } });
  res.json({ ok: true });
}));
r.post('/:id/education', can('students:manage'), ah(async (req, res) => {
  res.status(201).json(await prisma.education.create({ data: { ...educationSchema.parse(req.body), studentId: req.params.id } }));
}));
r.delete('/:id/education/:eid', can('students:manage'), ah(async (req, res) => {
  await prisma.education.delete({ where: { id: req.params.eid } });
  res.json({ ok: true });
}));

// STU-05 photo / STU-11 documents
r.post('/:id/photo', can('students:manage'), upload.single('file'), ah(async (req, res) => {
  if (!req.file || !req.file.mimetype.startsWith('image/')) throw badRequest('Please upload a JPG or PNG image.');
  const s = await prisma.student.update({ where: { id: req.params.id }, data: { photoUrl: `/api/v1/files/${path.basename(req.file.path)}` } });
  res.json({ photoUrl: s.photoUrl });
}));
r.post('/:id/documents', can('students:manage'), upload.single('file'), ah(async (req, res) => {
  const { type } = z.object({ type: z.string().min(1) }).parse(req.body);
  if (!req.file) throw badRequest('Please choose a file to upload.');
  const doc = await prisma.document.create({ data: { studentId: req.params.id, type, fileName: req.file.originalname, storagePath: path.basename(req.file.path), mimeType: req.file.mimetype, size: req.file.size } });
  await prisma.studentHistory.create({ data: { studentId: req.params.id, type: 'DOCUMENT', message: `Document uploaded: ${type}`, userId: req.user!.id } });
  res.status(201).json(doc);
}));

export const documentsRouter = Router();
documentsRouter.get('/pending', can('documents:verify'), ah(async (_req, res) => {
  res.json({ items: await prisma.document.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 200, include: { student: { select: { id: true, fullName: true, studentCode: true } }, application: { select: { id: true, code: true } } } }) });
}));
documentsRouter.post('/:id/verify', can('documents:verify'), ah(async (req, res) => {
  const { status, remarks } = z.object({ status: z.enum(['VERIFIED', 'REJECTED']), remarks: z.string().optional() }).parse(req.body);
  if (status === 'REJECTED' && !remarks) throw badRequest('Please give a reason for rejection.');
  const d = await prisma.document.update({ where: { id: req.params.id }, data: { status, remarks, verifiedById: req.user!.id, verifiedAt: new Date() } });
  if (d.studentId) await prisma.studentHistory.create({ data: { studentId: d.studentId, type: 'DOCUMENT', message: `Document ${d.type} ${status.toLowerCase()}${remarks ? `: ${remarks}` : ''}`, userId: req.user!.id } });
  await audit(req, 'VERIFY', 'document', d.id, null, { status, remarks });
  res.json(d);
}));
documentsRouter.get('/:id/download', can('students:read', 'documents:verify', 'leads:read'), ah(async (req, res) => {
  const d = await prisma.document.findUniqueOrThrow({ where: { id: req.params.id } });
  const p = storedPath(d.storagePath);
  if (!fs.existsSync(p)) throw notFound('File missing from storage');
  res.setHeader('Content-Type', d.mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${d.fileName.replace(/"/g, '')}"`);
  fs.createReadStream(p).pipe(res);
}));

export default r;
