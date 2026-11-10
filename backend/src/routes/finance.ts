/** Finance (SRS §12). Ledger is immutable — corrections are reversing entries only. */
import { Router, type Request } from 'express';
import PDFDocument from '../lib/pdf';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ah, badRequest, forbidden, notFound, paging } from '../lib/http';
import { can, userCan } from '../lib/auth';
import { audit } from '../lib/audit';
import { getSettings } from '../lib/settings';
import { money, toCsv } from '../lib/util';
import { dayDiff, endOfDayUtc, formatDate, toCalendarDate } from '../lib/caldate';
import { reconcile } from '../services/reconciliation';
import { createApproval } from '../services/approvals';
import { ACTIVE_REFUND_STATUSES, assertCancellationKeepsRefundsCovered, courseFee, createFeePlan, feeMonthLabel, installmentFeeMonth, ledger, lockStudentAccount, recordPayment, studentBalance } from '../services/finance';
import { earlierPlansForCourse, feeEnrollmentChain, requestFeeAdjustment, requestRebill } from '../services/feeAdjustments';
import { notifyLater } from '../services/notify';
import { feeMonthLedger, monthSummary } from '../services/feeSummary';
import { enqueueManualReminders, mask, processReminderQueue, runFeeReminders } from '../services/feeReminders';
import { atomic } from '../lib/db';
import { dbDate } from '../lib/db';

const r = Router();

r.get('/students/:id/account', can('finance:read'), ah(async (req, res) => {
  const st = await prisma.student.findUnique({ where: { id: req.params.id }, include: { course: true, batch: true } });
  if (!st) throw notFound('Student not found');
  const [plans, invoices, payments, entries, discounts, refunds, balance, adjustments] = await Promise.all([
    // Newest plan first (after a course change the current enrollment's plan is the latest one).
    prisma.feePlan.findMany({ where: { studentId: st.id }, orderBy: { createdAt: 'desc' }, include: { installments: { orderBy: { seq: 'asc' } }, enrollment: { select: { id: true, status: true, startDate: true, endedAt: true, course: { select: { name: true } }, batch: { select: { code: true } } } } } }),
    prisma.invoice.findMany({ where: { studentId: st.id }, orderBy: { number: 'asc' } }),
    prisma.payment.findMany({ where: { studentId: st.id }, orderBy: { paidAt: 'desc' }, include: { allocations: true } }),
    prisma.ledgerEntry.findMany({ where: { studentId: st.id }, orderBy: { createdAt: 'asc' } }),
    prisma.discount.findMany({ where: { studentId: st.id }, orderBy: { createdAt: 'desc' } }),
    prisma.refund.findMany({ where: { studentId: st.id }, orderBy: { createdAt: 'desc' } }),
    studentBalance(st.id),
    prisma.feeAdjustment.findMany({ where: { studentId: st.id }, orderBy: { createdAt: 'desc' } }),
  ]);
  let run = 0;
  const ledgerRows = entries.map((e) => ((run = money(run + Number(e.debit) - Number(e.credit))), { ...e, balance: run }));
  // Whether a plan can be created for the current enrollment, and whether it needs approval (B2).
  const cur = await prisma.enrollment.findFirst({ where: { studentId: st.id, courseId: st.courseId, status: { in: ['ACTIVE', 'ON_HOLD'] } } });
  let newPlan: { allowed: boolean; needsApproval: boolean; pendingAdjustmentId: string | null } = { allowed: false, needsApproval: false, pendingAdjustmentId: null };
  if (cur) {
    const chain = await feeEnrollmentChain(prisma as any, cur.id);
    const has = await prisma.feePlan.count({ where: { studentId: st.id, OR: [{ enrollmentId: { in: chain } }, { enrollmentId: null, courseId: st.courseId }] } });
    const earlier = has ? [] : await earlierPlansForCourse(prisma as any, st.id, st.courseId, chain);
    const pending = adjustments.find((a) => a.kind === 'REBILL' && a.status === 'PENDING_APPROVAL');
    newPlan = { allowed: !has, needsApproval: !has && earlier.length > 0, pendingAdjustmentId: pending?.id ?? null };
  }
  res.json({ student: st, plans, invoices, payments, ledger: ledgerRows, discounts, refunds, adjustments, balance, newPlan });
}));

