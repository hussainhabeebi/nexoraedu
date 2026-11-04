/** CRM (SRS §11): leads, assignment, follow-ups, communication log, counselling, applications, admission conversion. */
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { LeadStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { ah, badRequest, conflict, forbidden, notFound, paging } from '../lib/http';
import { can, userCan } from '../lib/auth';
import { audit } from '../lib/audit';
import { nextNumber } from '../lib/sequence';
import { getSettings } from '../lib/settings';
import { normalizeEmail, normalizePhone, toCsv } from '../lib/util';
import { createApproval } from '../services/approvals';
import { applicationDataSchema, assertBatchAvailable, assertNoDuplicateStudent, validateApplicationData } from '../services/admissions';
import { notifyUser } from '../services/notify';

const r = Router();
type Tx = Prisma.TransactionClient;

const STATUSES = ['NEW', 'CONTACTED', 'INTERESTED', 'COUNSELLED', 'APPLICATION', 'ADMITTED', 'NOT_INTERESTED', 'LOST', 'JUNK'] as const;
const CLOSED: LeadStatus[] = ['ADMITTED', 'NOT_INTERESTED', 'LOST', 'JUNK'];

/** CRM-05: counselors see only their own leads unless they hold leads:read_all. */
function scope(req: Request): Prisma.LeadWhereInput {
  return userCan(req, 'leads:read_all') ? {} : { ownerId: req.user!.id };
}
async function getScopedLead(req: Request, id: string) {
  const lead = await prisma.lead.findFirst({ where: { id, ...scope(req) } });
  if (!lead) throw notFound('Lead not found or not assigned to you.');
  return lead;
}

/** CRM-04: automatic assignment — least-loaded active counselor (round-robin on ties by oldest last assignment). */
export async function pickCounselor(tx: Tx = prisma) {
  const counselors = await tx.user.findMany({ where: { isActive: true, roles: { some: { role: { key: 'counselor' } } } }, select: { id: true } });
  if (!counselors.length) return null;
  const loads = await tx.lead.groupBy({ by: ['ownerId'], where: { ownerId: { in: counselors.map((c) => c.id) }, status: { notIn: CLOSED } }, _count: true });
  const m = Object.fromEntries(loads.map((l) => [l.ownerId!, l._count]));
  return counselors.sort((a, b) => (m[a.id] ?? 0) - (m[b.id] ?? 0))[0].id;
}

/** CRM-16: duplicate detection by normalized phone/email. */
export async function findDuplicateLead(tx: Tx, phone: string, email?: string | null) {
  const pn = normalizePhone(phone);
  const en = normalizeEmail(email);
  return tx.lead.findFirst({
    where: { OR: [{ phoneNormalized: pn }, ...(en ? [{ emailNormalized: en }] : [])] },
    include: { owner: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

export const leadInput = z.object({
  name: z.string().min(2).max(120),
  phone: z.string().min(7).max(20),
  email: z.string().email().optional().or(z.literal('')).nullable(),
  courseId: z.string().optional().nullable(),
  source: z.string().default('walk_in'),
  city: z.string().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  ownerId: z.string().optional().nullable(),
});

export async function createLead(tx: Tx, d: z.infer<typeof leadInput>, actorId?: string, extra: Partial<Prisma.LeadUncheckedCreateInput> = {}) {
  const s = await getSettings();
  const code = await nextNumber('lead', s.ids.lead, tx);
  const ownerId = d.ownerId || (s.crm.autoAssign !== 'manual' ? await pickCounselor(tx) : null);
  const lead = await tx.lead.create({
    data: {
      code,
      name: d.name,
      phone: d.phone,
      phoneNormalized: normalizePhone(d.phone),
      email: d.email || null,
      emailNormalized: normalizeEmail(d.email),
      courseId: d.courseId || null,
      source: d.source,
      city: d.city,
      notes: d.notes,
      ownerId,
      ...extra,
    },
  });
  await tx.leadActivity.create({ data: { leadId: lead.id, type: 'SYSTEM', content: `Lead created from ${d.source}${ownerId ? '' : ' (unassigned)'}`, userId: actorId } });
  if (ownerId) {
    await tx.leadActivity.create({ data: { leadId: lead.id, type: 'ASSIGNMENT', content: 'Assigned automatically', userId: actorId, meta: { to: ownerId } } });
    setImmediate(() => notifyUser(ownerId, 'New lead assigned', `${lead.name} (${lead.phone})`, `/staff/leads/${lead.id}`).catch(() => undefined));
  }
  return lead;
}

// ── List / search ──
r.get('/leads', can('leads:read'), ah(async (req, res) => {
  const { skip, take, page, pageSize } = paging(req.query);
  const q = String(req.query.q || '').trim();
  const where: Prisma.LeadWhereInput = {
    ...scope(req),
    ...(req.query.status && { status: { in: String(req.query.status).split(',') as LeadStatus[] } }),
    ...(req.query.source && { source: String(req.query.source) }),
    ...(req.query.courseId && { courseId: String(req.query.courseId) }),
    ...(req.query.ownerId && { ownerId: req.query.ownerId === 'none' ? null : String(req.query.ownerId) }),
    ...(req.query.followUp === 'due' && { nextFollowUpAt: { lte: new Date() } }),
    ...(req.query.from && { createdAt: { gte: new Date(String(req.query.from)) } }),
    ...(q && {
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { code: { contains: q, mode: 'insensitive' } },
        { phoneNormalized: { contains: q.replace(/\D/g, '') || q } },
        { email: { contains: q, mode: 'insensitive' } },
      ],
    }),
  };
  const sort = String(req.query.sort || 'createdAt');
  const dir = req.query.dir === 'asc' ? 'asc' : 'desc';
  const orderBy = ['createdAt', 'name', 'lastActivityAt', 'nextFollowUpAt', 'status'].includes(sort) ? { [sort]: dir } : { createdAt: 'desc' as const };
  if (req.query.format === 'csv') {
    const all = await prisma.lead.findMany({ where, orderBy, take: 10000, include: { owner: { select: { name: true } }, course: { select: { name: true } } } });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    return res.send(toCsv(all.map((l) => ({ code: l.code, name: l.name, phone: l.phone, email: l.email, course: l.course?.name, source: l.source, status: l.status, owner: l.owner?.name, created: l.createdAt, nextFollowUp: l.nextFollowUpAt }))));
  }
  const [items, total, byStatus] = await Promise.all([
    prisma.lead.findMany({ where, skip, take, orderBy, include: { owner: { select: { id: true, name: true } }, course: { select: { id: true, name: true } } } }),
    prisma.lead.count({ where }),
    prisma.lead.groupBy({ by: ['status'], where: scope(req), _count: true }),
  ]);
  res.json({ items, total, page, pageSize, byStatus: Object.fromEntries(byStatus.map((b) => [b.status, b._count])) });
}));

r.post('/leads/check-duplicate', can('leads:create'), ah(async (req, res) => {
  const { phone, email } = z.object({ phone: z.string(), email: z.string().optional() }).parse(req.body);
  const dup = await findDuplicateLead(prisma, phone, email);
  res.json({ duplicate: dup ? { id: dup.id, code: dup.code, name: dup.name, status: dup.status, owner: dup.owner?.name } : null });
}));

r.post('/leads', can('leads:create'), ah(async (req, res) => {
  const d = leadInput.parse(req.body);
  if (d.ownerId && !userCan(req, 'leads:assign')) d.ownerId = req.user!.id;
  if (!d.ownerId && !userCan(req, 'leads:assign')) d.ownerId = req.user!.id; // counselor-created leads stay with them
  const lead = await prisma.$transaction(async (tx) => {
    const dup = await findDuplicateLead(tx, d.phone, d.email);
    if (dup) throw conflict(`A lead with this phone or email already exists (${dup.code} — ${dup.name}, owner: ${dup.owner?.name ?? 'unassigned'}).`, { id: dup.id, code: dup.code });
    return createLead(tx, d, req.user!.id);
  });
  await audit(req, 'CREATE', 'lead', lead.id, null, d);
  res.status(201).json(lead);
}));

r.get('/leads/:id', can('leads:read'), ah(async (req, res) => {
  await getScopedLead(req, req.params.id);
  const lead = await prisma.lead.findUniqueOrThrow({
    where: { id: req.params.id },
    include: {
      owner: { select: { id: true, name: true, phone: true } },
      course: { select: { id: true, name: true } },
      activities: { orderBy: { createdAt: 'desc' }, take: 200 },
      followUps: { orderBy: { dueAt: 'desc' } },
      counselling: { orderBy: { date: 'desc' } },
      applications: { orderBy: { createdAt: 'desc' } },
      student: { select: { id: true, studentCode: true } },
    },
  });
  const userIds = [...new Set([...lead.activities.map((a) => a.userId), ...lead.counselling.map((c) => c.counselorId)].filter(Boolean) as string[])];
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
  res.json({ ...lead, userNames: Object.fromEntries(users.map((u) => [u.id, u.name])) });
}));

r.patch('/leads/:id', can('leads:update'), ah(async (req, res) => {
  const before = await getScopedLead(req, req.params.id);
  const d = leadInput.omit({ ownerId: true }).partial().parse(req.body);
  const lead = await prisma.lead.update({
    where: { id: before.id },
    data: {
      ...d,
      email: d.email === '' ? null : d.email,
      ...(d.phone && { phoneNormalized: normalizePhone(d.phone) }),
      ...(d.email !== undefined && { emailNormalized: normalizeEmail(d.email) }),
    },
  });
  await audit(req, 'UPDATE', 'lead', lead.id, before, d);
  res.json(lead);
}));

// CRM-07 status pipeline; Lost/Junk require reason
r.post('/leads/:id/status', can('leads:update'), ah(async (req, res) => {
  const lead = await getScopedLead(req, req.params.id);
  const { status, reason } = z.object({ status: z.enum(STATUSES), reason: z.string().optional() }).parse(req.body);
  if (status === 'ADMITTED') throw badRequest('Leads become Admitted only through the admission approval.');
  if (['LOST', 'JUNK', 'NOT_INTERESTED'].includes(status) && !reason?.trim()) throw badRequest('Please select a reason to close this lead.');
  if (lead.status === 'ADMITTED') throw badRequest('This lead has already been admitted.');
  await prisma.$transaction([
    prisma.lead.update({ where: { id: lead.id }, data: { status, closeReason: reason ?? null, lastActivityAt: new Date(), ...(CLOSED.includes(status) && { nextFollowUpAt: null }) } }),
    prisma.leadActivity.create({ data: { leadId: lead.id, type: 'STATUS', content: `${lead.status} → ${status}${reason ? ` (${reason})` : ''}`, userId: req.user!.id } }),
    ...(CLOSED.includes(status) ? [prisma.followUp.updateMany({ where: { leadId: lead.id, status: 'PENDING' }, data: { status: 'CANCELLED' } })] : []),
  ]);
  await audit(req, 'STATUS', 'lead', lead.id, { status: lead.status }, { status, reason });
  res.json({ ok: true });
}));

// CRM-15 single / bulk reassignment with reason and history
r.post('/leads/assign', can('leads:assign'), ah(async (req, res) => {
  const { leadIds, ownerId, reason } = z.object({ leadIds: z.array(z.string()).min(1).max(500), ownerId: z.string(), reason: z.string().min(2) }).parse(req.body);
  const owner = await prisma.user.findFirst({ where: { id: ownerId, isActive: true } });
  if (!owner) throw badRequest('Selected counselor is not active.');
  const leads = await prisma.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, ownerId: true } });
  await prisma.$transaction([
    prisma.lead.updateMany({ where: { id: { in: leadIds } }, data: { ownerId } }),
    prisma.leadActivity.createMany({ data: leads.map((l) => ({ leadId: l.id, type: 'ASSIGNMENT', content: `Reassigned to ${owner.name}: ${reason}`, userId: req.user!.id, meta: { from: l.ownerId, to: ownerId } })) }),
    prisma.followUp.updateMany({ where: { leadId: { in: leadIds }, status: 'PENDING' }, data: { userId: ownerId } }),
  ]);
  await audit(req, 'ASSIGN', 'lead', null, null, { leadIds, ownerId, reason });
  await notifyUser(ownerId, `${leads.length} lead(s) assigned to you`, reason, '/staff/leads');
  res.json({ updated: leads.length });
}));

// CRM-10 communication log (read-only after save; DB trigger enforces)
r.post('/leads/:id/activities', can('leads:update'), ah(async (req, res) => {
  const lead = await getScopedLead(req, req.params.id);
  const d = z.object({ type: z.enum(['CALL', 'EMAIL', 'SMS', 'WHATSAPP', 'MEETING', 'NOTE']), direction: z.enum(['INBOUND', 'OUTBOUND']).optional(), content: z.string().min(1).max(5000), outcome: z.string().optional(), nextStep: z.string().optional() }).parse(req.body);
  const a = await prisma.$transaction(async (tx) => {
    const a = await tx.leadActivity.create({ data: { ...d, leadId: lead.id, userId: req.user!.id } });
    await tx.lead.update({ where: { id: lead.id }, data: { lastActivityAt: new Date(), ...(lead.status === 'NEW' && d.type !== 'NOTE' && { status: 'CONTACTED' }) } });
    return a;
  });
  res.status(201).json(a);
}));

// CRM-08 follow-ups
r.post('/leads/:id/follow-ups', can('leads:update'), ah(async (req, res) => {
  const lead = await getScopedLead(req, req.params.id);
  const d = z.object({ dueAt: z.coerce.date(), mode: z.enum(['CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'VISIT']).default('CALL'), note: z.string().optional() }).parse(req.body);
  const f = await prisma.$transaction(async (tx) => {
    const f = await tx.followUp.create({ data: { ...d, leadId: lead.id, userId: lead.ownerId ?? req.user!.id } });
    const next = await tx.followUp.findFirst({ where: { leadId: lead.id, status: 'PENDING' }, orderBy: { dueAt: 'asc' } });
    await tx.lead.update({ where: { id: lead.id }, data: { nextFollowUpAt: next?.dueAt ?? null } });
    return f;
  });
  res.status(201).json(f);
}));
r.post('/follow-ups/:id/complete', can('leads:update'), ah(async (req, res) => {
  const { outcome, note } = z.object({ outcome: z.string().min(1), note: z.string().optional() }).parse(req.body);
  const f = await prisma.followUp.findUniqueOrThrow({ where: { id: req.params.id } });
  await getScopedLead(req, f.leadId);
  await prisma.$transaction(async (tx) => {
    await tx.followUp.update({ where: { id: f.id }, data: { status: 'DONE', completedAt: new Date() } });
    await tx.leadActivity.create({ data: { leadId: f.leadId, type: f.mode === 'WHATSAPP' ? 'WHATSAPP' : f.mode === 'EMAIL' ? 'EMAIL' : f.mode === 'MEETING' || f.mode === 'VISIT' ? 'MEETING' : 'CALL', direction: 'OUTBOUND', content: note || 'Follow-up completed', outcome, userId: req.user!.id } });
    const next = await tx.followUp.findFirst({ where: { leadId: f.leadId, status: 'PENDING' }, orderBy: { dueAt: 'asc' } });
    await tx.lead.update({ where: { id: f.leadId }, data: { nextFollowUpAt: next?.dueAt ?? null, lastActivityAt: new Date() } });
  });
  res.json({ ok: true });
}));
r.get('/follow-ups', can('leads:read'), ah(async (req, res) => {
  const where: Prisma.FollowUpWhereInput = {
    status: 'PENDING',
    ...(userCan(req, 'leads:read_all') && req.query.all === 'true' ? {} : { userId: req.user!.id }),
    ...(req.query.when === 'overdue' && { dueAt: { lt: new Date() } }),
    ...(req.query.when === 'today' && { dueAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)), lt: new Date(new Date().setHours(24, 0, 0, 0)) } }),
  };
  res.json({ items: await prisma.followUp.findMany({ where, orderBy: { dueAt: 'asc' }, take: 200, include: { lead: { select: { id: true, name: true, phone: true, status: true, code: true } } } }) });
}));

// CRM-11 counselling sessions
r.post('/leads/:id/counselling', can('leads:update'), ah(async (req, res) => {
  const lead = await getScopedLead(req, req.params.id);
  const d = z.object({ date: z.coerce.date().default(() => new Date()), courseAdvised: z.string().optional(), remarks: z.string().optional(), outcome: z.string().optional() }).parse(req.body);
  const c = await prisma.$transaction(async (tx) => {
    const c = await tx.counsellingSession.create({ data: { ...d, leadId: lead.id, counselorId: req.user!.id } });
    if (['NEW', 'CONTACTED', 'INTERESTED'].includes(lead.status)) {
      await tx.lead.update({ where: { id: lead.id }, data: { status: 'COUNSELLED', lastActivityAt: new Date() } });
      await tx.leadActivity.create({ data: { leadId: lead.id, type: 'STATUS', content: `${lead.status} → COUNSELLED`, userId: req.user!.id } });
    }
    return c;
  });
  res.status(201).json(c);
}));

// CRM-03 import with mapping (client maps columns), validation, error report, dup skip/merge
r.post('/leads/import', can('leads:create'), ah(async (req, res) => {
  const { rows, duplicates } = z.object({ rows: z.array(z.record(z.string(), z.any())).max(5000), duplicates: z.enum(['skip', 'merge']).default('skip') }).parse(req.body);
  const courses = await prisma.course.findMany({ select: { id: true, code: true, name: true } });
  const findCourse = (v?: string) => (v ? courses.find((c) => c.code.toLowerCase() === v.toLowerCase() || c.name.toLowerCase() === v.toLowerCase())?.id : undefined);
  const report: { row: number; status: 'created' | 'skipped' | 'merged' | 'error'; message?: string }[] = [];
  for (const [i, raw] of rows.entries()) {
    const parsed = leadInput.safeParse({ ...raw, courseId: findCourse(raw.course) ?? null, source: raw.source || 'import', email: raw.email || null });
    if (!parsed.success) {
      report.push({ row: i + 2, status: 'error', message: Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => `${k}: ${v?.join(', ')}`).join('; ') });
      continue;
    }
    try {
      await prisma.$transaction(async (tx) => {
        const dup = await findDuplicateLead(tx, parsed.data.phone, parsed.data.email);
        if (dup) {
          if (duplicates === 'merge') {
            await tx.lead.update({ where: { id: dup.id }, data: { email: dup.email ?? parsed.data.email, courseId: dup.courseId ?? parsed.data.courseId, notes: [dup.notes, parsed.data.notes].filter(Boolean).join('\n') || null } });
            await tx.leadActivity.create({ data: { leadId: dup.id, type: 'SYSTEM', content: 'Merged with imported record', userId: req.user!.id } });
            report.push({ row: i + 2, status: 'merged', message: dup.code });
          } else report.push({ row: i + 2, status: 'skipped', message: `Duplicate of ${dup.code}` });
          return;
        }
        if (!userCan(req, 'leads:assign')) parsed.data.ownerId = req.user!.id;
        await createLead(tx, parsed.data, req.user!.id);
        report.push({ row: i + 2, status: 'created' });
      });
    } catch (e: any) {
      report.push({ row: i + 2, status: 'error', message: e.message });
    }
  }
  await audit(req, 'IMPORT', 'lead', null, null, { rows: rows.length, created: report.filter((x) => x.status === 'created').length });
  res.json({ report, summary: report.reduce((a: any, x) => ((a[x.status] = (a[x.status] ?? 0) + 1), a), {}) });
}));

// CRM-16 merge (Sales Manager)
r.post('/leads/:id/merge', can('leads:delete'), ah(async (req, res) => {
  const { duplicateId } = z.object({ duplicateId: z.string() }).parse(req.body);
  if (duplicateId === req.params.id) throw badRequest('Choose a different lead to merge.');
  const [keep, dup] = await Promise.all([prisma.lead.findUniqueOrThrow({ where: { id: req.params.id } }), prisma.lead.findUniqueOrThrow({ where: { id: duplicateId } })]);
  if (dup.studentId) throw badRequest('An admitted lead cannot be merged away.');
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`ALTER TABLE lead_activities DISABLE TRIGGER lead_activities_immutable`;
    await tx.leadActivity.updateMany({ where: { leadId: dup.id }, data: { leadId: keep.id } });
    await tx.$executeRaw`ALTER TABLE lead_activities ENABLE TRIGGER lead_activities_immutable`;
    await tx.followUp.updateMany({ where: { leadId: dup.id }, data: { leadId: keep.id } });
    await tx.counsellingSession.updateMany({ where: { leadId: dup.id }, data: { leadId: keep.id } });
    await tx.application.updateMany({ where: { leadId: dup.id }, data: { leadId: keep.id } });
    await tx.lead.update({ where: { id: dup.id }, data: { status: 'JUNK', closeReason: `Merged into ${keep.code}` } });
    await tx.leadActivity.create({ data: { leadId: keep.id, type: 'SYSTEM', content: `Merged duplicate ${dup.code}`, userId: req.user!.id } });
  });
  await audit(req, 'MERGE', 'lead', keep.id, dup, { into: keep.id });
  res.json({ ok: true });
}));

