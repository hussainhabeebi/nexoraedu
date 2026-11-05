/** Finance (SRS §12). Ledger is immutable — corrections are reversing entries only. */
import { Router } from 'express';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ah, badRequest, notFound, paging } from '../lib/http';
import { can, userCan } from '../lib/auth';
import { audit } from '../lib/audit';
import { getSettings } from '../lib/settings';
import { money, toCsv } from '../lib/util';
import { dayDiff, formatDate, toCalendarDate } from '../lib/caldate';
import { reconcile } from '../services/reconciliation';
import { createApproval } from '../services/approvals';
import { createFeePlan, ledger, recordPayment, studentBalance } from '../services/finance';
import { notifyLater } from '../services/notify';

const r = Router();

r.get('/students/:id/account', can('finance:read'), ah(async (req, res) => {
  const st = await prisma.student.findUnique({ where: { id: req.params.id }, include: { course: true, batch: true } });
  if (!st) throw notFound('Student not found');
  const [plans, invoices, payments, entries, discounts, refunds, balance] = await Promise.all([
    prisma.feePlan.findMany({ where: { studentId: st.id }, include: { installments: { orderBy: { seq: 'asc' } } } }),
    prisma.invoice.findMany({ where: { studentId: st.id }, orderBy: { number: 'asc' } }),
    prisma.payment.findMany({ where: { studentId: st.id }, orderBy: { paidAt: 'desc' }, include: { allocations: true } }),
    prisma.ledgerEntry.findMany({ where: { studentId: st.id }, orderBy: { createdAt: 'asc' } }),
    prisma.discount.findMany({ where: { studentId: st.id }, orderBy: { createdAt: 'desc' } }),
    prisma.refund.findMany({ where: { studentId: st.id }, orderBy: { createdAt: 'desc' } }),
    studentBalance(st.id),
  ]);
  let run = 0;
  const ledgerRows = entries.map((e) => ((run = money(run + Number(e.debit) - Number(e.credit))), { ...e, balance: run }));
  res.json({ student: st, plans, invoices, payments, ledger: ledgerRows, discounts, refunds, balance });
}));

r.post('/students/:id/fee-plan', can('finance:manage'), ah(async (req, res) => {
  // startDate: a calendar date "YYYY-MM-DD" in the academy time zone (preferred) or an ISO timestamp.
  const { installments, startDate } = z.object({ installments: z.number().int().min(1).max(24), startDate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.coerce.date()]).optional() }).parse(req.body);
  const st = await prisma.student.findUniqueOrThrow({ where: { id: req.params.id } });
  const enrollment = await prisma.enrollment.findFirst({ where: { studentId: st.id, courseId: st.courseId, status: { in: ['ACTIVE', 'ON_HOLD'] } } });
  if (!enrollment) throw badRequest('The student has no current enrollment in this course.');
  // One plan per enrollment (a course change opens a new enrollment, which may then get its own plan).
  const existing = await prisma.feePlan.count({ where: { studentId: st.id, OR: [{ enrollmentId: enrollment.id }, { enrollmentId: null, courseId: st.courseId }] } });
  if (existing) throw badRequest('A fee plan already exists for this enrollment. Use discounts or adjustments instead.');
  const plan = await prisma.$transaction(async (tx) => {
    const plan = await createFeePlan(tx, { studentId: st.id, courseId: st.courseId, installments, startDate, userId: req.user!.id });
    await audit(tx, req, 'CREATE', 'fee_plan', plan.id, null, { studentId: st.id, installments, startDate });
    return plan;
  });
  res.status(201).json(plan);
}));

