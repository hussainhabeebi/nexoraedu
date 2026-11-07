/** Public website API (no auth): course catalogue, enquiry, online registration/application, status, certificate verification. */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ah, badRequest, notFound } from '../lib/http';
import { getSettings } from '../lib/settings';
import { nextNumber } from '../lib/sequence';
import { normalizePhone } from '../lib/util';
import { upload } from '../lib/upload';
import { applicationDataSchema, assertBatchAvailable, validateApplicationData } from '../services/admissions';
import { notifyLater } from '../services/notify';
import { createLead, findDuplicateLead } from './crm';

const r = Router();
const formLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: { code: 'RATE_LIMIT', message: 'Too many submissions. Please try again later.' } } });

const publicCourse = {
  id: true, code: true, name: true, slug: true, category: true, summary: true, description: true, durationMonths: true, eligibility: true, mode: true, imageUrl: true, highlights: true, defaultInstallments: true,
  feeComponents: { where: { isActive: true }, select: { name: true, amount: true, taxPercent: true } },
  batches: { where: { status: { in: ['PLANNED', 'RUNNING'] as any } }, orderBy: { startDate: 'asc' as const }, select: { id: true, code: true, name: true, startDate: true, timing: true, mode: true, capacity: true, status: true, _count: { select: { students: true } } } },
};
const withFee = (c: any) => ({
  ...c,
  totalFee: c.feeComponents.reduce((s: number, f: any) => s + Number(f.amount) * (1 + Number(f.taxPercent) / 100), 0),
  batches: c.batches.map((b: any) => ({ ...b, seatsLeft: Math.max(0, b.capacity - b._count.students), _count: undefined })),
});

r.get('/site', ah(async (_req, res) => {
  const s = await getSettings();
  const courses = await prisma.course.findMany({ where: { isActive: true, isPublic: true }, orderBy: { name: 'asc' }, select: publicCourse });
  const docTypes = await prisma.masterItem.findMany({ where: { type: 'document_type', isActive: true }, orderBy: { sortOrder: 'asc' }, select: { code: true, label: true, meta: true } });
  const qualifications = await prisma.masterItem.findMany({ where: { type: 'qualification', isActive: true }, orderBy: { sortOrder: 'asc' }, select: { code: true, label: true } });
  const [students, coursesCount] = await Promise.all([prisma.student.count(), prisma.course.count({ where: { isActive: true } })]);
  res.json({ academy: s.academy, courses: courses.map(withFee), documentTypes: docTypes, qualifications, stats: { students, courses: coursesCount } });
}));

r.get('/courses/:slug', ah(async (req, res) => {
  const c = await prisma.course.findFirst({ where: { slug: req.params.slug, isActive: true, isPublic: true }, select: { ...publicCourse, subjects: { where: { isActive: true }, orderBy: { sequence: 'asc' }, select: { name: true, hours: true, modules: { where: { isActive: true }, orderBy: { sequence: 'asc' }, select: { name: true } } } } } });
  if (!c) throw notFound('Course not found');
  res.json(withFee(c));
}));

r.post('/enquiry', formLimiter, ah(async (req, res) => {
  const d = z.object({ name: z.string().min(2).max(100), phone: z.string().min(7).max(20), email: z.string().email().optional().or(z.literal('')), courseId: z.string().optional().nullable(), message: z.string().max(1000).optional(), website: z.string().optional() }).parse(req.body);
  if (d.website) return res.json({ ok: true }); // honeypot
  const dup = await findDuplicateLead(prisma, d.phone, d.email || null);
  if (dup) {
    await prisma.leadActivity.create({ data: { leadId: dup.id, type: 'SYSTEM', content: `Repeat website enquiry: ${d.message ?? ''}` } });
    if (dup.ownerId) await prisma.notification.create({ data: { userId: dup.ownerId, title: 'Repeat enquiry', body: `${dup.name} enquired again on the website`, link: `/staff/leads/${dup.id}` } });
  } else {
    await prisma.$transaction((tx) => createLead(tx, { name: d.name, phone: d.phone, email: d.email || null, courseId: d.courseId || null, source: 'website', notes: d.message }));
  }
  notifyLater('enquiry.received', { name: d.name, phone: d.phone, email: d.email || null }, { name: d.name }, { channels: ['WHATSAPP', 'EMAIL'] });
  res.status(201).json({ ok: true, message: 'Thank you! Our counselor will contact you shortly.' });
}));

