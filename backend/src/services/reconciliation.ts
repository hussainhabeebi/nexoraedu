/**
 * Financial reconciliation (FIN-13, RPT-06, 8.4 Reliability). DETECTS inconsistencies between fee plans,
 * installments, invoices, payments/allocations, discounts, refunds and the immutable ledger.
 * It never changes any record: it runs in a READ ONLY, REPEATABLE READ transaction (one consistent snapshot).
 * Corrections, if needed, are made by finance staff through the normal approval / reversing-entry flows.
 *
 * All amounts are compared in whole paise (integers) to avoid floating-point noise.
 *
 * Rules
 *  R1  LEDGER_BALANCE        per student: ledger (debit − credit) = Σ open installment amounts + Σ PAID refunds.
 *                            (A paid refund returns money; until a fee adjustment exists, it re-opens the balance.)
 *  R2  PLAN_TOTAL            per plan: Σ installment amounts = gross − applied discounts − applied waivers.
 *  R3  INSTALLMENT_BOUNDS    0 ≤ paid ≤ amount, and status matches (DUE = 0 paid, PAID = fully paid, else PARTIAL;
 *                            SUPERSEDED = replaced by a custom plan, amount 0 and nothing paid).
 *  R4  INSTALLMENT_PAID      installment paid = Σ allocations of payments that are not CANCELLED.
 *  R5  PAYMENT_ALLOCATION    payment amount = Σ its allocations (each allocation belongs to the payer's own plan).
 *  R6  PAYMENT_LEDGER        each payment has exactly one PAYMENT credit = amount; a CANCELLED payment has exactly one
 *                            REVERSAL debit = amount; other payments have none.
 *  R7  DISCOUNT_LEDGER       APPLIED discount ⇔ exactly one DISCOUNT/SCHOLARSHIP credit = amount; per plan
 *                            Σ applied discounts = fee_plans.discount.
 *  R8  REFUND_LEDGER         PAID refund ⇔ exactly one REFUND debit = amount; Σ active refunds ≤ Σ non-cancelled payments.
 *  R9  FEE_LEDGER            each plan with gross > 0 has exactly one FEE debit = gross.
 *  R10 LEDGER_REFERENCE      every ledger entry references an existing source record of the same student.
 *  R11 INVOICE_COVERAGE      each installment has an invoice (warning).
 *  R12 DUE_DATE_POLICY       plans with a recorded policy: due dates follow "anchor day, clamped" at end of day in the
 *                            recorded zone (error if not). Legacy plans (no policy) that deviate are reported as INFO
 *                            only — their dates are intentionally NOT changed. Installments created by a custom plan
 *                            (fee adjustment) follow their own approved dates: each must be end of day in the zone.
 *  R13 ADJUSTMENT_LEDGER     APPLIED waiver ⇔ exactly one WAIVER credit = amount; per plan Σ applied waivers =
 *                            fee_plans.waived; a custom plan (RESCHEDULE) and non-applied adjustments post nothing;
 *                            an applied custom plan created installments adding up to its amount.
 *  R14 CLOSED_ENROLLMENT_BALANCE  unpaid installments on a plan whose enrollment has ended without continuing in the
 *                            same course: WARNING when CANCELLED or moved to another course (a fee adjustment or new
 *                            decision is needed); INFO when WITHDRAWN / TERMINATED (refund/fee policy pending).
 */
import { prisma } from '../lib/prisma';
import { getSettings } from '../lib/settings';
import { addMonthsClamped, endOfDayUtc, isoDate, toCalendarDate } from '../lib/caldate';

export type Severity = 'ERROR' | 'WARNING' | 'INFO';
export interface Issue {
  rule: string;
  severity: Severity;
  studentId: string | null;
  entity: string;
  entityId: string;
  expected?: string;
  actual?: string;
  message: string;
}

const P = (v: unknown) => Math.round(Number(v ?? 0) * 100); // → paise
const R = (p: number) => (p / 100).toFixed(2);