// FIN-05/06 payments (API-04 idempotency key)
const paymentSchema = z.object({
  studentId: z.string(),
  amount: z.coerce.number().positive(),
  mode: z.enum(['CASH', 'CHEQUE', 'BANK_TRANSFER', 'UPI', 'CARD', 'ONLINE']),
  reference: z.string().optional(),
  payer: z.string().optional(),
  paidAt: z.coerce.date().optional(),
});
r.post('/payments', can('finance:collect'), ah(async (req, res) => {
  const d = paymentSchema.parse(req.body);
  if (['CHEQUE', 'BANK_TRANSFER', 'UPI', 'CARD'].includes(d.mode) && !d.reference) throw badRequest('Reference number is required for this payment mode.');
  const key = req.get('Idempotency-Key') || undefined;
  const p = await prisma.$transaction(async (tx) => {
    const before = key ? await tx.payment.findUnique({ where: { idempotencyKey: key }, select: { id: true } }) : null;
    const p = await recordPayment(tx, { ...d, idempotencyKey: key, userId: req.user!.id });
    if (!before) await audit(tx, req, 'CREATE', 'payment', p.id, null, { ...d, receiptNumber: p.receiptNumber });
    return p;
  });
  const st = await prisma.student.findUniqueOrThrow({ where: { id: d.studentId }, include: { lead: true } });
  const bal = await studentBalance(st.id);
  notifyLater('payment.received', { userId: st.userId, name: st.fullName, email: st.email, phone: st.phone, conversationId: st.lead?.chatwootConversationId }, { name: st.fullName, amount: money(p.amount).toFixed(2), receipt: p.receiptNumber, balance: bal.toFixed(2), date: p.paidAt.toLocaleDateString('en-IN') });
  res.status(201).json(p);
}));

r.get('/payments', can('finance:read'), ah(async (req, res) => {
  const { skip, take, page, pageSize } = paging(req.query);
  const where: any = {
    ...(req.query.mode && { mode: String(req.query.mode) }),
    ...(req.query.status && { status: String(req.query.status) }),
    ...(req.query.studentId && { studentId: String(req.query.studentId) }),
    ...((req.query.from || req.query.to) && { paidAt: { gte: req.query.from ? new Date(String(req.query.from)) : undefined, lte: req.query.to ? new Date(String(req.query.to) + 'T23:59:59') : undefined } }),
    ...(req.query.q && { OR: [{ receiptNumber: { contains: String(req.query.q), mode: 'insensitive' } }, { reference: { contains: String(req.query.q), mode: 'insensitive' } }, { student: { fullName: { contains: String(req.query.q), mode: 'insensitive' } } }] }),
  };
  const include = { student: { select: { id: true, fullName: true, studentCode: true } } };
  if (req.query.format === 'csv') {
    const all = await prisma.payment.findMany({ where, include, orderBy: { paidAt: 'desc' }, take: 10000 });
    await audit(prisma, req, 'EXPORT', 'payment', null, null, { format: 'csv', rows: all.length, filters: req.query }); // RPT-08
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="payments.csv"');
    return res.send(toCsv(all.map((p) => ({ receipt: p.receiptNumber, date: p.paidAt, student: p.student.fullName, studentId: p.student.studentCode, amount: Number(p.amount), mode: p.mode, reference: p.reference, status: p.status }))));
  }
  const [items, total, sum] = await Promise.all([
    prisma.payment.findMany({ where, include, skip, take, orderBy: { paidAt: 'desc' } }),
    prisma.payment.count({ where }),
    prisma.payment.aggregate({ where: { ...where, status: { not: 'CANCELLED' } }, _sum: { amount: true } }),
  ]);
  res.json({ items, total, page, pageSize, sum: Number(sum._sum.amount ?? 0) });
}));

export async function receiptPdf(paymentId: string, out: NodeJS.WritableStream) {
  const p = await prisma.payment.findUnique({ where: { id: paymentId }, include: { student: { include: { course: true, batch: true } }, allocations: { include: { installment: true } } } });
  if (!p) throw notFound('Payment not found');
  const s = await getSettings();
  const bal = await studentBalance(p.studentId);
  const doc = new PDFDocument({ size: 'A5', margin: 36 });
  doc.pipe(out);
  doc.fillColor('#4338ca').fontSize(18).text(s.academy.name, { continued: false });
  doc.fillColor('#555').fontSize(8).text(`${s.academy.address} · ${s.academy.phone} · ${s.academy.email}`);
  doc.moveDown();
  doc.fillColor('#111').fontSize(13).text(p.status === 'CANCELLED' ? 'FEE RECEIPT — CANCELLED' : 'FEE RECEIPT', { align: 'center' });
  doc.moveDown(0.5).fontSize(9);
  const row = (k: string, v: string) => doc.font('Helvetica-Bold').text(k, { continued: true, width: 120 }).font('Helvetica').text(`  ${v}`);
  row('Receipt No:', p.receiptNumber);
  row('Date:', formatDate(p.paidAt, (await getSettings()).academy.timeZone));
  row('Student:', `${p.student.fullName} (${p.student.studentCode})`);
  row('Course / Batch:', `${p.student.course.name}${p.student.batch ? ' / ' + p.student.batch.code : ''}`);
  row('Payment mode:', p.mode + (p.reference ? ` — Ref ${p.reference}` : ''));
  if (p.payer) row('Paid by:', p.payer);
  doc.moveDown();
  for (const a of p.allocations) row(`Installment #${a.installment.seq}:`, `${s.academy.currency} ${money(a.amount).toFixed(2)}`);
  doc.moveDown(0.5).fontSize(12).font('Helvetica-Bold').text(`Amount received: ${s.academy.currency} ${money(p.amount).toFixed(2)}`);
  doc.fontSize(9).font('Helvetica').text(`Balance outstanding: ${s.academy.currency} ${bal.toFixed(2)}`);
  doc.moveDown(2).fillColor('#888').fontSize(7).text('This is a computer-generated receipt and does not require a signature.', { align: 'center' });
  doc.end();
}

