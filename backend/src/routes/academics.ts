/** Academic management (SRS §14, ADM-08): courses, subjects, modules, batches, faculty, timetable, attendance, materials, assignments. */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { batchScopeIds, canAccessBatch, facultyBatchIds } from '../lib/policy';
import { ah, badRequest, conflict, forbidden, notFound } from '../lib/http';
import { can, userCan } from '../lib/auth';
import { audit } from '../lib/audit';
import { getSettings } from '../lib/settings';
import { slugify } from '../lib/util';
import { createApproval } from '../services/approvals';
import { notifyLater } from '../services/notify';

const r = Router();

// ── Courses (with fee structure) ──
const courseSchema = z.object({
  code: z.string().min(2).max(20),
  name: z.string().min(2),
  category: z.string().optional().nullable(),
  summary: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  durationMonths: z.coerce.number().int().min(1).max(60),
  eligibility: z.string().optional().nullable(),
  mode: z.string().default('Classroom'),
  imageUrl: z.string().optional().nullable(),
  highlights: z.array(z.string()).default([]),
  defaultInstallments: z.coerce.number().int().min(1).max(24).default(1),
  isPublic: z.boolean().default(true),
  isActive: z.boolean().default(true),
  feeComponents: z.array(z.object({ name: z.string(), amount: z.coerce.number().min(0), taxPercent: z.coerce.number().min(0).max(100).default(0) })).optional(),
});

r.get('/courses', can('academics:read', 'masters:manage', 'leads:read', 'students:read', 'finance:read', 'exams:read'), ah(async (req, res) => {
  const items = await prisma.course.findMany({
    where: req.query.all ? {} : { isActive: true },
    orderBy: { name: 'asc' },
    include: { feeComponents: { where: { isActive: true } }, _count: { select: { students: true, batches: true, subjects: true } } },
  });
  res.json({ items: items.map((c) => ({ ...c, totalFee: c.feeComponents.reduce((s, f) => s + Number(f.amount) * (1 + Number(f.taxPercent) / 100), 0) })) });
}));

r.get('/courses/:id', can('academics:read', 'masters:manage', 'leads:read', 'students:read', 'finance:read', 'exams:read'), ah(async (req, res) => {
  const c = await prisma.course.findUnique({
    where: { id: req.params.id },
    include: { feeComponents: { where: { isActive: true } }, subjects: { orderBy: { sequence: 'asc' }, include: { modules: { orderBy: { sequence: 'asc' } } } }, batches: { orderBy: { startDate: 'desc' } } },
  });
  if (!c) throw notFound('Course not found');
  res.json(c);
}));

r.post('/courses', can('masters:manage', 'academics:manage'), ah(async (req, res) => {
  const { feeComponents, ...d } = courseSchema.parse(req.body);
  const c = await prisma.$transaction(async (tx) => {
    const c = await tx.course.create({ data: { ...d, code: d.code.toUpperCase(), slug: slugify(d.name), feeComponents: feeComponents ? { create: feeComponents } : undefined } });
    await audit(tx, req, 'CREATE', 'course', c.id, null, { ...d, feeComponents });
    return c;
  });
  res.status(201).json(c);
}));

r.patch('/courses/:id', can('masters:manage', 'academics:manage'), ah(async (req, res) => {
  const { feeComponents, ...d } = courseSchema.partial().parse(req.body);
  const before = await prisma.course.findUniqueOrThrow({ where: { id: req.params.id }, include: { feeComponents: { where: { isActive: true } } } });
  const c = await prisma.$transaction(async (tx) => {
    const c = await tx.course.update({ where: { id: req.params.id }, data: { ...d, code: d.code?.toUpperCase() } });
    if (feeComponents) {
      // FIN-01: fee changes apply to new admissions only — retire old components, add new effective-dated ones.
      await tx.feeComponent.updateMany({ where: { courseId: c.id, isActive: true }, data: { isActive: false } });
      await tx.feeComponent.createMany({ data: feeComponents.map((f) => ({ ...f, courseId: c.id })) });
    }
    await audit(tx, req, 'UPDATE', 'course', c.id, before, { ...d, feeComponents });
    return c;
  });
  res.json(c);
}));

