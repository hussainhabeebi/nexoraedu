/**
 * Enrollment history (SRS 20.4, 20.12, STU-09, STU-10, STU-13, 21.3).
 *
 * Business rules (derived from the SRS and the existing model — see report for open decisions):
 *  E1 A student has many enrollments over time; rows are never deleted (history is preserved).
 *  E2 At most ONE current enrollment (ACTIVE or ON_HOLD) per student — the existing model keeps one current
 *     course/batch per student. Enforced by a partial unique index and checked here.
 *  E3 Enrollments are created only by: admission (existing Sales Manager approval, 22.3 / CRM-13), direct
 *     registration (existing STU-01 path), an approved BATCH_TRANSFER (batch transfer or course change, STU-10),
 *     or re-activation of a closed student through the existing status change (STU-13).
 *  E4 A transfer / course change CLOSES the current enrollment as TRANSFERRED and opens a new one linked to it;
 *     allotting a batch to an enrollment that has none (same course) updates that enrollment instead.
 *  E5 Student status changes (STU-13) keep the current enrollment in step: ON_HOLD ↔ ACTIVE; COMPLETED, WITHDRAWN,
 *     TERMINATED close it with the same status.
 *  E6 CANCELLED is for an enrollment recorded in error or abandoned before any study or payment: only allowed
 *     when it has no attendance and no non-cancelled payments. Fee plans are never modified here.
 *  E7 Every change is audit-logged in the same transaction and noted in the immutable student history.
 *  students.courseId / batchId always mirror the current (or most recent) enrollment for existing code paths.
 */
import type { Prisma } from '@prisma/client';
import { badRequest, conflict, notFound } from '../lib/http';
import { assertBatchAvailable } from './admissions';

type Tx = Prisma.TransactionClient;

export const CURRENT_STATUSES = ['ACTIVE', 'ON_HOLD'] as const;
export const CLOSED_STATUSES = ['COMPLETED', 'TRANSFERRED', 'WITHDRAWN', 'TERMINATED', 'CANCELLED'] as const;
export type EnrollmentSource = 'ADMISSION' | 'DIRECT' | 'TRANSFER' | 'COURSE_CHANGE' | 'REACTIVATION' | 'BACKFILL';

const auditAs = (tx: Tx, actorId: string | null | undefined, action: string, entityId: string, oldValues: unknown, newValues: unknown) =>
  tx.auditLog.create({ data: { userId: actorId ?? undefined, action, entity: 'enrollment', entityId, oldValues: (oldValues ?? undefined) as any, newValues: (newValues ?? undefined) as any } });

export const currentEnrollment = (tx: Tx, studentId: string) =>
  tx.enrollment.findFirst({ where: { studentId, status: { in: [...CURRENT_STATUSES] } } });

/** E1/E2: open a new current enrollment and point the student at it. */
export async function openEnrollment(
  tx: Tx,
  p: { studentId: string; courseId: string; batchId: string | null; source: EnrollmentSource; applicationId?: string | null; approvalRequestId?: string | null; previousEnrollmentId?: string | null; startDate?: Date; actorId?: string | null; reason?: string; capacityChecked?: boolean },
) {
  // Serialise enrollment changes per student (same lock the finance code uses).
  await tx.$queryRaw`SELECT id FROM students WHERE id = ${p.studentId} FOR UPDATE`;
  const cur = await currentEnrollment(tx, p.studentId);
  if (cur) throw conflict('The student already has a current enrollment. Transfer, complete or close it first.', { enrollmentId: cur.id });
  if (p.batchId && !p.capacityChecked) await assertBatchAvailable(tx, p.batchId, p.courseId);
  const e = await tx.enrollment.create({
    data: {
      studentId: p.studentId, courseId: p.courseId, batchId: p.batchId, status: 'ACTIVE', source: p.source, startDate: p.startDate ?? new Date(),
      applicationId: p.applicationId ?? null, approvalRequestId: p.approvalRequestId ?? null, previousEnrollmentId: p.previousEnrollmentId ?? null, createdById: p.actorId ?? null,
    },
  });
  await tx.student.update({ where: { id: p.studentId }, data: { courseId: p.courseId, batchId: p.batchId } });
  await auditAs(tx, p.actorId, 'ENROLLMENT_CREATE', e.id, null, { studentId: p.studentId, courseId: p.courseId, batchId: p.batchId, source: p.source, applicationId: p.applicationId, approvalRequestId: p.approvalRequestId, previousEnrollmentId: p.previousEnrollmentId, reason: p.reason });
  return e;
}