r.get('/payments/:id/receipt.pdf', can('finance:read'), ah(async (req, res) => {
  res.setHeader('Content-Type', 'application/pdf');
  await receiptPdf(req.params.id, res);
}));

// Staff cannot edit/delete a posted payment — only request cancellation (§12 rules)
r.post('/payments/:id/cancel-request', can('finance:collect'), ah(async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(5) }).parse(req.body);
  const p = await prisma.payment.findUniqueOrThrow({ where: { id: req.params.id }, include: { student: true } });
  if (p.status !== 'POSTED') throw badRequest(`Payment is already ${p.status.toLowerCase().replace('_', ' ')}.`);
  const a = await prisma.$transaction(async (tx) => {
    const moved = await tx.payment.updateMany({ where: { id: p.id, status: 'POSTED' }, data: { status: 'CANCEL_REQUESTED' } });
    if (moved.count !== 1) throw badRequest('This payment already has a cancellation request.');
    const a = await createApproval(tx, { type: 'PAYMENT_CANCELLATION', entityType: 'payment', entityId: p.id, title: `Cancel receipt ${p.receiptNumber} — ${p.student.fullName} (${money(p.amount)})`, payload: { reason }, amount: Number(p.amount), requestedById: req.user!.id });
    await audit(tx, req, 'CANCEL_REQUEST', 'payment', p.id, { status: 'POSTED' }, { status: 'CANCEL_REQUESTED', reason, approvalId: a.id });
    return a;
  });
  res.json({ approval: a });
}));

// FIN-09/10 discounts & scholarships
r.post('/discounts', can('finance:collect', 'finance:manage'), ah(async (req, res) => {
  const d = z.object({ studentId: z.string(), kind: z.enum(['FIXED', 'PERCENT', 'SCHOLARSHIP']), value: z.coerce.number().positive(), reason: z.string().min(3) }).parse(req.body);
  const plan = await prisma.feePlan.findFirst({ where: { studentId: d.studentId }, orderBy: { createdAt: 'desc' }, include: { installments: true } });
  if (!plan) throw badRequest('Student has no fee plan.');
  const unpaid = plan.installments.reduce((s, i) => s + Number(i.amount) - Number(i.paidAmount), 0);
  const amount = money(d.kind === 'PERCENT' ? (Number(plan.grossAmount) * Math.min(d.value, 100)) / 100 : d.value);
  if (amount > unpaid + 0.001) throw badRequest(`Discount (${amount}) cannot exceed the unpaid amount (${money(unpaid)}).`);
  const st = await prisma.student.findUniqueOrThrow({ where: { id: d.studentId } });
  const result = await prisma.$transaction(async (tx) => {
    const disc = await tx.discount.create({ data: { ...d, amount, feePlanId: plan.id, requestedById: req.user!.id } });
    // FIN-09 / decision 5 (2026-11-05): every discount and scholarship goes through the configured approval
    // workflow — there is no automatic exemption, for any role or amount.
    const appr = await createApproval(tx, {
      type: 'DISCOUNT', entityType: 'discount', entityId: disc.id,
      title: `${d.kind === 'SCHOLARSHIP' ? 'Scholarship' : 'Discount'} ${money(amount)} for ${st.fullName}: ${d.reason}`, payload: d, amount, requestedById: req.user!.id,
    });
    await audit(tx, req, 'CREATE', 'discount', disc.id, null, { ...d, amount, approvalId: appr.id });
    return { discount: disc, approval: appr };
  });
  res.status(201).json(result);
}));

