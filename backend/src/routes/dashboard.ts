/** Role-specific dashboards (SRS §16) and report catalogue (SRS §15). */
import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { audit } from '../lib/audit';
import { batchScopeIds } from '../lib/policy';
import { ah, badRequest, forbidden } from '../lib/http';
import { can, userCan } from '../lib/auth';
import { getSettings } from '../lib/settings';
import { money, toCsv } from '../lib/util';
import { canActOn } from '../services/approvals';

const r = Router();
const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfMonth = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), 1);

async function sumPayments(from: Date, to = new Date()) {
  const a = await prisma.payment.aggregate({ where: { status: { not: 'CANCELLED' }, paidAt: { gte: from, lte: to } }, _sum: { amount: true } });
  return Number(a._sum.amount ?? 0);
}
async function totalOutstanding() {
  const a = await prisma.ledgerEntry.aggregate({ _sum: { debit: true, credit: true } });
  return money(Number(a._sum.debit ?? 0) - Number(a._sum.credit ?? 0));
}
async function monthlyTrend(months = 6) {
  const from = new Date(new Date().getFullYear(), new Date().getMonth() - (months - 1), 1);
  const [adm, rev, leads] = await Promise.all([
    prisma.$queryRaw<{ m: Date; c: bigint }[]>`SELECT date_trunc('month', "admissionDate") m, COUNT(*) c FROM students WHERE "admissionDate" >= ${from} GROUP BY 1`,
    prisma.$queryRaw<{ m: Date; s: number }[]>`SELECT date_trunc('month', "paidAt") m, SUM(amount)::float s FROM payments WHERE status <> 'CANCELLED' AND "paidAt" >= ${from} GROUP BY 1`,
    prisma.$queryRaw<{ m: Date; c: bigint }[]>`SELECT date_trunc('month', "createdAt") m, COUNT(*) c FROM leads WHERE "createdAt" >= ${from} GROUP BY 1`,
  ]);
  const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return Array.from({ length: months }, (_, i) => {
    const d = new Date(from.getFullYear(), from.getMonth() + i, 1);
    const k = key(d);
    return {
      month: d.toLocaleString('en', { month: 'short' }),
      admissions: Number(adm.find((x) => key(new Date(x.m)) === k)?.c ?? 0),
      revenue: rev.find((x) => key(new Date(x.m)) === k)?.s ?? 0,
      leads: Number(leads.find((x) => key(new Date(x.m)) === k)?.c ?? 0),
    };
  });
}