// ── Subjects & modules (ACD-01/02) ──
r.post('/courses/:id/subjects', can('academics:manage', 'masters:manage'), ah(async (req, res) => {
  const d = z.object({ code: z.string(), name: z.string(), sequence: z.number().int().default(1), hours: z.number().int().default(0), credits: z.number().int().optional() }).parse(req.body);
  const s = await prisma.$transaction(async (tx) => {
    const s = await tx.subject.create({ data: { ...d, courseId: req.params.id } });
    await audit(tx, req, 'CREATE', 'subject', s.id, null, { ...d, courseId: req.params.id });
    return s;
  });
  res.status(201).json(s);
}));
r.patch('/subjects/:id', can('academics:manage', 'masters:manage'), ah(async (req, res) => {
  const d = z.object({ name: z.string().optional(), sequence: z.number().int().optional(), hours: z.number().int().optional(), isActive: z.boolean().optional() }).parse(req.body);
  res.json(await prisma.subject.update({ where: { id: req.params.id }, data: d }));
}));
r.post('/subjects/:id/modules', can('academics:manage', 'masters:manage'), ah(async (req, res) => {
  const d = z.object({ name: z.string(), sequence: z.number().int().default(1), hours: z.number().int().default(0) }).parse(req.body);
  res.status(201).json(await prisma.module.create({ data: { ...d, subjectId: req.params.id } }));
}));
r.patch('/modules/:id', can('academics:manage', 'attendance:mark'), ah(async (req, res) => {
  const d = z.object({ name: z.string().optional(), completed: z.boolean().optional(), isActive: z.boolean().optional() }).parse(req.body);
  const before = await prisma.module.findUnique({ where: { id: req.params.id } });
  if (!before) throw notFound();
  if (!userCan(req, 'academics:manage')) {
    // Faculty: only modules of subjects they are allocated to, and only the completion flag.
    const allocated = await prisma.facultyAllocation.count({ where: { facultyId: req.user!.id, subjectId: before.subjectId } });
    if (!allocated) throw notFound();
    if (d.name !== undefined || d.isActive !== undefined) throw forbidden('Only the Academic Manager can rename or deactivate modules.');
  }
  const m = await prisma.$transaction(async (tx) => {
    const m = await tx.module.update({ where: { id: before.id }, data: d });
    await audit(tx, req, 'UPDATE', 'module', m.id, before, d);
    return m;
  });
  res.json(m);
}));