// ── Applications (CRM-12) ──
r.get('/applications', can('leads:read', 'students:read'), ah(async (req, res) => {
  const { skip, take, page, pageSize } = paging(req.query);
  const where: Prisma.ApplicationWhereInput = {
    ...(req.query.status && { status: String(req.query.status) as any }),
    ...(!userCan(req, 'leads:read_all') && !userCan(req, 'students:manage') && { lead: { ownerId: req.user!.id } }),
  };
  const [items, total] = await Promise.all([
    prisma.application.findMany({ where, skip, take, orderBy: { createdAt: 'desc' }, include: { lead: { select: { id: true, code: true, owner: { select: { name: true } } } }, _count: { select: { documents: true } } } }),
    prisma.application.count({ where }),
  ]);
  const courses = await prisma.course.findMany({ select: { id: true, name: true } });
  const cn = Object.fromEntries(courses.map((c) => [c.id, c.name]));
  res.json({ items: items.map((a) => ({ ...a, courseName: cn[a.courseId] })), total, page, pageSize });
}));

r.get('/applications/:id', can('leads:read', 'students:read'), ah(async (req, res) => {
  const a = await prisma.application.findUnique({ where: { id: req.params.id }, include: { lead: { select: { id: true, code: true, name: true, ownerId: true } }, documents: true } });
  if (!a) throw notFound('Application not found');
  if (!userCan(req, 'leads:read_all') && !userCan(req, 'students:manage') && a.lead?.ownerId !== req.user!.id) throw forbidden();
  const approval = await prisma.approvalRequest.findFirst({ where: { type: 'ADMISSION', entityId: a.id }, orderBy: { createdAt: 'desc' }, include: { actions: true } });
  res.json({ ...a, approval });
}));

