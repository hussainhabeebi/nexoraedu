/** Wire approval types to the domain actions they unlock (SRS §22). */
import { registerApprovalHandler } from './approvals';
import { admitApplication } from './admissions';
import { applyDiscount, cancelPayment } from './finance';
import { getSettings } from '../lib/settings';
import { notifyLater } from './notify';
import { computeResult } from './exams';
import { badRequest } from '../lib/http';

export function registerHandlers() {
  // SRS 22.2: privileged roles are added only after a second Super Administrator approves.
  registerApprovalHandler('USER_PRIVILEGE', {
    onApprove: async (tx, r, actor) => {
      const u = await tx.user.findUniqueOrThrow({ where: { id: r.entityId }, include: { roles: { include: { role: true } } } });
      if (!u.isActive) throw badRequest('The user has been deactivated since the request was made.');
      const add: string[] = r.payload?.add ?? [];
      const roles = await tx.role.findMany({ where: { key: { in: add } } });
      for (const role of roles) {
        if (!u.roles.some((x) => x.roleId === role.id)) await tx.userRole.create({ data: { userId: u.id, roleId: role.id } });
      }
      // New permissions on the next request; MFA becomes mandatory (sessions without MFA are limited to enrolment).
      await tx.user.update({ where: { id: u.id }, data: { authVersion: { increment: 1 } } });
      await tx.auditLog.create({ data: { userId: actor, action: 'GRANT_PRIVILEGED_ROLES', entity: 'user', entityId: u.id, oldValues: { roles: u.roles.map((x) => x.role.key) }, newValues: { added: roles.map((x) => x.key), approvalId: r.id } } });
    },
  });

  registerApprovalHandler('ADMISSION', {
    onApprove: async (tx, r, actor) => {
      await admitApplication(tx, r.entityId, r.payload ?? {}, actor);
    },
    onReject: async (tx, r) => {
      await tx.application.update({ where: { id: r.entityId }, data: { status: 'UNDER_REVIEW' } });
    },
  });

  registerApprovalHandler('DISCOUNT', {
    onApprove: (tx, r, actor) => applyDiscount(tx, r.entityId, actor),
    onReject: async (tx, r) => {
      await tx.discount.update({ where: { id: r.entityId }, data: { status: 'REJECTED' } });
    },
  });

  registerApprovalHandler('REFUND', {
    onApprove: async (tx, r) => {
      await tx.refund.update({ where: { id: r.entityId }, data: { status: 'APPROVED' } });
    },
    onReject: async (tx, r) => {
      await tx.refund.update({ where: { id: r.entityId }, data: { status: 'REJECTED' } });
    },
  });

  registerApprovalHandler('PAYMENT_CANCELLATION', {
    onApprove: (tx, r, actor) => cancelPayment(tx, r.entityId, actor),
    onReject: async (tx, r) => {
      await tx.payment.update({ where: { id: r.entityId }, data: { status: 'POSTED' } });
    },
  });

  registerApprovalHandler('BATCH_TRANSFER', {
    onApprove: async (tx, r, actor) => {
      const st = await tx.student.findUniqueOrThrow({ where: { id: r.entityId }, include: { batch: true } });
      const to = await tx.batch.findUniqueOrThrow({ where: { id: r.payload.toBatchId } });
      await tx.student.update({ where: { id: st.id }, data: { batchId: to.id, courseId: to.courseId } });
      await tx.studentHistory.create({ data: { studentId: st.id, type: 'BATCH', message: `Transferred ${st.batch?.code ?? '—'} → ${to.code}. Reason: ${r.payload.reason}`, userId: actor } });
    },
  });

  registerApprovalHandler('RESULT_CORRECTION', {
    onApprove: async (tx, r, actor) => {
      const res = await tx.result.findUniqueOrThrow({ where: { id: r.entityId }, include: { exam: true } });
      const s = await getSettings();
      const c = computeResult(r.payload.newMarks, res.exam.totalMarks, res.exam.passMarks, s.exams.gradeScale);
      await tx.result.update({ where: { id: res.id }, data: { marks: r.payload.newMarks, ...c, remarks: `Corrected: ${r.payload.reason}` } });
      await tx.studentHistory.create({
        data: { studentId: res.studentId, type: 'RESULT', message: `Result corrected for ${res.exam.title}: ${res.marks} → ${r.payload.newMarks}`, data: { old: res.marks, new: r.payload.newMarks }, userId: actor },
      });
      const st = await tx.student.findUniqueOrThrow({ where: { id: res.studentId } });
      notifyLater('result.corrected', { userId: st.userId, name: st.fullName, phone: st.phone, email: st.email }, { name: st.fullName, exam: res.exam.title, marks: r.payload.newMarks });
    },
  });

  registerApprovalHandler('CERTIFICATE', {
    onApprove: async (tx, r) => {
      const c = await tx.certificate.update({ where: { id: r.entityId }, data: { status: 'ISSUED', issuedAt: new Date() }, include: { student: true } });
      await tx.studentHistory.create({ data: { studentId: c.studentId, type: 'CERTIFICATE', message: `Certificate ${c.number} issued` } });
      notifyLater('certificate.issued', { userId: c.student.userId, name: c.student.fullName, phone: c.student.phone, email: c.student.email }, { name: c.student.fullName, number: c.number, code: c.verificationCode });
    },
    onReject: async (tx, r) => {
      await tx.certificate.update({ where: { id: r.entityId }, data: { status: 'REVOKED' } });
    },
  });

  registerApprovalHandler('ATTENDANCE_EDIT', {
    onApprove: async (tx, r, actor) => {
      await tx.attendance.upsert({
        where: { sessionId_studentId: { sessionId: r.payload.sessionId, studentId: r.payload.studentId } },
        create: { sessionId: r.payload.sessionId, studentId: r.payload.studentId, status: r.payload.status, markedById: actor },
        update: { status: r.payload.status, markedById: actor, markedAt: new Date() },
      });
    },
  });

  registerApprovalHandler('EXAM_REATTEMPT', {
    onApprove: async (tx, r) => {
      await tx.examAssignment.upsert({
        where: { examId_studentId: { examId: r.payload.examId, studentId: r.payload.studentId } },
        create: { examId: r.payload.examId, studentId: r.payload.studentId },
        update: {},
      });
      // Re-attempts: mark the extra attempt allowance in the payload by archiving previous attempts' status
      if (r.payload.reattempt) await tx.examAttempt.updateMany({ where: { examId: r.payload.examId, studentId: r.payload.studentId }, data: { status: 'VOIDED' } });
    },
  });
}