// ── Batches (ACD-03) ──
const batchSchema = z.object({
  code: z.string().min(2),
  name: z.string().min(2),
  courseId: z.string(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().optional().nullable(),
  timing: z.string().optional().nullable(),
  capacity: z.coerce.number().int().min(1).max(1000),
  mode: z.string().default('Classroom'),
  status: z.enum(['PLANNED', 'RUNNING', 'COMPLETED', 'CANCELLED']).default('PLANNED'),
});

export { facultyBatchIds };

r.get('/batches', can('academics:read', 'leads:read', 'students:read', 'finance:read', 'exams:read'), ah(async (req, res) => {
  const where: any = {
    ...(req.query.courseId && { courseId: String(req.query.courseId) }),
    ...(req.query.status && { status: String(req.query.status) }),
  };
  if (!userCan(req, 'academics:manage') && !userCan(req, 'students:read') && userCan(req, 'attendance:mark')) where.id = { in: await facultyBatchIds(req.user!.id) };
  const items = await prisma.batch.findMany({
    where,
    orderBy: { startDate: 'desc' },
    include: { course: { select: { id: true, name: true, code: true } }, _count: { select: { students: { where: { status: { in: ['ADMITTED', 'ACTIVE', 'ON_HOLD'] } } } } } },
  });
  res.json({ items });
}));

r.get('/batches/:id', can('academics:read', 'students:read'), ah(async (req, res) => {
  if (!(await canAccessBatch(req.user!, req.params.id))) throw notFound(); // faculty: own batches only
  const b = await prisma.batch.findUnique({
    where: { id: req.params.id },
    include: {
      course: { include: { subjects: { where: { isActive: true }, orderBy: { sequence: 'asc' }, include: { modules: { orderBy: { sequence: 'asc' } } } } } },
      students: { where: { status: { in: ['ADMITTED', 'ACTIVE', 'ON_HOLD'] } }, orderBy: { fullName: 'asc' }, select: { id: true, studentCode: true, fullName: true, phone: true, status: true } },
      allocations: true,
    },
  });
  if (!b) throw notFound('Batch not found');
  const facultyIds = b.allocations.map((a) => a.facultyId);
  const faculty = await prisma.user.findMany({ where: { id: { in: facultyIds } }, select: { id: true, name: true } });
  res.json({ ...b, faculty });
}));

r.post('/batches', can('academics:manage'), ah(async (req, res) => {
  const d = batchSchema.parse(req.body);
  const b = await prisma.$transaction(async (tx) => {
    const b = await tx.batch.create({ data: { ...d, code: d.code.toUpperCase() } });
    await audit(tx, req, 'CREATE', 'batch', b.id, null, d);
    return b;
  });
  res.status(201).json(b);
}));
r.patch('/batches/:id', can('academics:manage'), ah(async (req, res) => {
  const d = batchSchema.partial().parse(req.body);
  const before = await prisma.batch.findUniqueOrThrow({ where: { id: req.params.id } });
  const b = await prisma.$transaction(async (tx) => {
    const b = await tx.batch.update({ where: { id: req.params.id }, data: d });
    if (d.status === 'RUNNING' && before.status !== 'RUNNING') await tx.student.updateMany({ where: { batchId: b.id, status: 'ADMITTED' }, data: { status: 'ACTIVE' } });
    await audit(tx, req, 'UPDATE', 'batch', b.id, before, d);
    return b;
  });
  res.json(b);
}));

// ── Faculty (ACD-04/05) ──
r.get('/faculty', can('academics:read', 'exams:read'), ah(async (_req, res) => {
  const users = await prisma.user.findMany({
    where: { isActive: true, roles: { some: { role: { key: 'faculty' } } } },
    select: { id: true, name: true, email: true, phone: true, faculty: true },
    orderBy: { name: 'asc' },
  });
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart.getTime() + 7 * 864e5);
  const load = await prisma.timetableSession.groupBy({ by: ['facultyId'], where: { startsAt: { gte: weekStart, lt: weekEnd }, cancelled: false }, _count: true });
  const m = Object.fromEntries(load.map((l) => [l.facultyId, l._count]));
  res.json({ items: users.map((u) => ({ ...u, sessionsThisWeek: m[u.id] ?? 0 })) });
}));
r.put('/faculty/:userId', can('academics:manage'), ah(async (req, res) => {
  const d = z.object({ qualifications: z.string().optional(), subjects: z.array(z.string()).optional(), availability: z.any().optional() }).parse(req.body);
  res.json(await prisma.facultyProfile.upsert({ where: { userId: req.params.userId }, create: { userId: req.params.userId, ...d }, update: d }));
}));
r.post('/batches/:id/allocations', can('academics:manage'), ah(async (req, res) => {
  const d = z.object({ subjectId: z.string(), facultyId: z.string() }).parse(req.body);
  const a = await prisma.$transaction(async (tx) => {
    const a = await tx.facultyAllocation.create({ data: { batchId: req.params.id, ...d } });
    await audit(tx, req, 'CREATE', 'faculty_allocation', a.id, null, { batchId: req.params.id, ...d });
    return a;
  });
  res.status(201).json(a);
}));
r.delete('/allocations/:id', can('academics:manage'), ah(async (req, res) => {
  await prisma.$transaction(async (tx) => {
    const a = await tx.facultyAllocation.findUniqueOrThrow({ where: { id: req.params.id } });
    await tx.facultyAllocation.delete({ where: { id: a.id } });
    await audit(tx, req, 'DELETE', 'faculty_allocation', a.id, a, null);
  });
  res.json({ ok: true });
}));