r.post('/students/:id/fee-plan', can('finance:manage'), ah(async (req, res) => {
  // startDate: a calendar date "YYYY-MM-DD" in the academy time zone (preferred) or an ISO timestamp.
  const { installments, startDate, reason } = z.object({ installments: z.number().int().min(1).max(24), startDate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.coerce.date()]).optional(), reason: z.string().trim().min(5).max(500).optional() }).parse(req.body);
  const st = await prisma.student.findUniqueOrThrow({ where: { id: req.params.id } });
  const enrollment = await prisma.enrollment.findFirst({ where: { studentId: st.id, courseId: st.courseId, status: { in: ['ACTIVE', 'ON_HOLD'] } } });
  if (!enrollment) throw badRequest('The student has no current enrollment in this course.');
  // One plan per course enrollment. A batch transfer within the same course continues the same course (and its
  // plan, which stays on the earlier enrollment in the chain); only a course change may get a new plan.
  const chain = await feeEnrollmentChain(prisma as any, enrollment.id);
  const existing = await prisma.feePlan.count({ where: { studentId: st.id, OR: [{ enrollmentId: { in: chain } }, { enrollmentId: null, courseId: st.courseId }] } });
  if (existing) throw badRequest('A fee plan already exists for this enrollment. Use discounts or adjustments instead.');
  // B2 (decision 2026-11-06): the student was billed for this course before (e.g. returned to it after a course
  // change). A second plan for the same course is created only through an approved fee adjustment (REBILL).
  const earlier = await earlierPlansForCourse(prisma as any, st.id, st.courseId, chain);
  if (earlier.length && (await courseFee(prisma as any, st.courseId)).gross > 0) {
    if (!reason) throw badRequest('This student was already billed for this course. Give a reason: the new plan needs approval.', { needsApproval: true });
    const out = await atomic(async (tx) => {
      const out = await requestRebill(tx, { studentId: st.id, plan: { enrollmentId: enrollment.id, courseId: st.courseId, installments, startDate: startDate instanceof Date ? startDate.toISOString() : startDate }, earlierPlanId: earlier[earlier.length - 1].id, reason, requestedById: req.user!.id });
      await audit(tx, req, 'CREATE', 'fee_adjustment', out.adjustment.id, null, { kind: 'REBILL', studentId: st.id, installments, startDate, amount: Number(out.adjustment.amount), earlierPlanIds: earlier.map((p) => p.id), approvalId: out.approval.id });
      return out;
    });
    return res.status(202).json({ needsApproval: true, ...out });
  }
  const plan = await atomic(async (tx) => {
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
  const p = await atomic(async (tx) => {
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
    ...(req.query.q && { OR: [{ receiptNumber: { contains: String(req.query.q) } }, { reference: { contains: String(req.query.q) } }, { student: { fullName: { contains: String(req.query.q) } } }] }),
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

/**
 * Individual PDF receipt: academy branding and contact details, receipt number, student name and ID, fee month(s)
 * paid, payment date, amount, payment method and the balance remaining right after this payment (frozen when the
 * payment was posted; older receipts show the current balance, labelled as such). Cancelled receipts are marked
 * CANCELLED in the title and across the page; a pending cancellation is noted.
 */
export async function receiptPdf(paymentId: string, out: NodeJS.WritableStream) {
  const p = await prisma.payment.findUnique({ where: { id: paymentId }, include: { student: { include: { course: true, batch: true } }, allocations: { include: { installment: true } } } });
  if (!p) throw notFound('Payment not found');
  const s = await getSettings();
  const tz = s.academy.timeZone;
  const frozen = p.balanceAfter != null;
  const bal = frozen ? Number(p.balanceAfter) : await studentBalance(p.studentId);
  const cur = (n: number) => `${s.academy.currency} ${money(n).toFixed(2)}`;
  const doc = new PDFDocument({ size: 'A5', margin: 36 });
  doc.pipe(out);
  doc.rect(0, 0, doc.page.width, 6).fill('#4338ca');
  doc.fillColor('#4338ca').fontSize(18).text(s.academy.name, 36, 24);
  if (s.academy.tagline) doc.fillColor('#6366f1').fontSize(8).text(s.academy.tagline);
  doc.fillColor('#555').fontSize(8).text(`${s.academy.address} · ${s.academy.phone} · ${s.academy.email}`);
  doc.moveDown();
  const title = p.status === 'CANCELLED' ? 'FEE RECEIPT — CANCELLED' : 'FEE RECEIPT';
  doc.fillColor(p.status === 'CANCELLED' ? '#b91c1c' : '#111').fontSize(13).text(title, { align: 'center' });
  if (p.status === 'CANCEL_REQUESTED') doc.fillColor('#b45309').fontSize(8).text('Cancellation requested — pending approval', { align: 'center' });
  doc.moveDown(0.5).fillColor('#111').fontSize(9);
  // Label and value on one line, wrapping only at the page margin.
  const row = (k: string, v: string) => doc.font('Helvetica-Bold').text(k, { continued: true }).font('Helvetica').text(`  ${v}`);
  const months = [...new Set(p.allocations.map((a) => feeMonthLabel(installmentFeeMonth(a.installment, tz))))];
  row('Receipt No:', p.receiptNumber);
  row('Payment date:', formatDate(p.paidAt, tz));
  row('Student:', p.student.fullName);
  row('Student ID:', p.student.studentCode);
  row('Course / Batch:', `${p.student.course.name}${p.student.batch ? ' / ' + p.student.batch.code : ''}`);
  if (months.length) row(months.length > 1 ? 'Fee months:' : 'Fee month:', months.join(', '));
  row('Payment method:', p.mode.replace(/_/g, ' ') + (p.reference ? ` — Ref ${p.reference}` : ''));
  if (p.payer) row('Paid by:', p.payer);
  doc.moveDown();
  for (const a of p.allocations) row(`${feeMonthLabel(installmentFeeMonth(a.installment, tz))} (installment #${a.installment.seq}):`, cur(Number(a.amount)));
  doc.moveDown(0.5).fontSize(12).font('Helvetica-Bold').text(`Amount received: ${cur(Number(p.amount))}`);
  doc.fontSize(9).font('Helvetica').text(frozen ? `Remaining balance after this payment: ${cur(bal)}` : `Current balance outstanding: ${cur(bal)}`);
  if (p.status === 'CANCELLED') {
    doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] }).fillColor('#dc2626').opacity(0.18).fontSize(64).font('Helvetica-Bold')
      .text('CANCELLED', 0, doc.page.height / 2 - 32, { width: doc.page.width, align: 'center' }).restore();
    doc.opacity(1);
  }
  doc.moveDown(2).fillColor('#888').fontSize(7).font('Helvetica').text('This is a computer-generated receipt and does not require a signature.', { align: 'center' });
  doc.end();
}

/** Receipt downloads are audit-logged (who, which receipt, through which portal). */
export async function auditReceiptDownload(req: Request, p: { id: string; receiptNumber: string; studentId: string; status: string }, via: 'staff' | 'student' | 'parent') {
  await audit(prisma, req, 'DOWNLOAD', 'receipt', p.id, null, { receiptNumber: p.receiptNumber, studentId: p.studentId, status: p.status, via });
}

r.get('/payments/:id/receipt.pdf', can('finance:read'), ah(async (req, res) => {
  const p = await prisma.payment.findUnique({ where: { id: req.params.id }, select: { id: true, receiptNumber: true, studentId: true, status: true } });
  if (!p) throw notFound('Payment not found');
  await auditReceiptDownload(req, p, 'staff');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${p.receiptNumber}.pdf"`);
  await receiptPdf(p.id, res);
}));

// Staff cannot edit/delete a posted payment — only request cancellation (§12 rules)
r.post('/payments/:id/cancel-request', can('finance:collect'), ah(async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(5) }).parse(req.body);
  const p = await prisma.payment.findUniqueOrThrow({ where: { id: req.params.id }, include: { student: true } });
  if (p.status !== 'POSTED') throw badRequest(`Payment is already ${p.status.toLowerCase().replace('_', ' ')}.`);
  const a = await atomic(async (tx) => {
    await lockStudentAccount(tx, p.studentId);
    await assertCancellationKeepsRefundsCovered(tx, p); // B1: refunds must stay covered by the remaining receipts
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
  const { feePlanId, ...d } = z.object({ studentId: z.string(), feePlanId: z.string().optional(), kind: z.enum(['FIXED', 'PERCENT', 'SCHOLARSHIP']), value: z.coerce.number().positive(), reason: z.string().min(3) }).parse(req.body);
  // A student can have one plan per course enrollment (course change): the discount targets the chosen plan,
  // or the newest one when none is given (previous behaviour).
  const plan = feePlanId
    ? await prisma.feePlan.findFirst({ where: { id: feePlanId, studentId: d.studentId }, include: { installments: true } })
    : await prisma.feePlan.findFirst({ where: { studentId: d.studentId }, orderBy: { createdAt: 'desc' }, include: { installments: true } });
  if (!plan) throw feePlanId ? notFound('Fee plan not found for this student.') : badRequest('Student has no fee plan.');
  const unpaid = plan.installments.reduce((s, i) => s + Number(i.amount) - Number(i.paidAmount), 0);
  const amount = money(d.kind === 'PERCENT' ? (Number(plan.grossAmount) * Math.min(d.value, 100)) / 100 : d.value);
  if (amount > unpaid + 0.001) throw badRequest(`Discount (${amount}) cannot exceed the unpaid amount (${money(unpaid)}).`);
  const st = await prisma.student.findUniqueOrThrow({ where: { id: d.studentId } });
  const result = await atomic(async (tx) => {
    const disc = await tx.discount.create({ data: { ...d, amount, feePlanId: plan.id, requestedById: req.user!.id } });
    // FIN-09 / decision 5 (2026-11-05): every discount and scholarship goes through the configured approval
    // workflow — there is no automatic exemption, for any role or amount.
    const appr = await createApproval(tx, {
      type: 'DISCOUNT', entityType: 'discount', entityId: disc.id,
      title: `${d.kind === 'SCHOLARSHIP' ? 'Scholarship' : 'Discount'} ${money(amount)} for ${st.fullName}: ${d.reason}`, payload: d, amount, requestedById: req.user!.id,
    });
    await audit(tx, req, 'CREATE', 'discount', disc.id, null, { ...d, feePlanId: plan.id, amount, approvalId: appr.id });
    return { discount: disc, approval: appr };
  });
  res.status(201).json(result);
}));

// SRS 22.6 / FIN-03 fee adjustments: waiver or custom installment plan — always through the approval workflow.
const scheduleRow = z.object({ dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), amount: z.coerce.number().positive() });
r.post('/adjustments', can('finance:collect', 'finance:manage'), ah(async (req, res) => {
  const d = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('WAIVER'), studentId: z.string(), feePlanId: z.string(), amount: z.coerce.number().positive(), reason: z.string().trim().min(5).max(500) }),
    z.object({ kind: z.literal('RESCHEDULE'), studentId: z.string(), feePlanId: z.string(), schedule: z.array(scheduleRow).min(1).max(24), reason: z.string().trim().min(5).max(500) }),
  ]).parse(req.body);
  const out = await atomic(async (tx) => {
    const out = await requestFeeAdjustment(tx, { ...d, requestedById: req.user!.id });
    await audit(tx, req, 'CREATE', 'fee_adjustment', out.adjustment.id, null, { ...d, amount: Number(out.adjustment.amount), approvalId: out.approval.id });
    return out;
  });
  res.status(201).json(out);
}));
r.get('/adjustments', can('finance:read'), ah(async (req, res) => {
  const where: any = { ...(req.query.studentId && { studentId: String(req.query.studentId) }), ...(req.query.status && { status: String(req.query.status) }) };
  const items = await prisma.feeAdjustment.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200, include: { student: { select: { id: true, fullName: true, studentCode: true } } } });
  res.json({ items });
}));