r.post('/leads/:id/application', can('leads:update'), ah(async (req, res) => {
  const lead = await getScopedLead(req, req.params.id);
  const data = applicationDataSchema.parse(req.body);
  validateApplicationData(data);
  if (data.preferences.batchId) await assertBatchAvailable(prisma, data.preferences.batchId, data.preferences.courseId);
  const s = await getSettings();
  const app = await prisma.$transaction(async (tx) => {
    const code = await nextNumber(`application:${new Date().getFullYear()}`, s.ids.application, tx);
    const app = await tx.application.create({ data: { code, leadId: lead.id, courseId: data.preferences.courseId, batchId: data.preferences.batchId || null, data: data as any, status: 'UNDER_REVIEW' } });
    await tx.lead.update({ where: { id: lead.id }, data: { status: 'APPLICATION', courseId: data.preferences.courseId, lastActivityAt: new Date() } });
    await tx.leadActivity.create({ data: { leadId: lead.id, type: 'STATUS', content: `${lead.status} → APPLICATION (${code})`, userId: req.user!.id } });
    return app;
  });
  await audit(req, 'CREATE', 'application', app.id, null, { leadId: lead.id });
  res.status(201).json(app);
}));

r.patch('/applications/:id', can('leads:update', 'students:manage'), ah(async (req, res) => {
  const a = await prisma.application.findUniqueOrThrow({ where: { id: req.params.id } });
  if (['ADMITTED', 'PENDING_APPROVAL'].includes(a.status)) throw badRequest('This application can no longer be edited.');
  const d = z.object({ data: applicationDataSchema.optional(), status: z.enum(['UNDER_REVIEW', 'REJECTED']).optional(), remarks: z.string().optional() }).parse(req.body);
  if (d.data) validateApplicationData(d.data);
  const u = await prisma.application.update({ where: { id: a.id }, data: { ...(d.data && { data: d.data as any, courseId: d.data.preferences.courseId, batchId: d.data.preferences.batchId || null }), status: d.status, remarks: d.remarks } });
  await audit(req, 'UPDATE', 'application', a.id, a, d);
  res.json(u);
}));

