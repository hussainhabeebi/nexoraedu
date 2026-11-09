/**
 * Object-level authorization (R5; FR-AZ-02, API-08, FR-DOC-02, DSH-09, SRS 6.12).
 * Route guards (`can(...)`) decide WHAT a user may do; these helpers decide WHICH records.
 */
import type { Prisma } from '#prisma';
import type { AuthUser } from './auth';
import { hasPerm } from './permissions';
import { prisma } from './prisma';

/** Batches where the user is allocated faculty or teaches a timetable session. */
export async function facultyBatchIds(userId: string): Promise<string[]> {
  const [alloc, sessions] = await Promise.all([
    prisma.facultyAllocation.findMany({ where: { facultyId: userId }, select: { batchId: true } }),
    prisma.timetableSession.findMany({ where: { facultyId: userId }, select: { batchId: true }, distinct: ['batchId'] }),
  ]);
  return [...new Set([...alloc.map((a) => a.batchId), ...sessions.map((s) => s.batchId)])];
}

const can = (u: AuthUser, p: string) => hasPerm(u.perms, p);

/**
 * Prisma filter for the students a user may read. `{}` = all, `null` = none.
 *   students:read       → all students           (Admin, Management, Sales/Finance/Academic managers, Exam officer…)
 *   students:read_batch → students in own batches (Faculty)
 *   students:read_own   → students converted from own leads (Counselor, decision C8)
 *   portal:student      → only themselves
 */
export async function studentScope(u: AuthUser): Promise<Prisma.StudentWhereInput | null> {
  if (can(u, 'students:read') || can(u, 'students:manage')) return {};
  const or: Prisma.StudentWhereInput[] = [];
  if (can(u, 'students:read_batch')) or.push({ batchId: { in: await facultyBatchIds(u.id) } });
  if (can(u, 'students:read_own')) or.push({ lead: { ownerId: u.id } });
  if (u.studentId) or.push({ id: u.studentId });
  if (!or.length) return null;
  return or.length === 1 ? or[0] : { OR: or };
}

export async function canAccessStudent(u: AuthUser, studentId: string): Promise<boolean> {
  const scope = await studentScope(u);
  if (!scope) return false;
  return (await prisma.student.count({ where: { AND: [{ id: studentId }, scope] } })) > 0;
}

/** Batch filter for faculty-scoped academic data (attendance, results). `null` = unrestricted. */
export async function batchScopeIds(u: AuthUser): Promise<string[] | null> {
  if (can(u, 'students:read') || can(u, 'academics:manage') || can(u, 'exams:manage')) return null;
  return facultyBatchIds(u.id);
}

/**
 * Identity documents (ID proofs, marksheets — often of minors), FR-DOC-02 / SEC-09.
 * Management decision 2 (2026-11-05): ONLY authorised Administration staff (documents:verify or
 * students:manage) and the Super Administrator. Counselors, Sales, Finance, Academic, Faculty, Exam,
 * Management and students themselves are refused.
 */
export async function canAccessDocument(u: AuthUser, _doc: { studentId: string | null; applicationId: string | null }): Promise<boolean> {
  return can(u, 'documents:verify') || can(u, 'students:manage');
}

/** Batch-level access for academic records (materials, assignments, grading, corrections). */
export async function canAccessBatch(u: AuthUser, batchId: string | null | undefined): Promise<boolean> {
  const scope = await batchScopeIds(u);
  if (!scope) return true;
  return !!batchId && scope.includes(batchId);
}