export async function closeEnrollment(tx: Tx, enrollmentId: string, status: (typeof CLOSED_STATUSES)[number], reason: string, actorId?: string | null) {
  const e = await tx.enrollment.findUniqueOrThrow({ where: { id: enrollmentId } });
  if (!(CURRENT_STATUSES as readonly string[]).includes(e.status)) throw conflict(`This enrollment is already ${e.status.toLowerCase()}.`);
  const closed = await tx.enrollment.update({ where: { id: e.id }, data: { status, endedAt: new Date(Math.max(Date.now(), e.startDate.getTime())), endReason: reason } });
  await auditAs(tx, actorId, `ENROLLMENT_${status}`, e.id, { status: e.status }, { status, reason });
  return closed;
}

/** E4: approved BATCH_TRANSFER (batch transfer or course change). */
export async function transferEnrollment(tx: Tx, p: { studentId: string; toBatchId: string; reason: string; approvalRequestId: string; actorId: string }) {
  await tx.$queryRaw`SELECT id FROM students WHERE id = ${p.studentId} FOR UPDATE`;
  const to = await tx.batch.findUniqueOrThrow({ where: { id: p.toBatchId } });
  const cur = await currentEnrollment(tx, p.studentId);
  if (!cur) throw badRequest('The student has no current enrollment to transfer. Re-activate the student first.');
  if (cur.batchId === to.id) throw badRequest('The student is already enrolled in this batch.');
  await assertBatchAvailable(tx, to.id, to.courseId); // capacity re-checked (and locked) at approval time
  if (!cur.batchId && cur.courseId === to.courseId) {
    // Batch allotment for an enrollment admitted "batch to be allotted": same enrollment, not a transfer.
    const e = await tx.enrollment.update({ where: { id: cur.id }, data: { batchId: to.id } });
    await tx.student.update({ where: { id: p.studentId }, data: { batchId: to.id } });
    await auditAs(tx, p.actorId, 'ENROLLMENT_BATCH_ALLOTTED', e.id, { batchId: null }, { batchId: to.id, approvalRequestId: p.approvalRequestId, reason: p.reason });
    return { closed: null, opened: e, courseChanged: false };
  }
  const courseChanged = cur.courseId !== to.courseId;
  const closed = await closeEnrollment(tx, cur.id, 'TRANSFERRED', p.reason, p.actorId);
  const opened = await openEnrollment(tx, { studentId: p.studentId, courseId: to.courseId, batchId: to.id, source: courseChanged ? 'COURSE_CHANGE' : 'TRANSFER', approvalRequestId: p.approvalRequestId, previousEnrollmentId: cur.id, applicationId: cur.applicationId, actorId: p.actorId, reason: p.reason, capacityChecked: true });
  return { closed, opened, courseChanged };
}

/**
 * E5: keep the current enrollment in step with a student status change (STU-13).
 * Returns a note for the response/history when something relevant happened.
 */