r.get('/', ah(async (req, res) => {
  const u = req.user!;
  const roles = u.roles;
  const out: Record<string, unknown> = {};
  const isAll = u.perms.includes('*');
  const today = startOfDay();
  const tomorrow = new Date(today.getTime() + 864e5);
  const s = await getSettings();

  if (isAll || roles.includes('management')) {
    const ninety = new Date(Date.now() - 90 * 864e5);
    const [admissions, revenue, outstanding, active, leads90, admitted90, att, results] = await Promise.all([
      prisma.student.count({ where: { admissionDate: { gte: startOfMonth() } } }),
      sumPayments(startOfMonth()),
      totalOutstanding(),
      prisma.student.count({ where: { status: { in: ['ACTIVE', 'ADMITTED'] } } }),
      prisma.lead.count({ where: { createdAt: { gte: ninety } } }),
      prisma.lead.count({ where: { createdAt: { gte: ninety }, status: 'ADMITTED' } }),
      prisma.attendance.groupBy({ by: ['status'], where: { markedAt: { gte: new Date(Date.now() - 30 * 864e5) } }, _count: true }),
      prisma.result.groupBy({ by: ['passed'], where: { exam: { resultsPublished: true } }, _count: true }),
    ]);
    const attTotal = att.reduce((a, x) => a + x._count, 0);
    const attPresent = att.filter((x) => x.status !== 'ABSENT').reduce((a, x) => a + x._count, 0);
    const resTotal = results.reduce((a, x) => a + x._count, 0);
    out.management = {
      kpis: {
        admissionsThisMonth: admissions, revenueThisMonth: revenue, outstanding, activeStudents: active,
        conversionRate: leads90 ? Math.round((admitted90 / leads90) * 1000) / 10 : 0,
        attendanceAvg: attTotal ? Math.round((attPresent / attTotal) * 1000) / 10 : null,
        passRate: resTotal ? Math.round(((results.find((x) => x.passed)?._count ?? 0) / resTotal) * 1000) / 10 : null,
      },
      trend: await monthlyTrend(),
    };
  }

  if (isAll || roles.includes('admin')) {
    const [newRegs, pendingDocs, pendingApprovals, inactiveUsers, pendingApps] = await Promise.all([
      prisma.student.count({ where: { createdAt: { gte: new Date(Date.now() - 7 * 864e5) } } }),
      prisma.document.count({ where: { status: 'PENDING' } }),
      prisma.approvalRequest.count({ where: { status: 'PENDING' } }),
      prisma.user.count({ where: { isActive: true, OR: [{ lastLoginAt: null }, { lastLoginAt: { lt: new Date(Date.now() - 30 * 864e5) } }], roles: { none: { role: { key: 'student' } } } } }),
      prisma.application.count({ where: { status: { in: ['SUBMITTED', 'UNDER_REVIEW'] } } }),
    ]);
    const failedIntegrations = await prisma.notificationLog.count({ where: { status: 'FAILED', createdAt: { gte: new Date(Date.now() - 864e5) } } });
    out.admin = { kpis: { newRegistrations7d: newRegs, pendingDocuments: pendingDocs, pendingApprovals, inactiveUsers, pendingApplications: pendingApps, failedNotifications24h: failedIntegrations } };
  }

  if (userCan(req, 'leads:read')) {
    const own = userCan(req, 'leads:read_all') ? {} : { ownerId: u.id };
    const [newToday, due, overdue, pipeline, sources, funnelAdmitted] = await Promise.all([
      prisma.lead.count({ where: { ...own, createdAt: { gte: today } } }),
      prisma.followUp.count({ where: { status: 'PENDING', dueAt: { gte: today, lt: tomorrow }, ...(own.ownerId && { userId: u.id }) } }),
      prisma.followUp.count({ where: { status: 'PENDING', dueAt: { lt: new Date() }, ...(own.ownerId && { userId: u.id }) } }),
      prisma.lead.groupBy({ by: ['status'], where: own, _count: true }),
      prisma.lead.groupBy({ by: ['source'], where: own, _count: true }),
      prisma.lead.groupBy({ by: ['source'], where: { ...own, status: 'ADMITTED' }, _count: true }),
    ]);
    const sales: any = {
      kpis: { newLeadsToday: newToday, followUpsDueToday: due, followUpsOverdue: overdue },
      pipeline: Object.fromEntries(pipeline.map((p) => [p.status, p._count])),
      sources: sources.map((x) => ({ source: x.source, leads: x._count, admitted: funnelAdmitted.find((f) => f.source === x.source)?._count ?? 0 })).sort((a, b) => b.leads - a.leads),
    };
    if (userCan(req, 'leads:read_all')) {
      const board = await prisma.$queryRaw<{ id: string; name: string; leads: bigint; admitted: bigint; activities: bigint }[]>`
        SELECT u.id, u.name,
          (SELECT COUNT(*) FROM leads l WHERE l."ownerId" = u.id) leads,
          (SELECT COUNT(*) FROM leads l WHERE l."ownerId" = u.id AND l.status = 'ADMITTED') admitted,
          (SELECT COUNT(*) FROM lead_activities a WHERE a."userId" = u.id AND a."createdAt" > now() - interval '30 days') activities
        FROM users u JOIN user_roles ur ON ur."userId" = u.id JOIN roles r ON r.id = ur."roleId"
        WHERE r.key = 'counselor' AND u."isActive" ORDER BY admitted DESC, leads DESC`;
      sales.leaderboard = board.map((b) => ({ ...b, leads: Number(b.leads), admitted: Number(b.admitted), activities: Number(b.activities), conversion: Number(b.leads) ? Math.round((Number(b.admitted) / Number(b.leads)) * 1000) / 10 : 0 }));
    }
    out.sales = sales;
  }

  if (userCan(req, 'finance:read')) {
    const [todayCol, monthCol, upcoming, pendingDiscounts, pendingRefunds, overdueInst] = await Promise.all([
      sumPayments(today),
      sumPayments(startOfMonth()),
      prisma.installment.findMany({ where: { status: { not: 'PAID' }, dueDate: { gte: today, lt: new Date(Date.now() + 7 * 864e5) } }, include: { feePlan: { include: { student: { select: { id: true, fullName: true, studentCode: true } } } } }, orderBy: { dueDate: 'asc' }, take: 10 }),
      prisma.discount.count({ where: { status: 'PENDING_APPROVAL' } }),
      prisma.refund.count({ where: { status: { in: ['PENDING_APPROVAL', 'APPROVED'] } } }),
      prisma.installment.findMany({ where: { status: { not: 'PAID' }, dueDate: { lt: today } }, select: { amount: true, paidAmount: true, dueDate: true } }),
    ]);
    const ageing = { d0_30: 0, d31_60: 0, d61_90: 0, d90p: 0 };
    for (const i of overdueInst) {
      const days = (Date.now() - i.dueDate.getTime()) / 864e5;
      const k = days <= 30 ? 'd0_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90p';
      ageing[k] = money(ageing[k] + Number(i.amount) - Number(i.paidAmount));
    }
    out.finance = {
      kpis: { todayCollection: todayCol, monthCollection: monthCol, monthTarget: s.finance.monthlyTarget, pendingDiscounts, pendingRefunds, overdueTotal: money(Object.values(ageing).reduce((a, b) => a + b, 0)) },
      ageing,
      upcoming: upcoming.map((i) => ({ id: i.id, due: i.dueDate, amount: money(Number(i.amount) - Number(i.paidAmount)), student: i.feePlan.student })),
    };
  }

  if (userCan(req, 'academics:manage')) {
    const [running, todaySessions, batches] = await Promise.all([
      prisma.batch.count({ where: { status: 'RUNNING' } }),
      prisma.timetableSession.count({ where: { startsAt: { gte: today, lt: tomorrow }, cancelled: false } }),
      prisma.batch.findMany({ where: { status: 'RUNNING' }, select: { id: true, code: true } }),
    ]);
    const byBatch = await prisma.$queryRaw<{ code: string; pct: number }[]>`
      SELECT b.code, ROUND(100.0 * SUM(CASE WHEN a.status IN ('PRESENT','LATE') THEN 1 ELSE 0 END) / NULLIF(COUNT(a.id),0), 1)::float pct
      FROM batches b JOIN timetable_sessions t ON t."batchId" = b.id JOIN attendance a ON a."sessionId" = t.id
      WHERE b.status = 'RUNNING' GROUP BY b.code ORDER BY b.code`;
    const low = await prisma.$queryRaw<{ id: string; name: string; code: string; pct: number }[]>`
      SELECT s.id, s."fullName" name, s."studentCode" code, ROUND(100.0 * SUM(CASE WHEN a.status IN ('PRESENT','LATE') THEN 1 ELSE 0 END) / COUNT(a.id), 1)::float pct
      FROM students s JOIN attendance a ON a."studentId" = s.id WHERE s.status IN ('ACTIVE','ADMITTED')
      GROUP BY s.id HAVING COUNT(a.id) >= 3 AND 100.0 * SUM(CASE WHEN a.status IN ('PRESENT','LATE') THEN 1 ELSE 0 END) / COUNT(a.id) < ${s.academics.attendanceThreshold}
      ORDER BY pct ASC LIMIT 10`;
    const workload = await prisma.$queryRaw<{ name: string; sessions: bigint }[]>`
      SELECT u.name, COUNT(t.id) sessions FROM timetable_sessions t JOIN users u ON u.id = t."facultyId"
      WHERE t."startsAt" >= date_trunc('week', now()) AND t."startsAt" < date_trunc('week', now()) + interval '7 days' AND NOT t.cancelled GROUP BY u.name ORDER BY 2 DESC`;
    out.academic = { kpis: { runningBatches: running, todaySessions, batches: batches.length }, attendanceByBatch: byBatch, lowAttendance: low, facultyWorkload: workload.map((w) => ({ name: w.name, sessions: Number(w.sessions) })) };
  }

  if (userCan(req, 'attendance:mark')) {
    const [mine, unmarked, toGrade] = await Promise.all([
      prisma.timetableSession.findMany({ where: { facultyId: u.id, startsAt: { gte: today, lt: tomorrow }, cancelled: false }, include: { batch: { select: { code: true } } }, orderBy: { startsAt: 'asc' } }),
      prisma.timetableSession.findMany({ where: { facultyId: u.id, cancelled: false, endsAt: { lt: new Date(), gt: new Date(Date.now() - 7 * 864e5) }, attendance: { none: {} } }, include: { batch: { select: { code: true } } }, orderBy: { startsAt: 'desc' } }),
      prisma.submission.count({ where: { marks: null, assignment: { createdById: u.id } } }),
    ]);
    out.faculty = { today: mine, attendanceToMark: unmarked, submissionsToGrade: toGrade };
  }

  if (userCan(req, 'exams:manage')) {
    const [upcoming, pendingEval, toPublish] = await Promise.all([
      prisma.exam.findMany({ where: { startAt: { gte: new Date() } }, orderBy: { startAt: 'asc' }, take: 5, include: { _count: { select: { assignments: true } } } }),
      prisma.examAttempt.count({ where: { status: 'SUBMITTED' } }),
      prisma.exam.count({ where: { resultsPublished: false, results: { some: {} } } }),
    ]);
    out.exams = { upcoming, kpis: { pendingEvaluations: pendingEval, resultsToPublish: toPublish } };
  }

  if (userCan(req, 'approvals:act')) {
    const pending = await prisma.approvalRequest.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 200 });
    out.approvals = { awaitingMe: pending.filter((p) => canActOn(u, p)).slice(0, 8) };
  }
  res.json(out);
}));