// ── Timetable (ACD-06) with clash detection (FR-ACD-02) ──
const sessionSchema = z.object({
  batchId: z.string(),
  subjectId: z.string().optional().nullable(),
  facultyId: z.string().optional().nullable(),
  title: z.string().optional().nullable(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  room: z.string().optional().nullable(),
  repeatWeeks: z.number().int().min(1).max(52).default(1),
});

async function findClash(s: { batchId: string; facultyId?: string | null; room?: string | null; startsAt: Date; endsAt: Date }, exceptId?: string) {
  const or: any[] = [{ batchId: s.batchId }];
  if (s.facultyId) or.push({ facultyId: s.facultyId });
  if (s.room) or.push({ room: s.room });
  return prisma.timetableSession.findFirst({
    where: { cancelled: false, startsAt: { lt: s.endsAt }, endsAt: { gt: s.startsAt }, OR: or, NOT: exceptId ? { id: exceptId } : undefined },
    include: { batch: { select: { code: true } } },
  });
}

r.get('/timetable', can('academics:read', 'attendance:mark'), ah(async (req, res) => {
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 7 * 864e5);
  const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 14 * 864e5);
  const where: any = { startsAt: { gte: from, lt: to }, ...(req.query.batchId && { batchId: String(req.query.batchId) }) };
  if (req.query.mine === 'true' || (!userCan(req, 'academics:manage') && userCan(req, 'attendance:mark') && !userCan(req, 'students:read'))) where.facultyId = req.user!.id;
  const items = await prisma.timetableSession.findMany({ where, orderBy: { startsAt: 'asc' }, include: { batch: { select: { id: true, code: true, name: true } }, _count: { select: { attendance: true } } } });
  const subjects = await prisma.subject.findMany({ where: { id: { in: items.map((i) => i.subjectId!).filter(Boolean) } }, select: { id: true, name: true } });
  const fac = await prisma.user.findMany({ where: { id: { in: items.map((i) => i.facultyId!).filter(Boolean) } }, select: { id: true, name: true } });
  const sn = Object.fromEntries(subjects.map((s) => [s.id, s.name]));
  const fn = Object.fromEntries(fac.map((s) => [s.id, s.name]));
  res.json({ items: items.map((i) => ({ ...i, subjectName: i.subjectId ? sn[i.subjectId] : null, facultyName: i.facultyId ? fn[i.facultyId] : null })) });
}));

r.post('/timetable', can('academics:manage'), ah(async (req, res) => {
  const { repeatWeeks, ...d } = sessionSchema.parse(req.body);
  if (d.endsAt <= d.startsAt) throw badRequest('End time must be after start time.');
  const created: (typeof d)[] = [];
  for (let w = 0; w < repeatWeeks; w++) {
    const s = { ...d, startsAt: new Date(d.startsAt.getTime() + w * 7 * 864e5), endsAt: new Date(d.endsAt.getTime() + w * 7 * 864e5) };
    const clash = await findClash(s);
    if (clash) throw conflict(`Clash on ${s.startsAt.toDateString()}: overlaps with ${clash.batch.code} session ${clash.startsAt.toLocaleTimeString()}–${clash.endsAt.toLocaleTimeString()} (same batch, faculty or room).`);
    created.push(s);
  }
  const rows = await prisma.$transaction(async (tx) => {
    const rows = [];
    for (const s of created) rows.push(await tx.timetableSession.create({ data: s }));
    await audit(tx, req, 'CREATE', 'timetable_session', rows[0]?.id, null, { ...d, repeatWeeks, ids: rows.map((x) => x.id) });
    return rows;
  });
  res.status(201).json({ items: rows });
}));

r.patch('/timetable/:id', can('academics:manage'), ah(async (req, res) => {
  const d = sessionSchema.omit({ repeatWeeks: true }).partial().extend({ cancelled: z.boolean().optional() }).parse(req.body);
  const before = await prisma.timetableSession.findUniqueOrThrow({ where: { id: req.params.id } });
  const merged = { ...before, ...d };
  if (!merged.cancelled) {
    const clash = await findClash(merged, before.id);
    if (clash) throw conflict(`This change clashes with ${clash.batch.code} at ${clash.startsAt.toLocaleString()}.`);
  }
  const s = await prisma.$transaction(async (tx) => {
    const s = await tx.timetableSession.update({ where: { id: req.params.id }, data: d });
    await audit(tx, req, 'UPDATE', 'timetable_session', s.id, before, d);
    return s;
  });
  if (before.published) notifyBatch(s.batchId, 'timetable.changed', { title: s.title ?? 'Class', when: s.startsAt.toLocaleString('en-IN'), status: s.cancelled ? 'cancelled' : 'rescheduled' });
  res.json(s);
}));