// CRM-13: request admission → Sales Manager approval → student created automatically
r.post('/applications/:id/admit', can('leads:update', 'students:manage'), ah(async (req, res) => {
  const { batchId, installments } = z.object({ batchId: z.string().optional().nullable(), installments: z.number().int().min(1).max(24).optional() }).parse(req.body);
  const a = await prisma.application.findUniqueOrThrow({ where: { id: req.params.id } });
  if (!['SUBMITTED', 'UNDER_REVIEW', 'APPROVED'].includes(a.status)) throw badRequest(`Application is ${a.status.toLowerCase().replace('_', ' ')}.`);
  const data = applicationDataSchema.parse(a.data);
  await assertNoDuplicateStudent(prisma, data.personal.phone, data.personal.email);
  const bId = batchId ?? a.batchId;
  if (!bId) throw badRequest('Please allocate a batch before requesting admission.');
  await assertBatchAvailable(prisma, bId, a.courseId);
  const approval = await prisma.$transaction(async (tx) => {
    await tx.application.update({ where: { id: a.id }, data: { status: 'PENDING_APPROVAL', batchId: bId } });
    return createApproval(tx, { type: 'ADMISSION', entityType: 'application', entityId: a.id, title: `Admission: ${data.personal.fullName} (${a.code})`, payload: { batchId: bId, installments }, requestedById: req.user!.id });
  });
  await audit(req, 'REQUEST_ADMISSION', 'application', a.id, null, { batchId: bId, installments, approvalId: approval.id });
  res.json({ approval, message: approval.status === 'APPROVED' ? 'Student admitted.' : 'Admission sent for approval.' });
}));

export default r;