// ── Reports (FR-RPT-01/02) ──
/** batchIds: null = unrestricted; otherwise only these batches (faculty, DSH-09 / RPT-02). */
type ReportFn = (q: { from: Date; to: Date; batchIds: string[] | null; [k: string]: any }) => Promise<Record<string, unknown>[]>;
const inBatches = (col: string, ids: string[] | null) => (ids ? Prisma.sql`AND ${Prisma.raw(col)} = ANY(${ids})` : Prisma.empty);
const REPORTS: Record<string, { title: string; perm: string[]; run: ReportFn }> = {
  students: {
    title: 'Student list', perm: ['students:read'],
    run: async ({ from, to }) => (await prisma.student.findMany({ where: { admissionDate: { gte: from, lte: to } }, include: { course: true, batch: true }, orderBy: { studentCode: 'asc' } }))
      .map((s) => ({ ID: s.studentCode, Name: s.fullName, Phone: s.phone, Email: s.email, Course: s.course.name, Batch: s.batch?.code ?? '', Status: s.status, Admitted: s.admissionDate.toISOString().slice(0, 10) })),
  },
  'batch-strength': {
    title: 'Course / batch strength', perm: ['students:read', 'academics:read'],
    run: async () => (await prisma.batch.findMany({ include: { course: true, _count: { select: { students: true } } }, orderBy: { code: 'asc' } }))
      .map((b) => ({ Batch: b.code, Course: b.course.name, Status: b.status, Capacity: b.capacity, Enrolled: b._count.students, Utilisation: `${Math.round((b._count.students / b.capacity) * 100)}%` })),
  },
  admissions: {
    title: 'Admissions by course & source', perm: ['reports:read'],
    run: async ({ from, to }) => prisma.$queryRaw`
      SELECT c.name "Course", COALESCE(l.source, 'direct') "Source", COUNT(*)::int "Admissions"
      FROM students s JOIN courses c ON c.id = s."courseId" LEFT JOIN leads l ON l."studentId" = s.id
      WHERE s."admissionDate" BETWEEN ${from} AND ${to} GROUP BY 1, 2 ORDER BY 3 DESC`,
  },
  leads: {
    title: 'Leads by source / status / owner', perm: ['leads:read_all'],
    run: async ({ from, to }) => prisma.$queryRaw`
      SELECT l.source "Source", l.status::text "Status", COALESCE(u.name, 'Unassigned') "Owner", COUNT(*)::int "Leads",
        ROUND(AVG(EXTRACT(EPOCH FROM (now() - l."createdAt")) / 86400))::int "Avg age (days)"
      FROM leads l LEFT JOIN users u ON u.id = l."ownerId" WHERE l."createdAt" BETWEEN ${from} AND ${to} GROUP BY 1, 2, 3 ORDER BY 4 DESC`,
  },
  funnel: {
    title: 'Conversion funnel', perm: ['leads:read_all'],
    run: async ({ from, to }) => {
      const rows = await prisma.lead.groupBy({ by: ['status'], where: { createdAt: { gte: from, lte: to } }, _count: true });
      const order = ['NEW', 'CONTACTED', 'INTERESTED', 'COUNSELLED', 'APPLICATION', 'ADMITTED'];
      const total = rows.reduce((s, r) => s + r._count, 0);
      return order.map((st, i) => {
        const reached = rows.filter((r) => order.indexOf(r.status) >= i).reduce((s, r) => s + r._count, 0);
        return { Stage: st, Reached: reached, 'Of total': total ? `${Math.round((reached / total) * 100)}%` : '0%' };
      });
    },
  },
  'lost-reasons': {
    title: 'Lost-reason analysis', perm: ['leads:read_all'],
    run: async ({ from, to }) => prisma.$queryRaw`SELECT status::text "Status", COALESCE("closeReason", '—') "Reason", COUNT(*)::int "Leads" FROM leads WHERE status IN ('LOST','JUNK','NOT_INTERESTED') AND "updatedAt" BETWEEN ${from} AND ${to} GROUP BY 1, 2 ORDER BY 3 DESC`,
  },
  counselors: {
    title: 'Counselor performance', perm: ['leads:read_all'],
    run: async ({ from, to }) => prisma.$queryRaw`
      SELECT u.name "Counselor",
        (SELECT COUNT(*)::int FROM leads l WHERE l."ownerId" = u.id AND l."createdAt" BETWEEN ${from} AND ${to}) "Leads",
        (SELECT COUNT(*)::int FROM lead_activities a WHERE a."userId" = u.id AND a.type IN ('CALL','WHATSAPP','EMAIL','SMS','MEETING') AND a."createdAt" BETWEEN ${from} AND ${to}) "Contacts",
        (SELECT COUNT(*)::int FROM follow_ups f WHERE f."userId" = u.id AND f.status = 'DONE' AND f."dueAt" BETWEEN ${from} AND ${to}) "Follow-ups done",
        (SELECT COUNT(*)::int FROM follow_ups f WHERE f."userId" = u.id AND f."dueAt" BETWEEN ${from} AND ${to} AND f."dueAt" < now()) "Follow-ups due",
        (SELECT COUNT(*)::int FROM leads l WHERE l."ownerId" = u.id AND l.status = 'ADMITTED' AND l."updatedAt" BETWEEN ${from} AND ${to}) "Admissions"
      FROM users u JOIN user_roles ur ON ur."userId" = u.id JOIN roles r ON r.id = ur."roleId" WHERE r.key = 'counselor' ORDER BY 6 DESC`,
  },
  collections: {
    title: 'Fee collection', perm: ['finance:read'],
    run: async ({ from, to }) => (await prisma.payment.findMany({ where: { paidAt: { gte: from, lte: to } }, include: { student: true }, orderBy: { paidAt: 'asc' } }))
      .map((p) => ({ Receipt: p.receiptNumber, Date: p.paidAt.toISOString().slice(0, 10), Student: p.student.fullName, ID: p.student.studentCode, Mode: p.mode, Reference: p.reference ?? '', Amount: Number(p.amount), Status: p.status })),
  },
  'discounts-refunds': {
    title: 'Discounts, scholarships & refunds', perm: ['finance:read'],
    run: async ({ from, to }) => prisma.$queryRaw`
      SELECT 'Discount' "Kind", d.kind "Type", s."fullName" "Student", d.amount::float "Amount", d.reason "Reason", d.status "Status", d."createdAt"::date "Date" FROM discounts d JOIN students s ON s.id = d."studentId" WHERE d."createdAt" BETWEEN ${from} AND ${to}
      UNION ALL
      SELECT 'Refund', '-', s."fullName", r.amount::float, r.reason, r.status, r."createdAt"::date FROM refunds r JOIN students s ON s.id = r."studentId" WHERE r."createdAt" BETWEEN ${from} AND ${to} ORDER BY 7`,
  },
  ledger: {
    title: 'Financial ledger', perm: ['finance:read'],
    run: async ({ from, to }) => prisma.$queryRaw`
      SELECT e."createdAt"::date "Date", s."studentCode" "ID", s."fullName" "Student", e.type "Type", e.narration "Narration", e.debit::float "Debit", e.credit::float "Credit"
      FROM ledger_entries e JOIN students s ON s.id = e."studentId" WHERE e."createdAt" BETWEEN ${from} AND ${to} ORDER BY e."createdAt"`,
  },
  attendance: {
    title: 'Attendance by student', perm: ['academics:read'],
    run: async ({ from, to, batchIds }) => prisma.$queryRaw`
      SELECT b.code "Batch", s."studentCode" "ID", s."fullName" "Student", COUNT(a.id)::int "Sessions",
        SUM(CASE WHEN a.status IN ('PRESENT','LATE') THEN 1 ELSE 0 END)::int "Attended",
        ROUND(100.0 * SUM(CASE WHEN a.status IN ('PRESENT','LATE') THEN 1 ELSE 0 END) / NULLIF(COUNT(a.id), 0), 1)::float "%"
      FROM attendance a JOIN students s ON s.id = a."studentId" JOIN timetable_sessions t ON t.id = a."sessionId" JOIN batches b ON b.id = t."batchId"
      WHERE t."startsAt" BETWEEN ${from} AND ${to} ${inBatches('b.id', batchIds)} GROUP BY 1, 2, 3 ORDER BY 1, 6`,
  },
  'exam-results': {
    title: 'Examination results', perm: ['exams:read'],
    run: async ({ from, to, batchIds }) => prisma.$queryRaw`
      SELECT e.title "Exam", e.type "Type", s."studentCode" "ID", s."fullName" "Student", r.marks "Marks", e."totalMarks" "Total", r.percentage "%", r.grade "Grade", CASE WHEN r.passed THEN 'Pass' ELSE 'Fail' END "Result", CASE WHEN e."resultsPublished" THEN 'Yes' ELSE 'No' END "Published"
      FROM results r JOIN exams e ON e.id = r."examId" JOIN students s ON s.id = r."studentId" WHERE e."startAt" BETWEEN ${from} AND ${to} ${inBatches('e."batchId"', batchIds)} ORDER BY 1, 5 DESC`,
  },
};