r.post('/timetable/publish', can('academics:manage'), ah(async (req, res) => {
  const { batchId, from, to } = z.object({ batchId: z.string(), from: z.coerce.date(), to: z.coerce.date() }).parse(req.body);
  const u = await prisma.$transaction(async (tx) => {
    const u = await tx.timetableSession.updateMany({ where: { batchId, startsAt: { gte: from, lt: to }, published: false }, data: { published: true } });
    await audit(tx, req, 'PUBLISH', 'timetable', batchId, null, { from, to, count: u.count });
    return u;
  });
  notifyBatch(batchId, 'timetable.published', { from: from.toDateString(), to: to.toDateString() });
  res.json({ published: u.count });
}));

async function notifyBatch(batchId: string, key: string, vars: Record<string, unknown>) {
  const students = await prisma.student.findMany({ where: { batchId, status: { in: ['ADMITTED', 'ACTIVE'] } }, select: { userId: true, fullName: true, email: true, phone: true } });
  for (const s of students) notifyLater(key, { userId: s.userId, name: s.fullName, email: s.email, phone: s.phone }, { ...vars, name: s.fullName }, { channels: ['IN_APP'] });
}

// ── Attendance (ACD-07/08) ──
r.get('/sessions/:id/attendance', can('attendance:mark', 'academics:read'), ah(async (req, res) => {
  const s = await prisma.timetableSession.findUnique({ where: { id: req.params.id }, include: { batch: true, attendance: true } });
  const scope = await batchScopeIds(req.user!);
  if (!s || (scope && !scope.includes(s.batchId) && s.facultyId !== req.user!.id)) throw notFound(); // DSH-09 faculty: own batches
  const students = await prisma.student.findMany({ where: { batchId: s.batchId, status: { in: ['ADMITTED', 'ACTIVE', 'ON_HOLD'] } }, orderBy: { fullName: 'asc' }, select: { id: true, studentCode: true, fullName: true, photoUrl: true } });
  const m = Object.fromEntries(s.attendance.map((a) => [a.studentId, a.status]));
  res.json({ session: s, students: students.map((st) => ({ ...st, status: m[st.id] ?? null })) });
}));

r.post('/sessions/:id/attendance', can('attendance:mark'), ah(async (req, res) => {
  const { records } = z.object({ records: z.array(z.object({ studentId: z.string(), status: z.enum(['PRESENT', 'ABSENT', 'LATE', 'EXCUSED']) })).min(1) }).parse(req.body);
  const s = await prisma.timetableSession.findUniqueOrThrow({ where: { id: req.params.id }, include: { _count: { select: { attendance: true } } } });
  if (!userCan(req, 'academics:manage') && s.facultyId && s.facultyId !== req.user!.id) throw forbidden('You can only mark attendance for your own sessions.');
  if (s.startsAt > new Date(Date.now() + 15 * 60_000)) throw badRequest('Attendance can be marked only once the session has started.');
  const st = await getSettings();
  // Only students enrolled in this session's batch can be marked (object-level check).
  const enrolled = await prisma.student.count({ where: { id: { in: records.map((x) => x.studentId) }, batchId: s.batchId } });
  if (enrolled !== new Set(records.map((x) => x.studentId)).size) throw badRequest('Some students are not in this batch.');
  const windowClosed = Date.now() > s.endsAt.getTime() + st.academics.attendanceEditWindowHours * 3600_000;
  if (windowClosed) {
    // ACD-07: later edits need approval — for every role (no Super Administrator bypass).
    const reqs = await prisma.$transaction(async (tx) => {
      const out = [];
      for (const rec of records) out.push(await createApproval(tx, { type: 'ATTENDANCE_EDIT', entityType: 'attendance', entityId: `${s.id}:${rec.studentId}`, title: `Late attendance edit — session ${s.startsAt.toLocaleDateString('en-IN')}`, payload: { sessionId: s.id, ...rec }, requestedById: req.user!.id }));
      await audit(tx, req, 'REQUEST_ATTENDANCE_EDIT', 'attendance', s.id, null, { records, approvals: out.map((a) => a.id) });
      return out;
    });
    return res.status(202).json({ message: 'The attendance window has closed. Your changes were sent for approval.', approvals: reqs.length });
  }
  await prisma.$transaction(async (tx) => {
    const before = await tx.attendance.findMany({ where: { sessionId: s.id, studentId: { in: records.map((x) => x.studentId) } }, select: { studentId: true, status: true } });
    for (const rec of records) {
      await tx.attendance.upsert({
        where: { sessionId_studentId: { sessionId: s.id, studentId: rec.studentId } },
        create: { sessionId: s.id, studentId: rec.studentId, status: rec.status, markedById: req.user!.id },
        update: { status: rec.status, markedById: req.user!.id, markedAt: new Date() },
      });
    }
    await audit(tx, req, s._count.attendance ? 'UPDATE' : 'CREATE', 'attendance', s.id, before, records);
  });
  res.json({ ok: true, saved: records.length });
}));