// FIN-11 refunds
r.post('/refunds', can('finance:collect', 'finance:manage'), ah(async (req, res) => {
  const d = z.object({ studentId: z.string(), amount: z.coerce.number().positive(), reason: z.string().min(5) }).parse(req.body);
  const st = await prisma.student.findUniqueOrThrow({ where: { id: d.studentId } });
  const out = await atomic(async (tx) => {
    // Same lock as receipt cancellation (B1), so a refund and a cancellation cannot both pass the checks at once.
    await lockStudentAccount(tx, d.studentId);
    const paid = await tx.payment.aggregate({ where: { studentId: d.studentId, status: 'POSTED' }, _sum: { amount: true } });
    const refunded = await tx.refund.aggregate({ where: { studentId: d.studentId, status: { in: ACTIVE_REFUND_STATUSES } }, _sum: { amount: true } });
    const max = money(Number(paid._sum.amount ?? 0) - Number(refunded._sum.amount ?? 0));
    if (d.amount > max) throw badRequest(`Refund cannot exceed the refundable amount (${max}).`);
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
  await atomic(async (tx) => {
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
    where: { status: { in: ['DUE', 'PARTIAL'] }, feePlan: { student: { status: { notIn: ['WITHDRAWN', 'TERMINATED'] }, ...(req.query.courseId && { courseId: String(req.query.courseId) }), ...(req.query.batchId && { batchId: String(req.query.batchId) }) } } },
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
      SELECT substr("paidAt", 1, 10) AS day, SUM(amount) AS amount, COUNT(*) AS count FROM payments
      WHERE status <> 'CANCELLED' AND "paidAt" BETWEEN ${dbDate(from)} AND ${dbDate(to)} GROUP BY 1 ORDER BY 1`,
  ]);
  const byCourse = await prisma.$queryRaw<{ course: string; amount: number }[]>`
    SELECT c.name AS course, SUM(p.amount) AS amount FROM payments p JOIN students s ON s.id = p."studentId" JOIN courses c ON c.id = s."courseId"
    WHERE p.status <> 'CANCELLED' AND p."paidAt" BETWEEN ${dbDate(from)} AND ${dbDate(to)} GROUP BY 1 ORDER BY 2 DESC`;
  const byCollector = await prisma.$queryRaw<{ collector: string; amount: number }[]>`
    SELECT COALESCE(u.name, 'Online') AS collector, SUM(p.amount) AS amount FROM payments p LEFT JOIN users u ON u.id = p."recordedById"
    WHERE p.status <> 'CANCELLED' AND p."paidAt" BETWEEN ${dbDate(from)} AND ${dbDate(to)} GROUP BY 1 ORDER BY 2 DESC`;
  res.json({
    from, to,
    total: money(byMode.reduce((s, m) => s + Number(m._sum.amount ?? 0), 0)),
    byMode: byMode.map((m) => ({ mode: m.mode, amount: Number(m._sum.amount ?? 0), count: m._count })),
    byDay: rows.map((r) => ({ day: r.day, amount: r.amount, count: Number(r.count) })),
    byCourse, byCollector,
  });
}));

// ── Pending fee management (services/feeSummary.ts) ──

// Finance Dashboard for a fee month (?month=YYYY-MM, default this month): totals, paid / partial / unpaid, overdue.
r.get('/summary', can('finance:read'), ah(async (req, res) => {
  const where = req.query.mine === 'true' ? { financeOwnerId: req.user!.id } : {};
  const out = await monthSummary(req.query.month ? String(req.query.month) : undefined, where);
  let items = out.items;
  const st = String(req.query.status ?? '');
  if (st === 'OVERDUE') items = items.filter((i) => i.overdueDays > 0);
  else if (['PAID', 'PARTIAL', 'UNPAID'].includes(st)) items = items.filter((i) => i.status === st);
  const { skip, take, page, pageSize } = paging(req.query);
  res.json({ ...out, items: items.slice(skip, skip + take), page, pageSize, total: items.length });
}));

// Per-student ledger by fee month.
r.get('/students/:id/fee-months', can('finance:read'), ah(async (req, res) => {
  const st = await prisma.student.findUnique({ where: { id: req.params.id }, select: { id: true, fullName: true, studentCode: true, status: true, course: { select: { name: true } }, batch: { select: { code: true } }, financeOwner: { select: { id: true, name: true } } } });
  if (!st) throw notFound('Student not found');
  res.json({ student: st, ...(await feeMonthLedger(st.id)) });
}));

// Finance users a student can be assigned to.
r.get('/collectors', can('finance:read'), ah(async (_req, res) => {
  const items = await prisma.user.findMany({ where: { isActive: true, roles: { some: { role: { key: { in: ['finance_staff', 'finance_manager'] } } } } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  res.json({ items });
}));

// Assign a student's collection and follow-ups to a finance user (Finance Manager / Super Admin).
r.put('/students/:id/finance-owner', can('finance:manage'), ah(async (req, res) => {
  const { userId } = z.object({ userId: z.string().nullable() }).parse(req.body);
  const st = await prisma.student.findUnique({ where: { id: req.params.id }, select: { id: true, financeOwnerId: true } });
  if (!st) throw notFound('Student not found');
  if (userId) {
    const ok = await prisma.user.count({ where: { id: userId, isActive: true, roles: { some: { role: { key: { in: ['finance_staff', 'finance_manager'] } } } } } });
    if (!ok) throw badRequest('Choose an active Finance Staff or Finance Manager user.');
  }
  await atomic(async (tx) => {
    await tx.student.update({ where: { id: st.id }, data: { financeOwnerId: userId } });
    await audit(tx, req, 'ASSIGN', 'student_finance_owner', st.id, { financeOwnerId: st.financeOwnerId }, { financeOwnerId: userId });
  });
  res.json({ ok: true, financeOwnerId: userId });
}));

// ── FIN-08 fee reminders (services/feeReminders.ts) ──

/**
 * Collection scope: Finance Managers (finance:manage) and Super Admins work on every student; other finance users
 * (Finance Staff) send reminders and see follow-ups only for students assigned to them (students.financeOwnerId).
 */
export const collectionScope = (req: Request) => (userCan(req, 'finance:manage') ? {} : { financeOwnerId: req.user!.id });

// Run the automatic schedule now (normally the cron does this through the day).
r.post('/reminders/run', can('finance:manage'), ah(async (req, res) => {
  const out = await runFeeReminders({ ignoreHours: true });
  await audit(prisma, req, 'REMINDER_RUN', 'fee_reminder', null, null, out);
  res.json(out);
}));

// Individual or bulk reminders: the given students (in scope), or every in-scope student with an overdue installment.
r.post('/reminders/send', can('finance:collect'), ah(async (req, res) => {
  const b = z.object({ studentIds: z.array(z.string()).min(1).max(200).optional(), overdueOnly: z.boolean().optional() }).refine((x) => x.studentIds || x.overdueOnly, 'Choose students, or overdueOnly').parse(req.body);
  const scope = collectionScope(req);
  let ids: string[];
  if (b.studentIds) {
    const ok = await prisma.student.findMany({ where: { id: { in: b.studentIds }, ...scope }, select: { id: true } });
    if (ok.length !== new Set(b.studentIds).size) throw forbidden('You can send reminders only to students assigned to you.');
    ids = ok.map((x) => x.id);
  } else {
    const s = await getSettings();
    const today = toCalendarDate(new Date(), s.academy.timeZone);
    const overdue = await prisma.installment.findMany({
      where: { status: { in: ['DUE', 'PARTIAL'] }, dueDate: { lt: endOfDayUtc({ ...today }, s.academy.timeZone) }, feePlan: { student: { ...scope, status: { notIn: ['WITHDRAWN', 'TERMINATED', 'COMPLETED'] } } } },
      select: { dueDate: true, feePlan: { select: { studentId: true } } },
    });
    ids = [...new Set(overdue.filter((i) => dayDiff(toCalendarDate(i.dueDate, s.academy.timeZone), today) > 0).map((i) => i.feePlan.studentId))].slice(0, 500);
  }
  const q = await enqueueManualReminders(ids, req.user!.id);
  const queuedIds = (await prisma.feeReminder.findMany({ where: { studentId: { in: ids }, trigger: 'MANUAL', status: 'QUEUED', sentById: req.user!.id }, select: { id: true }, take: 50 })).map((x) => x.id);
  const d = await processReminderQueue({ ids: queuedIds, limit: 50 });
  const out = { students: ids.length, ...q, ...d, pending: Math.max(0, q.queued - d.sent - d.failed - d.skipped) };
  await audit(prisma, req, 'REMINDER_SEND', 'fee_reminder', null, null, { studentIds: ids.length <= 20 ? ids : undefined, ...out });
  res.json(out);
}));

// Reminder history and delivery status (addresses masked).
r.get('/reminders', can('finance:read'), ah(async (req, res) => {
  const { skip, take, page, pageSize } = paging(req.query);
  const where: any = {};
  if (req.query.studentId) where.studentId = String(req.query.studentId);
  if (req.query.status) where.status = String(req.query.status);
  if (req.query.channel) where.channel = String(req.query.channel);
  if (req.query.trigger) where.trigger = String(req.query.trigger);
  const [rows, total] = await Promise.all([
    prisma.feeReminder.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: { installment: { select: { seq: true, dueDate: true, feeMonth: true } } } }),
    prisma.feeReminder.count({ where }),
  ]);
  const students = await prisma.student.findMany({ where: { id: { in: [...new Set(rows.map((x) => x.studentId))] } }, select: { id: true, fullName: true, studentCode: true } });
  const guardians = await prisma.guardian.findMany({ where: { id: { in: rows.filter((x) => x.recipientType === 'GUARDIAN').map((x) => x.recipientRef) } }, select: { id: true, name: true, relation: true } });
  const tz = (await getSettings()).academy.timeZone;
  res.json({
    page, pageSize, total,
    items: rows.map(({ address, installment, ...x }) => ({
      ...x, address: mask(x.channel, address), student: students.find((s) => s.id === x.studentId) ?? null,
      recipient: x.recipientType === 'GUARDIAN' ? (guardians.find((g) => g.id === x.recipientRef) ?? { name: 'Guardian (removed)' }) : { name: 'Student' },
      installment: { seq: installment.seq, dueDate: installment.dueDate, feeMonth: installmentFeeMonth(installment, tz) },
    })),
  });
}));

// Retry a reminder that failed (including one that used up its automatic attempts).
r.post('/reminders/:id/retry', can('finance:collect'), ah(async (req, res) => {
  const row = await prisma.feeReminder.findUnique({ where: { id: req.params.id } });
  if (!row) throw notFound('Reminder not found');
  if (!(await prisma.student.count({ where: { id: row.studentId, ...collectionScope(req) } }))) throw forbidden('You can retry reminders only for students assigned to you.');
  if (row.status !== 'FAILED') throw badRequest(`Only failed reminders can be retried (this one is ${row.status.toLowerCase()}).`);
  const max = (await getSettings()).finance.reminderMaxAttempts;
  const reset = await prisma.feeReminder.updateMany({ where: { id: row.id, status: 'FAILED', attempts: row.attempts }, data: { attempts: Math.min(row.attempts, max - 1), nextAttemptAt: new Date() } });
  if (reset.count !== 1) throw badRequest('This reminder changed meanwhile; refresh and try again.');
  const d = await processReminderQueue({ ids: [row.id], limit: 1 });
  await audit(prisma, req, 'REMINDER_RETRY', 'fee_reminder', row.id, { status: row.status, attempts: row.attempts }, d);
  res.json({ ...d, reminder: await prisma.feeReminder.findUnique({ where: { id: row.id }, select: { id: true, status: true, attempts: true, lastError: true, sentAt: true } }) });
}));

// FIN-13 / RPT-06 reconciliation: read-only consistency check (never modifies records).
r.get('/reconciliation', can('finance:manage', 'audit:read'), ah(async (req, res) => {
  const studentId = req.query.studentId ? String(req.query.studentId) : undefined;
  const out = await reconcile({ studentId });
  await audit(prisma, req, 'REPORT_RUN', 'report', 'reconciliation', null, { studentId, ok: out.ok, bySeverity: out.bySeverity });
  res.json(out);
}));

export default r;