r.get('/reports', can('reports:read'), ah(async (req, res) => {
  res.json({ items: Object.entries(REPORTS).filter(([, v]) => v.perm.some((p) => userCan(req, p))).map(([key, v]) => ({ key, title: v.title })) });
}));
r.get('/reports/:key', can('reports:read'), ah(async (req, res) => {
  const rep = REPORTS[req.params.key];
  if (!rep) throw badRequest('Unknown report');
  if (!rep.perm.some((p) => userCan(req, p))) throw forbidden('You do not have access to this report.'); // 403, not 400
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 30 * 864e5);
  const to = req.query.to ? new Date(String(req.query.to) + 'T23:59:59') : new Date();
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw badRequest('Invalid date range.');
  const rows = await rep.run({ from, to, batchIds: await batchScopeIds(req.user!) });
  // RPT-08: every report run and export is audit-logged (filters + row count, never the data itself).
  await audit(prisma, req, req.query.format === 'csv' ? 'REPORT_EXPORT' : 'REPORT_RUN', 'report', req.params.key, null, { from, to, rows: rows.length, format: req.query.format ?? 'json' });
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.key}-${from.toISOString().slice(0, 10)}.csv"`);
    return res.send(toCsv(rows));
  }
  res.json({ title: rep.title, from, to, rows });
}));

export default r;