/** Attendance percentage by student for a batch (ACD-08). */
export async function batchAttendance(batchId: string) {
  const sessions = await prisma.timetableSession.findMany({ where: { batchId, cancelled: false, startsAt: { lte: new Date() } }, select: { id: true } });
  const ids = sessions.map((s) => s.id);
  const rows = await prisma.attendance.groupBy({ by: ['studentId', 'status'], where: { sessionId: { in: ids } }, _count: true });
  const map: Record<string, { present: number; total: number }> = {};
  for (const r of rows) {
    map[r.studentId] ??= { present: 0, total: 0 };
    map[r.studentId].total += r._count;
    if (r.status === 'PRESENT' || r.status === 'LATE') map[r.studentId].present += r._count;
  }
  return map;
}

export async function studentAttendancePct(studentId: string) {
  const rows = await prisma.attendance.groupBy({ by: ['status'], where: { studentId }, _count: true });
  const total = rows.reduce((s, r) => s + r._count, 0);
  const present = rows.filter((r) => r.status === 'PRESENT' || r.status === 'LATE').reduce((s, r) => s + r._count, 0);
  return { total, present, percentage: total ? Math.round((present / total) * 1000) / 10 : null };
}

r.get('/batches/:id/attendance-summary', can('academics:read', 'attendance:mark'), ah(async (req, res) => {
  const scope = await batchScopeIds(req.user!);
  if (scope && !scope.includes(req.params.id)) throw notFound(); // faculty: own batches only
  const st = await getSettings();
  const map = await batchAttendance(req.params.id);
  const students = await prisma.student.findMany({ where: { batchId: req.params.id }, select: { id: true, studentCode: true, fullName: true } });
  res.json({
    threshold: st.academics.attendanceThreshold,
    items: students.map((s) => {
      const m = map[s.id] ?? { present: 0, total: 0 };
      const pct = m.total ? Math.round((m.present / m.total) * 1000) / 10 : null;
      return { ...s, ...m, percentage: pct, belowThreshold: pct != null && pct < st.academics.attendanceThreshold };
    }),
  });
}));

