/**
 * Deleting setup items (courses, subjects, modules, batches, timetable sessions, questions, exams, departments).
 *
 * Rule: an item can always be edited, but it can be DELETED only while nothing uses it. If it is in use the
 * request is refused (409 IN_USE) with what uses it and the safe alternative (deactivate / cancel / retire).
 * The "not in use" check is repeated INSIDE the same atomic D1 batch as the delete, so nothing can start using
 * the item between the check and the delete. Every delete is audit-logged with the deleted row.
 * Students, payments, receipts, ledger, approvals, users and logs are never deletable (they have their own
 * withdraw / cancel / deactivate flows), and master-list items stay "deactivated, never deleted" (ADM-07).
 */
import type { Request } from 'express';
import { prisma } from '../lib/prisma';
import { atomic, sqlName, type Tx } from '../lib/db';
import { audit } from '../lib/audit';
import { HttpError, notFound } from '../lib/http';

/** A record type that may point at the item: model + the field holding the item's id, with a readable label. */
type Ref = { model: string; field: string; label: string };

const delegate = (model: string) => (prisma as any)[model[0].toLowerCase() + model.slice(1)];

export type DeleteSpec = {
  model: string; // Prisma model of the item
  entity: string; // audit entity name
  label: string; // e.g. "course"
  refs: Ref[]; // anything listed here blocks the delete
  alternative: string; // what to do instead when in use
  /** Rows that belong to the item and are removed with it (setup data only), deleted before the item. */
  children?: (tx: Tx, id: string) => Promise<void>;
  /** Extra in-use checks (e.g. children's own references). Return blocking reasons. */
  extraRefs?: (id: string) => Promise<{ reason: string; sql: string; params: unknown[] }[]>;
};

export class InUse extends HttpError {
  constructor(label: string, uses: string[], alternative: string) {
    super(409, `This ${label} cannot be deleted because it is in use (${uses.join(', ')}). ${alternative}`, 'IN_USE', { uses });
  }
}

async function usage(spec: DeleteSpec, id: string) {
  const uses: string[] = [];
  const checks: { sql: string; params: unknown[] }[] = [];
  for (const r of spec.refs) {
    const n = await delegate(r.model).count({ where: { [r.field]: id } });
    if (n) uses.push(`${n} ${r.label}`);
    checks.push({ sql: `NOT EXISTS (SELECT 1 FROM ${sqlName(r.model)} WHERE ${sqlName(r.model, r.field)} = ?)`, params: [id] });
  }
  for (const x of (await spec.extraRefs?.(id)) ?? []) {
    if (x.reason) uses.push(x.reason);
    checks.push({ sql: x.sql, params: x.params });
  }
  return { uses, checks };
}

export async function deleteIfUnused(spec: DeleteSpec, id: string, req: Request) {
  const before = await delegate(spec.model).findUnique({ where: { id } });
  if (!before) throw notFound(`${spec.label[0].toUpperCase()}${spec.label.slice(1)} not found`);
  const { uses, checks } = await usage(spec, id);
  if (uses.length) throw new InUse(spec.label, uses, spec.alternative);
  const raced = `This ${spec.label} is now in use and was not deleted.`;
  try {
    await atomic(async (tx) => {
      // Re-checked at commit time: if anything started using the item meanwhile, the whole batch is rolled back.
      for (const c of checks) tx.assert(c.sql, c.params, raced);
      await spec.children?.(tx, id);
      await (tx as any)[spec.model[0].toLowerCase() + spec.model.slice(1)].delete({ where: { id } });
      await audit(tx, req, 'DELETE', spec.entity, id, before, null);
    });
  } catch (e) {
    if (String((e as any)?.message ?? e).includes(raced)) throw new InUse(spec.label, ['started being used just now'], spec.alternative);
    throw e;
  }
  return { deleted: true, id };
}

/** "Subject X is used by …" checks for every subject of a course (a course delete also removes its subjects). */
const SUBJECT_REFS: Ref[] = [
  { model: 'TimetableSession', field: 'subjectId', label: 'timetable sessions' },
  { model: 'Material', field: 'subjectId', label: 'study materials' },
  { model: 'Assignment', field: 'subjectId', label: 'assignments' },
  { model: 'Question', field: 'subjectId', label: 'questions' },
  { model: 'Exam', field: 'subjectId', label: 'exams' },
  { model: 'FacultyAllocation', field: 'subjectId', label: 'faculty allocations' },
];

