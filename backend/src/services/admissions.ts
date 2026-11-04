/** Application → Admission → Student conversion without re-entry (CRM-12/13/14, STU-01). */
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { badRequest, conflict } from '../lib/http';
import { nextNumber } from '../lib/sequence';
import { getSettings } from '../lib/settings';
import { normalizeEmail, normalizePhone, randomPassword } from '../lib/util';
import { createFeePlan } from './finance';
import { notifyLater } from './notify';

type Tx = Prisma.TransactionClient;

export const guardianSchema = z.object({
  name: z.string().min(2),
  relation: z.string().min(2),
  phone: z.string().min(7),
  email: z.string().email().optional().or(z.literal('')),
  occupation: z.string().optional(),
});
export const educationSchema = z.object({
  level: z.string().min(1),
  institution: z.string().min(2),
  board: z.string().optional(),
  year: z.coerce.number().int().min(1950).max(2100).optional(),
  marks: z.string().optional(),
});
export const applicationDataSchema = z.object({
  personal: z.object({
    fullName: z.string().min(2).max(120),
    dob: z.coerce.date(),
    gender: z.enum(['Male', 'Female', 'Other']),
    phone: z.string().min(7).max(20),
    email: z.string().email(),
    address: z.string().min(5),
    city: z.string().optional(),
  }),
  guardians: z.array(guardianSchema).default([]),
  education: z.array(educationSchema).default([]),
  preferences: z.object({ courseId: z.string(), batchId: z.string().optional().nullable(), mode: z.string().optional() }),
  declaration: z.literal(true).optional(),
});
export type ApplicationData = z.infer<typeof applicationDataSchema>;

export function ageOn(dob: Date, at = new Date()) {
  let a = at.getFullYear() - dob.getFullYear();
  const m = at.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && at.getDate() < dob.getDate())) a--;
  return a;
}

/** STU-07: guardian required under 18. */
export function validateApplicationData(d: ApplicationData) {
  if (ageOn(new Date(d.personal.dob)) < 18 && d.guardians.length === 0) throw badRequest('Guardian details are required for applicants under 18.');
}

/** STU-03 duplicate detection by phone & email. */
export async function assertNoDuplicateStudent(tx: Tx, phone: string, email: string, exceptId?: string) {
  const dup = await tx.student.findFirst({
    where: { OR: [{ phoneNormalized: normalizePhone(phone) }, { emailNormalized: normalizeEmail(email)! }], NOT: exceptId ? { id: exceptId } : undefined },
    select: { studentCode: true, fullName: true },
  });
  if (dup) throw conflict(`A student with this phone or email already exists (${dup.studentCode} — ${dup.fullName}).`, dup);
}

/** STU-09 capacity + course match. */
export async function assertBatchAvailable(tx: Tx, batchId: string, courseId: string) {
  const b = await tx.batch.findUnique({ where: { id: batchId }, include: { _count: { select: { students: { where: { status: { in: ['ADMITTED', 'ACTIVE', 'ON_HOLD'] } } } } } } });
  if (!b) throw badRequest('Selected batch does not exist.');
  if (b.courseId !== courseId) throw badRequest('Selected batch does not belong to the chosen course.');
  if (['COMPLETED', 'CANCELLED'].includes(b.status)) throw badRequest('Selected batch is not open for admission.');
  if (b._count.students >= b.capacity) throw conflict(`Batch ${b.code} is full (${b.capacity} seats).`);
  return b;
}

export async function admitApplication(tx: Tx, applicationId: string, opts: { batchId?: string | null; installments?: number }, actorId: string) {
  const app = await tx.application.findUniqueOrThrow({ where: { id: applicationId }, include: { lead: true } });
  if (app.status === 'ADMITTED') return app.studentId!;
  const data = applicationDataSchema.parse(app.data);
  const p = data.personal;
  await assertNoDuplicateStudent(tx, p.phone, p.email);
  const batchId = opts.batchId ?? app.batchId ?? data.preferences.batchId ?? null;
  if (batchId) await assertBatchAvailable(tx, batchId, app.courseId);

  const s = await getSettings();
  const studentCode = await nextNumber(`student:${new Date().getFullYear()}`, s.ids.student, tx);
  const tempPassword = randomPassword();
  const studentRole = await tx.role.findUniqueOrThrow({ where: { key: 'student' } });
  const emailN = normalizeEmail(p.email)!;
  const existingUser = await tx.user.findUnique({ where: { email: emailN } });
  if (existingUser) throw conflict('A portal user with this email already exists.');
  const user = await tx.user.create({
    data: {
      email: emailN,
      username: studentCode.toLowerCase(),
      name: p.fullName,
      phone: p.phone,
      passwordHash: await bcrypt.hash(tempPassword, 10),
      mustChangePassword: true,
      roles: { create: { roleId: studentRole.id } },
    },
  });
  const student = await tx.student.create({
    data: {
      studentCode,
      userId: user.id,
      fullName: p.fullName,
      dob: new Date(p.dob),
      gender: p.gender,
      phone: p.phone,
      phoneNormalized: normalizePhone(p.phone),
      email: p.email,
      emailNormalized: emailN,
      address: p.address,
      city: p.city,
      courseId: app.courseId,
      batchId,
      status: 'ADMITTED',
      chatwootContactId: app.lead?.chatwootContactId,
      guardians: { create: data.guardians.map((g) => ({ ...g, email: g.email || null })) },
      education: { create: data.education },
    },
    include: { course: true, batch: true },
  });
  await tx.document.updateMany({ where: { applicationId: app.id }, data: { studentId: student.id } });
  await tx.application.update({ where: { id: app.id }, data: { status: 'ADMITTED', studentId: student.id } });
  if (app.leadId) {
    await tx.lead.update({ where: { id: app.leadId }, data: { status: 'ADMITTED', studentId: student.id, lastActivityAt: new Date() } });
    await tx.leadActivity.create({ data: { leadId: app.leadId, type: 'STATUS', content: `Admitted as ${studentCode}`, userId: actorId } });
  }
  await tx.studentHistory.create({ data: { studentId: student.id, type: 'STATUS', message: `Admitted to ${student.course.name}${student.batch ? ` (${student.batch.code})` : ''}`, userId: actorId } });
  await createFeePlan(tx, { studentId: student.id, courseId: app.courseId, installments: opts.installments, startDate: new Date(), userId: actorId });

  notifyLater(
    'admission.confirmed',
    { userId: user.id, name: student.fullName, email: student.email, phone: student.phone, conversationId: app.lead?.chatwootConversationId },
    { name: student.fullName, studentCode, course: student.course.name, batch: student.batch?.name ?? 'to be allotted', username: studentCode.toLowerCase(), password: tempPassword, portalUrl: process.env.PUBLIC_APP_URL ?? '' },
  );
  return student.id;
}