// FIN-11 refunds
r.post('/refunds', can('finance:collect', 'finance:manage'), ah(async (req, res) => {
  const d = z.object({ studentId: z.string(), amount: z.coerce.number().positive(), reason: z.string().min(5) }).parse(req.body);
  const paid = await prisma.payment.aggregate({ where: { studentId: d.studentId, status: 'POSTED' }, _sum: { amount: true } });
  const refunded = await prisma.refund.aggregate({ where: { studentId: d.studentId, status: { in: ['APPROVED', 'PAID', 'PENDING_APPROVAL'] } }, _sum: { amount: true } });
  const max = money(Number(paid._sum.amount ?? 0) - Number(refunded._sum.amount ?? 0));
  if (d.amount > max) throw badRequest(`Refund cannot exceed the refundable amount (${max}).`);
  const st = await prisma.student.findUniqueOrThrow({ where: { id: d.studentId } });
  const out = await prisma.$transaction(async (tx) => {
    const rf = await tx.refund.create({ data: { ...d, requestedById: req.user!.id } });
    const a = await createApproval(tx, { type: 'REFUND', entityType: 'refund', entityId: rf.id, title: `Refund ${money(d.amount)} to ${st.fullName}: ${d.reason}`, payload: d, amount: d.amount, requestedById: req.user!.id });
    await audit(tx, req, 'CREATE', 'refund', rf.id, null, { ...d, approvalId: a.id });
    return { refund: rf, approval: a };
  });
  res.status(201).json(out);
}));
r.post('/refunds/:id/pay', can('finance:manage'), ah(async (req, res) => {
  const { reference } = z.object({ reference: z.string().min(2) }).parse(req.body);
  const rf = await prisma.refund.findUniqueOrThrow({ where: { id: req.params.id } });
  if (rf.status !== 'APPROVED') throw badRequest('Only approved refunds can be paid.');
  await prisma.$transaction(async (tx) => {
    // Conditional transition prevents paying the same refund twice under concurrency.
    const paid = await tx.refund.updateMany({ where: { id: rf.id, status: 'APPROVED' }, data: { status: 'PAID', reference, paidAt: new Date() } });
    if (paid.count !== 1) throw badRequest('Only approved refunds can be paid.');
    await ledger(tx, { studentId: rf.studentId, type: 'REFUND', debit: Number(rf.amount), refType: 'refund', refId: rf.id, narration: `Refund paid (ref ${reference})`, userId: req.user!.id });
    await tx.studentHistory.create({ data: { studentId: rf.studentId, type: 'FEE', message: `Refund of ${money(rf.amount)} paid`, userId: req.user!.id } });
    await audit(tx, req, 'PAY', 'refund', rf.id, { status: 'APPROVED' }, { status: 'PAID', reference });
  });
  res.json({ ok: true });
}));
r.get('/refunds', can('finance:read'), ah(async (req, res) => {
  const items = await prisma.refund.findMany({ where: req.query.status ? { status: String(req.query.status) } : {}, orderBy: { createdAt: 'desc' }, take: 200 });
  const st = await prisma.student.findMany({ where: { id: { in: items.map((i) => i.studentId) } }, select: { id: true, fullName: true, studentCode: true } });
  const m = Object.fromEntries(st.map((s) => [s.id, s]));
  res.json({ items: items.map((i) => ({ ...i, student: m[i.studentId] })) });
}));