export const DELETE_SPECS = {
  course: {
    model: 'Course', entity: 'course', label: 'course',
    refs: [
      { model: 'Batch', field: 'courseId', label: 'batches' },
      { model: 'Student', field: 'courseId', label: 'students' },
      { model: 'Enrollment', field: 'courseId', label: 'enrollments' },
      { model: 'Lead', field: 'courseId', label: 'leads' },
      { model: 'Application', field: 'courseId', label: 'applications' },
      { model: 'FeePlan', field: 'courseId', label: 'fee plans' },
      { model: 'Material', field: 'courseId', label: 'study materials' },
      { model: 'Question', field: 'courseId', label: 'questions' },
      { model: 'Exam', field: 'courseId', label: 'exams' },
      { model: 'Certificate', field: 'courseId', label: 'certificates' },
    ],
    alternative: 'Switch it to inactive instead: it then no longer appears on the website or for new admissions.',
    extraRefs: async (courseId: string) => {
      const subjects = await prisma.subject.findMany({ where: { courseId }, select: { id: true } });
      const out: { reason: string; sql: string; params: unknown[] }[] = [];
      for (const r of SUBJECT_REFS) {
        const n = subjects.length ? await delegate(r.model).count({ where: { [r.field]: { in: subjects.map((s) => s.id) } } }) : 0;
        out.push({
          reason: n ? `${n} ${r.label} of its subjects` : '',
          sql: `NOT EXISTS (SELECT 1 FROM ${sqlName(r.model)} x JOIN ${sqlName('Subject')} s ON s.${sqlName('Subject', 'id')} = x.${sqlName(r.model, r.field)} WHERE s.${sqlName('Subject', 'courseId')} = ?)`,
          params: [courseId],
        });
      }
      return out;
    },
    children: async (tx: Tx, courseId: string) => {
      const subjects = await tx.subject.findMany({ where: { courseId }, select: { id: true } });
      if (subjects.length) await tx.module.deleteMany({ where: { subjectId: { in: subjects.map((s) => s.id) } } });
      await tx.subject.deleteMany({ where: { courseId } });
      await tx.feeComponent.deleteMany({ where: { courseId } });
    },
  },
  subject: {
    model: 'Subject', entity: 'subject', label: 'subject', refs: SUBJECT_REFS,
    alternative: 'Switch it to inactive instead.',
    children: async (tx: Tx, subjectId: string) => {
      await tx.module.deleteMany({ where: { subjectId } });
    },
  },
  module: { model: 'Module', entity: 'module', label: 'module', refs: [], alternative: 'Switch it to inactive instead.' },
  batch: {
    model: 'Batch', entity: 'batch', label: 'batch',
    refs: [
      { model: 'Student', field: 'batchId', label: 'students' },
      { model: 'Enrollment', field: 'batchId', label: 'enrollments' },
      { model: 'Application', field: 'batchId', label: 'applications' },
      { model: 'TimetableSession', field: 'batchId', label: 'timetable sessions' },
      { model: 'FacultyAllocation', field: 'batchId', label: 'faculty allocations' },
      { model: 'Material', field: 'batchId', label: 'study materials' },
      { model: 'Assignment', field: 'batchId', label: 'assignments' },
      { model: 'Exam', field: 'batchId', label: 'exams' },
    ],
    alternative: 'Set its status to Cancelled or Completed instead.',
  },
  session: {
    model: 'TimetableSession', entity: 'timetable_session', label: 'timetable session',
    refs: [{ model: 'Attendance', field: 'sessionId', label: 'attendance records' }],
    alternative: 'Cancel the session instead.',
  },
  question: {
    model: 'Question', entity: 'question', label: 'question',
    refs: [{ model: 'ExamQuestion', field: 'questionId', label: 'exams' }],
    alternative: 'Retire the question instead.',
  },
  exam: {
    model: 'Exam', entity: 'exam', label: 'exam',
    refs: [
      { model: 'ExamAssignment', field: 'examId', label: 'assigned students' },
      { model: 'ExamAttempt', field: 'examId', label: 'attempts' },
      { model: 'Result', field: 'examId', label: 'results' },
    ],
    alternative: 'Exams that have been assigned, attempted or graded are kept as part of the academic record.',
    children: async (tx: Tx, examId: string) => {
      await tx.examQuestion.deleteMany({ where: { examId } }); // the draft's question list
    },
  },
  department: {
    model: 'Department', entity: 'department', label: 'department',
    refs: [{ model: 'User', field: 'departmentId', label: 'users' }],
    alternative: 'Move its users to another department first, or switch it to inactive.',
  },
} satisfies Record<string, DeleteSpec>;