// ── Materials (ACD-10) ──
r.get('/materials', can('academics:read', 'materials:manage'), ah(async (req, res) => {
  const scope = await batchScopeIds(req.user!);
  res.json({ items: await prisma.material.findMany({ where: { ...(req.query.batchId && { batchId: String(req.query.batchId) }), ...(req.query.courseId && { courseId: String(req.query.courseId) }), ...(scope && { OR: [{ batchId: { in: scope } }, { uploadedById: req.user!.id }] }) }, orderBy: { createdAt: 'desc' } }) });
}));
r.post('/materials', can('materials:manage'), ah(async (req, res) => {
  const d = z.object({ courseId: z.string(), batchId: z.string().optional().nullable(), subjectId: z.string().optional().nullable(), title: z.string().min(2), type: z.enum(['PDF', 'DOC', 'LINK', 'VIDEO']), url: z.string().url() }).parse(req.body);
  if (d.batchId ? !(await canAccessBatch(req.user!, d.batchId)) : !userCan(req, 'academics:manage')) throw forbidden('You can only share materials with your own batches.');
  const m = await prisma.$transaction(async (tx) => {
    const m = await tx.material.create({ data: { ...d, uploadedById: req.user!.id } });
    await audit(tx, req, 'CREATE', 'material', m.id, null, d);
    return m;
  });
  res.status(201).json(m);
}));
r.delete('/materials/:id', can('materials:manage'), ah(async (req, res) => {
  const m = await prisma.material.findUnique({ where: { id: req.params.id } });
  if (!m || (!userCan(req, 'academics:manage') && m.uploadedById !== req.user!.id)) throw notFound();
  await prisma.$transaction(async (tx) => {
    await tx.material.delete({ where: { id: m.id } });
    await audit(tx, req, 'DELETE', 'material', m.id, m, null);
  });
  res.json({ ok: true });
}));

// ── Assignments (ACD-11) ──
r.get('/assignments', can('academics:read', 'materials:manage'), ah(async (req, res) => {
  const scope = await batchScopeIds(req.user!);
  res.json({ items: await prisma.assignment.findMany({ where: { ...(req.query.batchId && { batchId: String(req.query.batchId) }), ...(scope && { batchId: { in: scope } }) }, orderBy: { dueAt: 'desc' }, include: { _count: { select: { submissions: true } } } }) });
}));
r.post('/assignments', can('materials:manage'), ah(async (req, res) => {
  const d = z.object({ batchId: z.string(), subjectId: z.string().optional().nullable(), title: z.string().min(2), description: z.string().optional(), dueAt: z.coerce.date(), maxMarks: z.number().int().min(1).default(100) }).parse(req.body);
  if (!(await canAccessBatch(req.user!, d.batchId))) throw forbidden('You can only set assignments for your own batches.');
  const a = await prisma.$transaction(async (tx) => {
    const a = await tx.assignment.create({ data: { ...d, createdById: req.user!.id } });
    await audit(tx, req, 'CREATE', 'assignment', a.id, null, d);
    return a;
  });
  notifyBatch(d.batchId, 'assignment.created', { title: d.title, due: d.dueAt.toLocaleString('en-IN') });
  res.status(201).json(a);
}));
r.get('/assignments/:id/submissions', can('materials:manage'), ah(async (req, res) => {
  const asg = await prisma.assignment.findUnique({ where: { id: req.params.id } });
  if (!asg || !(await canAccessBatch(req.user!, asg.batchId))) throw notFound();
  const subs = await prisma.submission.findMany({ where: { assignmentId: req.params.id }, orderBy: { submittedAt: 'asc' } });
  const students = await prisma.student.findMany({ where: { id: { in: subs.map((s) => s.studentId) } }, select: { id: true, fullName: true, studentCode: true } });
  const m = Object.fromEntries(students.map((s) => [s.id, s]));
  res.json({ items: subs.map((s) => ({ ...s, student: m[s.studentId] })) });
}));
r.patch('/submissions/:id', can('materials:manage'), ah(async (req, res) => {
  const d = z.object({ marks: z.number().min(0), feedback: z.string().optional() }).parse(req.body);
  const sub = await prisma.submission.findUnique({ where: { id: req.params.id }, include: { assignment: true } });
  if (!sub || !(await canAccessBatch(req.user!, sub.assignment.batchId))) throw notFound();
  if (d.marks > sub.assignment.maxMarks) throw badRequest(`Marks cannot exceed ${sub.assignment.maxMarks}.`);
  const u = await prisma.$transaction(async (tx) => {
    const u = await tx.submission.update({ where: { id: sub.id }, data: d });
    await audit(tx, req, 'GRADE', 'submission', sub.id, { marks: sub.marks, feedback: sub.feedback }, d);
    return u;
  });
  res.json(u);
}));

export default r;