// FIN-07/15 outstanding with ageing buckets
r.get('/outstanding', can('finance:read'), ah(async (req, res) => {
  const tz = (await getSettings()).academy.timeZone;
  const todayCal = toCalendarDate(new Date(), tz);
  const insts = await prisma.installment.findMany({
    where: { status: { not: 'PAID' }, feePlan: { student: { status: { notIn: ['WITHDRAWN', 'TERMINATED'] }, ...(req.query.courseId && { courseId: String(req.query.courseId) }), ...(req.query.batchId && { batchId: String(req.query.batchId) }) } } },
    include: { feePlan: { include: { student: { select: { id: true, fullName: true, studentCode: true, phone: true, batch: { select: { code: true } }, course: { select: { name: true } } } } } } },
    orderBy: { dueDate: 'asc' },
  });
  const byStudent = new Map<string, any>();
  const buckets = { notDue: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90p: 0 };
  for (const i of insts) {
    const open = money(Number(i.amount) - Number(i.paidAmount));
    if (open <= 0) continue;
    // FIN-07 ageing in whole calendar days in the academy zone: due today = not yet overdue; due yesterday = 1 day.
    const days = dayDiff(toCalendarDate(i.dueDate, tz), todayCal);
    const b = days <= 0 ? 'notDue' : days <= 30 ? 'd0_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90p';
    buckets[b] = money(buckets[b] + open);
    const st = i.feePlan.student;
    const row = byStudent.get(st.id) ?? { studentId: st.id, studentCode: st.studentCode, name: st.fullName, phone: st.phone, course: st.course.name, batch: st.batch?.code, due: 0, overdue: 0, oldestDue: i.dueDate, maxDaysOverdue: 0 };
    row.due = money(row.due + open);
    if (days > 0) row.overdue = money(row.overdue + open);
    row.maxDaysOverdue = Math.max(row.maxDaysOverdue, days);
    byStudent.set(st.id, row);
  }
  let items = [...byStudent.values()].sort((a, b) => b.overdue - a.overdue);
  if (req.query.onlyOverdue === 'true') items = items.filter((i) => i.overdue > 0);
  if (req.query.format === 'csv') {
    await audit(prisma, req, 'EXPORT', 'outstanding', null, null, { format: 'csv', rows: items.length, filters: req.query }); // RPT-08
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="outstanding.csv"');
    return res.send(toCsv(items));
  }
  res.json({ items, buckets, total: money(items.reduce((s, i) => s + i.due, 0)) });
}));

// FIN-14 collections
r.get('/collections', can('finance:read'), ah(async (req, res) => {
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const to = req.query.to ? new Date(String(req.query.to) + 'T23:59:59') : new Date();
  const where = { status: { not: 'CANCELLED' }, paidAt: { gte: from, lte: to } };
  const [byMode, rows] = await Promise.all([
    prisma.payment.groupBy({ by: ['mode'], where, _sum: { amount: true }, _count: true }),
    prisma.$queryRaw<{ day: Date; amount: number; count: bigint }[]>`
      SELECT date_trunc('day', "paidAt") AS day, SUM(amount)::float AS amount, COUNT(*) AS count FROM payments
      WHERE status <> 'CANCELLED' AND "paidAt" BETWEEN ${from} AND ${to} GROUP BY 1 ORDER BY 1`,
  ]);
  const byCourse = await prisma.$queryRaw<{ course: string; amount: number }[]>`
    SELECT c.name AS course, SUM(p.amount)::float AS amount FROM payments p JOIN students s ON s.id = p."studentId" JOIN courses c ON c.id = s."courseId"
    WHERE p.status <> 'CANCELLED' AND p."paidAt" BETWEEN ${from} AND ${to} GROUP BY 1 ORDER BY 2 DESC`;
  const byCollector = await prisma.$queryRaw<{ collector: string; amount: number }[]>`
    SELECT COALESCE(u.name, 'Online') AS collector, SUM(p.amount)::float AS amount FROM payments p LEFT JOIN users u ON u.id = p."recordedById"
    WHERE p.status <> 'CANCELLED' AND p."paidAt" BETWEEN ${from} AND ${to} GROUP BY 1 ORDER BY 2 DESC`;
  res.json({
    from, to,
    total: money(byMode.reduce((s, m) => s + Number(m._sum.amount ?? 0), 0)),
    byMode: byMode.map((m) => ({ mode: m.mode, amount: Number(m._sum.amount ?? 0), count: m._count })),
    byDay: rows.map((r) => ({ day: r.day, amount: r.amount, count: Number(r.count) })),
    byCourse, byCollector,
  });
}));

// FIN-08 manual reminder run (also scheduled in jobs)
r.post('/reminders/run', can('finance:collect'), ah(async (_req, res) => {
  const { runFeeReminders } = await import('../jobs/scheduler');
  res.json({ sent: await runFeeReminders(true) });
}));

// FIN-13 / RPT-06 reconciliation: read-only consistency check (never modifies records).
r.get('/reconciliation', can('finance:manage', 'audit:read'), ah(async (req, res) => {
  const studentId = req.query.studentId ? String(req.query.studentId) : undefined;
  const out = await reconcile({ studentId });
  await audit(prisma, req, 'REPORT_RUN', 'report', 'reconciliation', null, { studentId, ok: out.ok, bySeverity: out.bySeverity });
  res.json(out);
}));

export default r;