export async function reconcile(opts: { studentId?: string } = {}) {
  const st = await getSettings();
  const academyTz = st.academy.timeZone;
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const sw = opts.studentId ? { studentId: opts.studentId } : {};
      const [plans, installments, invoices, payments, allocations, discounts, refunds, ledger, adjustments, enrollments] = await Promise.all([
        tx.feePlan.findMany({ where: sw, select: { id: true, studentId: true, grossAmount: true, discount: true, waived: true, dueAnchorDay: true, dueTimeZone: true, enrollmentId: true } }),
        tx.installment.findMany({ where: opts.studentId ? { feePlan: { studentId: opts.studentId } } : {}, select: { id: true, feePlanId: true, seq: true, amount: true, paidAmount: true, status: true, dueDate: true, adjustmentId: true } }),
        tx.invoice.findMany({ where: sw, select: { installmentId: true } }),
        tx.payment.findMany({ where: sw, select: { id: true, studentId: true, amount: true, status: true, receiptNumber: true } }),
        tx.paymentAllocation.findMany({ where: opts.studentId ? { payment: { studentId: opts.studentId } } : {}, select: { paymentId: true, installmentId: true, amount: true } }),
        tx.discount.findMany({ where: sw, select: { id: true, studentId: true, feePlanId: true, amount: true, status: true } }),
        tx.refund.findMany({ where: sw, select: { id: true, studentId: true, amount: true, status: true } }),
        tx.ledgerEntry.findMany({ where: sw, select: { id: true, studentId: true, type: true, debit: true, credit: true, refType: true, refId: true } }),
        tx.feeAdjustment.findMany({ where: sw, select: { id: true, studentId: true, feePlanId: true, kind: true, amount: true, status: true } }),
        tx.enrollment.findMany({ where: sw, select: { id: true, studentId: true, courseId: true, status: true, previousEnrollmentId: true } }),
      ]);
      const issues: Issue[] = [];
      const add = (i: Issue) => issues.push(i);

      const planById = new Map(plans.map((p) => [p.id, p]));
      const payById = new Map(payments.map((p) => [p.id, p]));
      const instById = new Map(installments.map((i) => [i.id, i]));
      const group = <T, K>(xs: T[], k: (x: T) => K) => xs.reduce((m, x) => m.set(k(x), [...(m.get(k(x)) ?? []), x]), new Map<K, T[]>());
      const instByPlan = group(installments, (i) => i.feePlanId);
      const allocByPay = group(allocations, (a) => a.paymentId);
      const allocByInst = group(allocations, (a) => a.installmentId);
      const ledgerByRef = group(ledger, (e) => `${e.refType}:${e.refId}`);
      const invoiced = new Set(invoices.map((i) => i.installmentId));

      // R2, R9, R12 — plans
      for (const p of plans) {
        const ins = (instByPlan.get(p.id) ?? []).sort((a, b) => a.seq - b.seq);
        const sum = ins.reduce((s, i) => s + P(i.amount), 0);
        const exp = P(p.grossAmount) - P(p.discount) - P(p.waived);
        if (sum !== exp) add({ rule: 'R2_PLAN_TOTAL', severity: 'ERROR', studentId: p.studentId, entity: 'fee_plan', entityId: p.id, expected: R(exp), actual: R(sum), message: 'Installment total differs from plan gross minus discounts and waivers.' });
        const fee = (ledgerByRef.get(`fee_plan:${p.id}`) ?? []).filter((e) => e.type === 'FEE');
        if (P(p.grossAmount) > 0 && (fee.length !== 1 || P(fee[0].debit) !== P(p.grossAmount)))
          add({ rule: 'R9_FEE_LEDGER', severity: 'ERROR', studentId: p.studentId, entity: 'fee_plan', entityId: p.id, expected: `1 FEE debit of ${R(P(p.grossAmount))}`, actual: `${fee.length} entr(ies) ${fee.map((e) => R(P(e.debit))).join(', ')}`, message: 'Fee plan is not posted to the ledger exactly once.' });
        const custom = ins.filter((i) => i.adjustmentId);
        const tz0 = p.dueTimeZone ?? academyTz;
        const badCustom = custom.filter((i) => endOfDayUtc(toCalendarDate(i.dueDate, tz0), tz0).getTime() !== i.dueDate.getTime());
        if (badCustom.length)
          add({ rule: 'R12_DUE_DATE_POLICY', severity: 'ERROR', studentId: p.studentId, entity: 'fee_plan', entityId: p.id, actual: badCustom.map((i) => `#${i.seq} ${i.dueDate.toISOString()}`).join(', '), message: 'Custom-plan due dates are not at the end of the day in the plan time zone.' });
        const orig = ins.filter((i) => !i.adjustmentId);
        if (orig.length) {
          const ins = orig;
          const tz = p.dueTimeZone ?? academyTz;
          const first = toCalendarDate(ins[0].dueDate, tz);
          const anchor = p.dueAnchorDay ?? first.d;
          const expected = (n: number) => addMonthsClamped(first, n, anchor);
          // Policy plans: exact instant (end of the calendar day in the recorded zone).
          // Legacy plans: only the calendar date is compared (they were stored at server-local 23:59:59).
          const bad = ins.filter((i, n) =>
            p.dueAnchorDay ? endOfDayUtc(expected(n), tz).getTime() !== i.dueDate.getTime() : isoDate(expected(n)) !== isoDate(toCalendarDate(i.dueDate, tz)),
          );
          if (bad.length)
            add({
              rule: 'R12_DUE_DATE_POLICY', severity: p.dueAnchorDay ? 'ERROR' : 'INFO', studentId: p.studentId, entity: 'fee_plan', entityId: p.id,
              actual: bad.map((i) => `#${i.seq} ${isoDate(toCalendarDate(i.dueDate, tz))}`).join(', '),
              message: p.dueAnchorDay ? 'Due dates do not follow the recorded month-end policy.' : 'Legacy plan (before the month-end policy): due dates kept as originally issued; review manually if needed.',
            });
        }
      }

      // R3, R4, R11 — installments
      for (const i of installments) {
        const plan = planById.get(i.feePlanId);
        const sid = plan?.studentId ?? null;
        const amt = P(i.amount), paid = P(i.paidAmount);
        if (paid < 0 || paid > amt) add({ rule: 'R3_INSTALLMENT_BOUNDS', severity: 'ERROR', studentId: sid, entity: 'installment', entityId: i.id, expected: `0 … ${R(amt)}`, actual: R(paid), message: 'Paid amount outside 0…installment amount.' });
        const expStatus = i.status === 'SUPERSEDED' && amt === 0 && paid === 0 ? 'SUPERSEDED' : paid >= amt ? 'PAID' : paid === 0 ? 'DUE' : 'PARTIAL';
        if (i.status !== expStatus) add({ rule: 'R3_INSTALLMENT_STATUS', severity: 'ERROR', studentId: sid, entity: 'installment', entityId: i.id, expected: expStatus, actual: i.status, message: 'Installment status does not match its paid amount.' });
        const alloc = (allocByInst.get(i.id) ?? []).filter((a) => payById.get(a.paymentId)?.status !== 'CANCELLED').reduce((s, a) => s + P(a.amount), 0);
        if (alloc !== paid) add({ rule: 'R4_INSTALLMENT_PAID', severity: 'ERROR', studentId: sid, entity: 'installment', entityId: i.id, expected: R(alloc), actual: R(paid), message: 'Paid amount differs from active payment allocations.' });
        if (!invoiced.has(i.id)) add({ rule: 'R11_INVOICE_COVERAGE', severity: 'WARNING', studentId: sid, entity: 'installment', entityId: i.id, message: 'Installment has no invoice.' });
      }

      // R5, R6 — payments
      for (const p of payments) {
        const al = allocByPay.get(p.id) ?? [];
        const sum = al.reduce((s, a) => s + P(a.amount), 0);
        if (sum !== P(p.amount)) add({ rule: 'R5_PAYMENT_ALLOCATION', severity: 'ERROR', studentId: p.studentId, entity: 'payment', entityId: p.id, expected: R(P(p.amount)), actual: R(sum), message: `Receipt ${p.receiptNumber}: allocations do not add up to the payment.` });
        if (al.some((a) => planById.get(instById.get(a.installmentId)?.feePlanId ?? '')?.studentId !== p.studentId && !opts.studentId))
          add({ rule: 'R5_PAYMENT_ALLOCATION', severity: 'ERROR', studentId: p.studentId, entity: 'payment', entityId: p.id, message: `Receipt ${p.receiptNumber}: allocated to another student's installment.` });
        const ent = ledgerByRef.get(`payment:${p.id}`) ?? [];
        const credits = ent.filter((e) => e.type === 'PAYMENT');
        const revs = ent.filter((e) => e.type === 'REVERSAL');
        if (credits.length !== 1 || P(credits[0].credit) !== P(p.amount)) add({ rule: 'R6_PAYMENT_LEDGER', severity: 'ERROR', studentId: p.studentId, entity: 'payment', entityId: p.id, expected: `1 PAYMENT credit of ${R(P(p.amount))}`, actual: `${credits.length}`, message: `Receipt ${p.receiptNumber} is not posted to the ledger exactly once.` });
        const wantRev = p.status === 'CANCELLED' ? 1 : 0;
        if (revs.length !== wantRev || (wantRev && P(revs[0].debit) !== P(p.amount))) add({ rule: 'R6_PAYMENT_LEDGER', severity: 'ERROR', studentId: p.studentId, entity: 'payment', entityId: p.id, expected: `${wantRev} REVERSAL`, actual: `${revs.length}`, message: `Receipt ${p.receiptNumber}: reversal entries do not match its status (${p.status}).` });
      }

      // R7 — discounts
      const appliedByPlan = new Map<string, number>();
      for (const d of discounts) {
        const ent = (ledgerByRef.get(`discount:${d.id}`) ?? []).filter((e) => e.type === 'DISCOUNT' || e.type === 'SCHOLARSHIP');
        const applied = d.status === 'APPLIED';
        if (applied) appliedByPlan.set(d.feePlanId, (appliedByPlan.get(d.feePlanId) ?? 0) + P(d.amount));
        if (applied ? ent.length !== 1 || P(ent[0].credit) !== P(d.amount) : ent.length !== 0)
          add({ rule: 'R7_DISCOUNT_LEDGER', severity: 'ERROR', studentId: d.studentId, entity: 'discount', entityId: d.id, expected: applied ? `1 credit of ${R(P(d.amount))}` : '0 entries', actual: `${ent.length}`, message: `Discount (${d.status}) ledger entries do not match.` });
      }
      for (const p of plans) {
        const exp = appliedByPlan.get(p.id) ?? 0;
        if (exp !== P(p.discount)) add({ rule: 'R7_DISCOUNT_LEDGER', severity: 'ERROR', studentId: p.studentId, entity: 'fee_plan', entityId: p.id, expected: R(exp), actual: R(P(p.discount)), message: 'Plan discount total differs from applied discounts.' });
      }

      // R13 — fee adjustments (SRS 22.6)
      const waivedByPlan = new Map<string, number>();
      const instByAdj = group(installments.filter((i) => i.adjustmentId), (i) => i.adjustmentId!);
      for (const a of adjustments) {
        const ent = ledgerByRef.get(`fee_adjustment:${a.id}`) ?? [];
        const applied = a.status === 'APPLIED';
        const isWaiver = a.kind === 'WAIVER';
        if (applied && isWaiver) waivedByPlan.set(a.feePlanId, (waivedByPlan.get(a.feePlanId) ?? 0) + P(a.amount));
        const want = applied && isWaiver;
        if (want ? ent.length !== 1 || ent[0].type !== 'WAIVER' || P(ent[0].credit) !== P(a.amount) : ent.length !== 0)
          add({ rule: 'R13_ADJUSTMENT_LEDGER', severity: 'ERROR', studentId: a.studentId, entity: 'fee_adjustment', entityId: a.id, expected: want ? `1 WAIVER credit of ${R(P(a.amount))}` : '0 entries', actual: `${ent.length}`, message: `Fee adjustment (${a.kind}, ${a.status}) ledger entries do not match.` });
        const created = instByAdj.get(a.id) ?? [];
        if (applied && !isWaiver && created.length === 0)
          add({ rule: 'R13_ADJUSTMENT_LEDGER', severity: 'ERROR', studentId: a.studentId, entity: 'fee_adjustment', entityId: a.id, message: 'Applied custom plan created no installments.' });
        if (!(applied && !isWaiver) && created.length)
          add({ rule: 'R13_ADJUSTMENT_LEDGER', severity: 'ERROR', studentId: a.studentId, entity: 'fee_adjustment', entityId: a.id, message: 'Installments reference an adjustment that is not an applied custom plan.' });
      }
      for (const p of plans) {
        const exp = waivedByPlan.get(p.id) ?? 0;
        if (exp !== P(p.waived)) add({ rule: 'R13_ADJUSTMENT_LEDGER', severity: 'ERROR', studentId: p.studentId, entity: 'fee_plan', entityId: p.id, expected: R(exp), actual: R(P(p.waived)), message: 'Plan waiver total differs from applied waivers.' });
      }

      // R14 — unpaid balance left on an enrollment that has ended (not continued in the same course)
      const enrById = new Map(enrollments.map((e) => [e.id, e]));
      const successor = new Map(enrollments.filter((e) => e.previousEnrollmentId).map((e) => [e.previousEnrollmentId!, e]));
      for (const p of plans) {
        if (!p.enrollmentId) continue;
        let e = enrById.get(p.enrollmentId);
        for (let n = 0; e && e.status === 'TRANSFERRED' && n < 100; n++) {
          const next = successor.get(e.id);
          if (!next || next.courseId !== e.courseId) break;
          e = next;
        }
        if (!e || ['ACTIVE', 'ON_HOLD', 'COMPLETED'].includes(e.status)) continue;
        const openAmt = (instByPlan.get(p.id) ?? []).reduce((s, i) => s + P(i.amount) - P(i.paidAmount), 0);
        if (openAmt <= 0) continue;
        const warn = e.status === 'CANCELLED' || e.status === 'TRANSFERRED';
        add({ rule: 'R14_CLOSED_ENROLLMENT_BALANCE', severity: warn ? 'WARNING' : 'INFO', studentId: p.studentId, entity: 'fee_plan', entityId: p.id, actual: `${R(openAmt)} unpaid; enrollment ${e.status.toLowerCase()}`, message: warn ? 'Unpaid installments remain on an enrollment that was cancelled or moved to another course: request a fee adjustment (22.6) or confirm the amount is still owed.' : 'Unpaid installments remain after withdrawal/termination: review per the fee/refund policy.' });
      }

      // R8 — refunds
      const activePaid = new Map<string, number>();
      for (const p of payments) if (p.status !== 'CANCELLED') activePaid.set(p.studentId, (activePaid.get(p.studentId) ?? 0) + P(p.amount));
      const refundSum = new Map<string, number>();
      for (const r of refunds) {
        const ent = (ledgerByRef.get(`refund:${r.id}`) ?? []).filter((e) => e.type === 'REFUND');
        const paid = r.status === 'PAID';
        if (paid ? ent.length !== 1 || P(ent[0].debit) !== P(r.amount) : ent.length !== 0)
          add({ rule: 'R8_REFUND_LEDGER', severity: 'ERROR', studentId: r.studentId, entity: 'refund', entityId: r.id, expected: paid ? `1 debit of ${R(P(r.amount))}` : '0 entries', actual: `${ent.length}`, message: `Refund (${r.status}) ledger entries do not match.` });
        if (r.status !== 'REJECTED') refundSum.set(r.studentId, (refundSum.get(r.studentId) ?? 0) + P(r.amount));
      }
      for (const [sid, sum] of refundSum) if (sum > (activePaid.get(sid) ?? 0)) add({ rule: 'R8_REFUND_LIMIT', severity: 'ERROR', studentId: sid, entity: 'student', entityId: sid, expected: `≤ ${R(activePaid.get(sid) ?? 0)}`, actual: R(sum), message: 'Refunds exceed payments received.' });

      // R10 — ledger references
      const sources: Record<string, Map<string, { studentId: string }>> = {
        fee_plan: planById as any, payment: payById as any,
        discount: new Map(discounts.map((d) => [d.id, d])), refund: new Map(refunds.map((r) => [r.id, r])),
        fee_adjustment: new Map(adjustments.map((a) => [a.id, a])),
      };
      for (const e of ledger) {
        const src = e.refType ? sources[e.refType]?.get(e.refId ?? '') : undefined;
        if (!src || src.studentId !== e.studentId) add({ rule: 'R10_LEDGER_REFERENCE', severity: 'ERROR', studentId: e.studentId, entity: 'ledger_entry', entityId: e.id, actual: `${e.refType}:${e.refId}`, message: 'Ledger entry does not reference an existing source record of this student.' });
      }

      // R1 — balance per student
      const balance = new Map<string, number>();
      for (const e of ledger) balance.set(e.studentId, (balance.get(e.studentId) ?? 0) + P(e.debit) - P(e.credit));
      const open = new Map<string, number>();
      for (const i of installments) {
        const sid = planById.get(i.feePlanId)?.studentId;
        if (sid) open.set(sid, (open.get(sid) ?? 0) + P(i.amount) - P(i.paidAmount));
      }
      const paidRefunds = new Map<string, number>();
      for (const r of refunds) if (r.status === 'PAID') paidRefunds.set(r.studentId, (paidRefunds.get(r.studentId) ?? 0) + P(r.amount));
      const studentIds = new Set([...balance.keys(), ...open.keys()]);
      for (const sid of studentIds) {
        const exp = (open.get(sid) ?? 0) + (paidRefunds.get(sid) ?? 0);
        const act = balance.get(sid) ?? 0;
        if (exp !== act) add({ rule: 'R1_LEDGER_BALANCE', severity: 'ERROR', studentId: sid, entity: 'student', entityId: sid, expected: R(exp), actual: R(act), message: 'Ledger balance differs from open installments (+ paid refunds).' });
      }

      const bySeverity = { ERROR: 0, WARNING: 0, INFO: 0 } as Record<Severity, number>;
      const byRule: Record<string, number> = {};
      for (const i of issues) {
        bySeverity[i.severity]++;
        byRule[i.rule] = (byRule[i.rule] ?? 0) + 1;
      }
      return {
        generatedAt: new Date().toISOString(),
        timeZone: academyTz,
        scope: opts.studentId ? { studentId: opts.studentId } : 'all',
        checked: { students: studentIds.size, plans: plans.length, installments: installments.length, payments: payments.length, discounts: discounts.length, refunds: refunds.length, adjustments: adjustments.length, ledgerEntries: ledger.length },
        ok: bySeverity.ERROR === 0,
        bySeverity,
        byRule,
        issues,
      };
    },
    { isolationLevel: 'RepeatableRead', timeout: 120_000 },
  );
}
