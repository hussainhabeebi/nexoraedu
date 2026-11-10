/**
 * Parent / guardian portal: the fee records and receipts of the children linked to this account
 * (guardians.userId), and nothing else. Every child-level request re-checks the link (API-08 object-level auth),
 * so changing a student or payment id in the URL never reaches another family's records.
 */
import { Router, type Request } from 'express';
import { prisma } from '../lib/prisma';
import { ah, notFound } from '../lib/http';
import { can } from '../lib/auth';
import { studentBalance } from '../services/finance';
import { feeMonthLedger } from '../services/feeSummary';
import { auditReceiptDownload, receiptPdf } from './finance';

const r = Router();
r.use(can('portal:parent'));

/** The student, if (and only if) it is linked to the signed-in parent. */
async function child(req: Request, studentId: string) {
  const g = await prisma.guardian.findFirst({ where: { userId: req.user!.id, studentId }, select: { relation: true, student: { select: { id: true, fullName: true, studentCode: true, status: true, course: { select: { name: true } }, batch: { select: { code: true } } } } } });
  if (!g) throw notFound('Student not found');
  return { ...g.student, relation: g.relation };
}

r.get('/children', ah(async (req, res) => {
  const links = await prisma.guardian.findMany({ where: { userId: req.user!.id }, select: { relation: true, student: { select: { id: true, fullName: true, studentCode: true, status: true, course: { select: { name: true } }, batch: { select: { code: true } } } } } });
  const items = await Promise.all(links.map(async (l) => ({ ...l.student, relation: l.relation, balance: await studentBalance(l.student.id) })));
  res.json({ items });
}));

r.get('/children/:studentId/fees', ah(async (req, res) => {
  const st = await child(req, req.params.studentId);
  const [months, payments, balance] = await Promise.all([
    feeMonthLedger(st.id),
    prisma.payment.findMany({ where: { studentId: st.id }, orderBy: { paidAt: 'desc' }, select: { id: true, receiptNumber: true, amount: true, mode: true, paidAt: true, status: true } }),
    studentBalance(st.id),
  ]);
  res.json({ student: st, balance, months, payments, paymentInfo: { upi: process.env.ACADEMY_UPI_ID || null, bank: process.env.ACADEMY_BANK_DETAILS || null } });
}));

r.get('/children/:studentId/payments/:paymentId/receipt.pdf', ah(async (req, res) => {
  const st = await child(req, req.params.studentId);
  const p = await prisma.payment.findFirst({ where: { id: req.params.paymentId, studentId: st.id }, select: { id: true, receiptNumber: true, studentId: true, status: true } });
  if (!p) throw notFound();
  await auditReceiptDownload(req, p, 'parent');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${p.receiptNumber}.pdf"`);
  await receiptPdf(p.id, res);
}));

export default r;