/** Online student registration (multi-step form). multipart: data=<json>, files[] + fileTypes[] */
r.post('/applications', formLimiter, upload.array('files', 8), ah(async (req, res) => {
  let raw: unknown;
  try {
    raw = JSON.parse(String(req.body.data || '{}'));
  } catch {
    throw badRequest('Invalid form data.');
  }
  const data = applicationDataSchema.parse(raw);
  validateApplicationData(data);
  if (!data.declaration) throw badRequest('Please accept the declaration to submit.');
  const course = await prisma.course.findFirst({ where: { id: data.preferences.courseId, isActive: true } });
  if (!course) throw badRequest('Please choose a valid course.');
  if (data.preferences.batchId) await assertBatchAvailable(prisma, data.preferences.batchId, course.id);
  const files = (req.files as Express.Multer.File[]) ?? [];
  const types: string[] = ([] as string[]).concat(req.body.fileTypes ?? []);
  const existingApp = await prisma.application.findFirst({ where: { status: { in: ['SUBMITTED', 'UNDER_REVIEW', 'PENDING_APPROVAL'] }, lead: { phoneNormalized: normalizePhone(data.personal.phone) }, courseId: course.id } });
  if (existingApp) throw badRequest(`You already have an application in progress (${existingApp.code}). Use “Track application” to check its status.`);
  const s = await getSettings();
  const app = await prisma.$transaction(async (tx) => {
    let lead = await findDuplicateLead(tx, data.personal.phone, data.personal.email);
    if (!lead) lead = (await createLead(tx, { name: data.personal.fullName, phone: data.personal.phone, email: data.personal.email, courseId: course.id, source: 'website', city: data.personal.city }, undefined)) as any;
    const code = await nextNumber('application:{year}', s.ids.application, tx);
    const app = await tx.application.create({ data: { code, leadId: lead!.id, courseId: course.id, batchId: data.preferences.batchId || null, data: data as any, status: 'SUBMITTED', source: 'website' } });
    if (files.length) await tx.document.createMany({ data: files.map((f, i) => ({ applicationId: app.id, type: types[i] || 'other', fileName: f.originalname, storagePath: path.basename(f.path), mimeType: f.mimetype, size: f.size })) });
    await tx.lead.update({ where: { id: lead!.id }, data: { status: 'APPLICATION', courseId: course.id, lastActivityAt: new Date() } });
    await tx.leadActivity.create({ data: { leadId: lead!.id, type: 'STATUS', content: `Online application submitted (${code})` } });
    if (lead!.ownerId) await tx.notification.create({ data: { userId: lead!.ownerId, title: 'New online application', body: `${data.personal.fullName} applied for ${course.name} (${code})`, link: `/staff/applications/${app.id}` } });
    return app;
  });
  notifyLater('application.received', { name: data.personal.fullName, phone: data.personal.phone, email: data.personal.email }, { name: data.personal.fullName, code: app.code, course: course.name });
  res.status(201).json({ code: app.code, message: 'Application submitted successfully.' });
}));

r.get('/applications/status', formLimiter, ah(async (req, res) => {
  const { code, phone } = z.object({ code: z.string().min(4), phone: z.string().min(7) }).parse(req.query);
  const app = await prisma.application.findUnique({ where: { code: code.trim().toUpperCase() }, include: { lead: true } });
  if (!app || !app.lead || app.lead.phoneNormalized !== normalizePhone(phone)) throw notFound('No application found with these details.');
  const course = await prisma.course.findUnique({ where: { id: app.courseId }, select: { name: true } });
  const st = app.studentId ? await prisma.student.findUnique({ where: { id: app.studentId }, select: { studentCode: true } }) : null;
  res.json({ code: app.code, status: app.status, course: course?.name, submittedAt: app.createdAt, studentCode: st?.studentCode ?? null });
}));

r.get('/certificates/verify/:code', ah(async (req, res) => {
  const c = await prisma.certificate.findUnique({ where: { verificationCode: req.params.code.toUpperCase() }, include: { student: { select: { fullName: true, studentCode: true, course: { select: { name: true } } } } } });
  if (!c || c.status !== 'ISSUED') return res.json({ valid: false });
  res.json({ valid: true, number: c.number, name: c.student.fullName, studentCode: c.student.studentCode, course: c.student.course.name, issuedAt: c.issuedAt });
}));

export default r;