export async function syncEnrollmentWithStudentStatus(tx: Tx, studentId: string, from: string, to: string, reason: string, actorId: string) {
  const cur = await currentEnrollment(tx, studentId);
  if (['COMPLETED', 'WITHDRAWN', 'TERMINATED'].includes(to)) {
    if (cur) await closeEnrollment(tx, cur.id, to as any, reason, actorId);
    return cur ? `Enrollment ${to.toLowerCase()}.` : null;
  }
  if (to === 'ON_HOLD') {
    if (!cur) throw badRequest('The student has no current enrollment to put on hold.');
    if (cur.status !== 'ON_HOLD') {
      await tx.enrollment.update({ where: { id: cur.id }, data: { status: 'ON_HOLD' } });
      await auditAs(tx, actorId, 'ENROLLMENT_ON_HOLD', cur.id, { status: cur.status }, { status: 'ON_HOLD', reason });
    }
    return null;
  }
  if (to === 'ACTIVE' || to === 'ADMITTED') {
    if (cur) {
      if (cur.status === 'ON_HOLD') {
        await tx.enrollment.update({ where: { id: cur.id }, data: { status: 'ACTIVE' } });
        await auditAs(tx, actorId, 'ENROLLMENT_RESUMED', cur.id, { status: 'ON_HOLD' }, { status: 'ACTIVE', reason });
      }
      return null;
    }
    // Re-activation of a closed student (existing STU-13 status change): a NEW enrollment in the most recent
    // course/batch, so the closed history stays untouched. Capacity applies.
    const last = await tx.enrollment.findFirst({ where: { studentId }, orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }] });
    const st = await tx.student.findUniqueOrThrow({ where: { id: studentId } });
    const batch = last?.batchId ?? st.batchId;
    const okBatch = batch ? await tx.batch.findUnique({ where: { id: batch } }) : null;
    await openEnrollment(tx, {
      studentId, courseId: last?.courseId ?? st.courseId, batchId: okBatch && !['COMPLETED', 'CANCELLED'].includes(okBatch.status) ? okBatch.id : null,
      source: 'REACTIVATION', previousEnrollmentId: last?.id ?? null, applicationId: last?.applicationId ?? null, actorId, reason,
    });
    return `Re-activated from ${from}: a new enrollment was opened${okBatch && !['COMPLETED', 'CANCELLED'].includes(okBatch.status) ? '' : ' without a batch (previous batch has ended — allot one by transfer)'}.`;
  }
  return null; // APPLIED: no enrollment effect
}

/** E6: cancel an enrollment recorded in error / abandoned before any study or payment. */
export async function cancelEnrollment(tx: Tx, p: { studentId: string; enrollmentId: string; reason: string; actorId: string }) {
  await tx.$queryRaw`SELECT id FROM students WHERE id = ${p.studentId} FOR UPDATE`;
  const e = await tx.enrollment.findFirst({ where: { id: p.enrollmentId, studentId: p.studentId }, include: { feePlans: { select: { id: true } } } });
  if (!e) throw notFound('Enrollment not found');
  if (!(CURRENT_STATUSES as readonly string[]).includes(e.status)) throw conflict(`Only a current enrollment can be cancelled (this one is ${e.status.toLowerCase()}).`);
  const attended = await tx.attendance.count({ where: { OR: [{ enrollmentId: e.id }, ...(e.batchId ? [{ studentId: p.studentId, enrollmentId: null, session: { batchId: e.batchId, startsAt: { gte: e.startDate } } }] : [])] } });
  if (attended) throw conflict('This enrollment already has attendance. Withdraw the student instead of cancelling.');
  const planIds = e.feePlans.map((f) => f.id);
  const paid = planIds.length ? await tx.paymentAllocation.count({ where: { installment: { feePlanId: { in: planIds } }, payment: { status: { not: 'CANCELLED' } } } }) : 0;
  if (paid) throw conflict('Payments are recorded against this enrollment. Cancel the receipts (approval) or withdraw the student instead.');
  const closed = await closeEnrollment(tx, e.id, 'CANCELLED', p.reason, p.actorId);
  const openPlans = planIds.length ? await tx.installment.count({ where: { feePlanId: { in: planIds }, status: { in: ['DUE', 'PARTIAL'] } } }) : 0;
  return { enrollment: closed, openFeePlanInstallments: openPlans };
}
