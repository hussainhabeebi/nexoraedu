/** Student self-service portal (SRS §6.11, UI-19) incl. online examination engine (EXM-08..11). */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ah, badRequest, conflict, forbidden, notFound } from '../lib/http';
import { can } from '../lib/auth';
import { getSettings } from '../lib/settings';
import { money } from '../lib/util';
import { studentBalance } from '../services/finance';
import { autoGrade } from '../services/exams';
import { receiptPdf } from './finance';
import { certificatePdf } from './exams';
import { studentAttendancePct } from './academics';

const r = Router();
r.use(can('portal:student'));

async function me(req: Request) {
  const id = req.user!.studentId;
  if (!id) throw forbidden('No student profile is linked to this account.');
  return prisma.student.findUniqueOrThrow({ where: { id }, include: { course: true, batch: true } });
}

r.get('/me', ah(async (req, res) => {
  const s = await me(req);
  const now = new Date();
  const [guardians, attendance, balance, upcoming, nextInst, results, exams, notifications] = await Promise.all([
    prisma.guardian.findMany({ where: { studentId: s.id } }),
    studentAttendancePct(s.id),
    studentBalance(s.id),
    s.batchId ? prisma.timetableSession.findMany({ where: { batchId: s.batchId, published: true, cancelled: false, startsAt: { gte: now } }, orderBy: { startsAt: 'asc' }, take: 5 }) : [],
    prisma.installment.findFirst({ where: { feePlan: { studentId: s.id }, status: { not: 'PAID' } }, orderBy: { dueDate: 'asc' } }),
    prisma.result.findMany({ where: { studentId: s.id, exam: { resultsPublished: true } }, include: { exam: { select: { title: true, totalMarks: true, type: true } } }, orderBy: { createdAt: 'desc' }, take: 5 }),
    prisma.examAssignment.findMany({ where: { studentId: s.id, exam: { status: 'SCHEDULED', endAt: { gte: now } } }, include: { exam: { select: { id: true, title: true, startAt: true, endAt: true, durationMin: true, mode: true } } } }),
    prisma.notification.count({ where: { userId: req.user!.id, readAt: null } }),
  ]);
  const st = await getSettings();
  res.json({
    student: s, guardians, attendance: { ...attendance, threshold: st.academics.attendanceThreshold }, balance,
    nextDue: nextInst ? { amount: money(Number(nextInst.amount) - Number(nextInst.paidAmount)), dueDate: nextInst.dueDate, seq: nextInst.seq } : null,
    upcoming, results, exams: exams.map((e) => e.exam), unreadNotifications: notifications,
    paymentInfo: { upi: process.env.ACADEMY_UPI_ID || null, bank: process.env.ACADEMY_BANK_DETAILS || null },
  });
}));

r.get('/enrollments', ah(async (req, res) => {
  const s = await me(req);
  const items = await prisma.enrollment.findMany({ where: { studentId: s.id }, orderBy: { startDate: 'desc' }, select: { id: true, status: true, startDate: true, endedAt: true, source: true, course: { select: { code: true, name: true } }, batch: { select: { code: true, name: true } } } });
  res.json({ items });
}));

r.get('/timetable', ah(async (req, res) => {
  const s = await me(req);
  if (!s.batchId) return res.json({ items: [] });
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 7 * 864e5);
  const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 21 * 864e5);
  const items = await prisma.timetableSession.findMany({ where: { batchId: s.batchId, published: true, startsAt: { gte: from, lt: to } }, orderBy: { startsAt: 'asc' } });
  const subjects = await prisma.subject.findMany({ where: { id: { in: items.map((i) => i.subjectId!).filter(Boolean) } } });
  const fac = await prisma.user.findMany({ where: { id: { in: items.map((i) => i.facultyId!).filter(Boolean) } }, select: { id: true, name: true } });
  res.json({ items: items.map((i) => ({ ...i, subjectName: subjects.find((x) => x.id === i.subjectId)?.name, facultyName: fac.find((f) => f.id === i.facultyId)?.name })) });
}));

r.get('/attendance', ah(async (req, res) => {
  const s = await me(req);
  const items = await prisma.attendance.findMany({ where: { studentId: s.id }, include: { session: { select: { startsAt: true, title: true, subjectId: true } } }, orderBy: { session: { startsAt: 'desc' } } });
  res.json({ summary: await studentAttendancePct(s.id), items });
}));

r.get('/fees', ah(async (req, res) => {
  const s = await me(req);
  const [plans, payments, invoices, balance] = await Promise.all([
    prisma.feePlan.findMany({ where: { studentId: s.id }, include: { installments: { orderBy: { seq: 'asc' } } } }),
    prisma.payment.findMany({ where: { studentId: s.id }, orderBy: { paidAt: 'desc' } }),
    prisma.invoice.findMany({ where: { studentId: s.id }, orderBy: { number: 'asc' } }),
    studentBalance(s.id),
  ]);
  res.json({ plans, payments, invoices, balance, paymentInfo: { upi: process.env.ACADEMY_UPI_ID || null, bank: process.env.ACADEMY_BANK_DETAILS || null } });
}));
r.get('/payments/:id/receipt.pdf', ah(async (req, res) => {
  const s = await me(req);
  const p = await prisma.payment.findFirst({ where: { id: req.params.id, studentId: s.id } }); // API-08 object-level auth
  if (!p) throw notFound();
  res.setHeader('Content-Type', 'application/pdf');
  await receiptPdf(p.id, res);
}));

r.get('/materials', ah(async (req, res) => {
  const s = await me(req);
  res.json({ items: await prisma.material.findMany({ where: { courseId: s.courseId, OR: [{ batchId: null }, { batchId: s.batchId }] }, orderBy: { createdAt: 'desc' } }) });
}));

r.get('/assignments', ah(async (req, res) => {
  const s = await me(req);
  if (!s.batchId) return res.json({ items: [] });
  const items = await prisma.assignment.findMany({ where: { batchId: s.batchId }, orderBy: { dueAt: 'desc' }, include: { submissions: { where: { studentId: s.id } } } });
  res.json({ items: items.map(({ submissions, ...a }) => ({ ...a, submission: submissions[0] ?? null })) });
}));
r.post('/assignments/:id/submit', ah(async (req, res) => {
  const s = await me(req);
  const d = z.object({ content: z.string().max(20000).optional(), fileUrl: z.string().url().optional() }).refine((x) => x.content || x.fileUrl, 'Add your answer or a link').parse(req.body);
  const a = await prisma.assignment.findFirst({ where: { id: req.params.id, batchId: s.batchId ?? '' } });
  if (!a) throw notFound();
  const existing = await prisma.submission.findUnique({ where: { assignmentId_studentId: { assignmentId: a.id, studentId: s.id } } });
  if (existing?.marks != null) throw conflict('This submission has already been graded.');
  const late = new Date() > a.dueAt;
  res.json(await prisma.submission.upsert({ where: { assignmentId_studentId: { assignmentId: a.id, studentId: s.id } }, create: { ...d, assignmentId: a.id, studentId: s.id, late }, update: { ...d, late, submittedAt: new Date() } }));
}));

r.get('/results', ah(async (req, res) => {
  const s = await me(req);
  // EXM-17: only own, only published
  res.json({ items: await prisma.result.findMany({ where: { studentId: s.id, exam: { resultsPublished: true } }, include: { exam: { select: { title: true, type: true, totalMarks: true, passMarks: true, startAt: true } } }, orderBy: { createdAt: 'desc' } }) });
}));
r.get('/certificates', ah(async (req, res) => {
  const s = await me(req);
  res.json({ items: await prisma.certificate.findMany({ where: { studentId: s.id, status: 'ISSUED' } }) });
}));
r.get('/certificates/:id/pdf', ah(async (req, res) => {
  const s = await me(req);
  const c = await prisma.certificate.findFirst({ where: { id: req.params.id, studentId: s.id } });
  if (!c) throw notFound();
  res.setHeader('Content-Type', 'application/pdf');
  await certificatePdf(c.id, res);
}));

// ── Online exams ──
const activeAttempts = (examId: string, studentId: string) => prisma.examAttempt.findMany({ where: { examId, studentId, status: { not: 'VOIDED' } }, orderBy: { startedAt: 'desc' } });

r.get('/exams', ah(async (req, res) => {
  const s = await me(req);
  const assigns = await prisma.examAssignment.findMany({ where: { studentId: s.id, exam: { status: { in: ['SCHEDULED', 'COMPLETED'] } } }, include: { exam: { include: { _count: { select: { questions: true } } } } } });
  const attempts = await prisma.examAttempt.findMany({ where: { studentId: s.id, status: { not: 'VOIDED' } } });
  res.json({
    items: assigns.map(({ exam }) => {
      const mine = attempts.filter((a) => a.examId === exam.id);
      return { id: exam.id, title: exam.title, type: exam.type, mode: exam.mode, startAt: exam.startAt, endAt: exam.endAt, durationMin: exam.durationMin, totalMarks: exam.totalMarks, questions: exam._count.questions, instructions: exam.instructions, attemptLimit: exam.attemptLimit, attemptsUsed: mine.length, inProgress: mine.find((a) => a.status === 'IN_PROGRESS')?.id ?? null, resultsPublished: exam.resultsPublished };
    }),
  });
}));

function deadline(a: { startedAt: Date }, e: { durationMin: number; endAt: Date }) {
  return new Date(Math.min(a.startedAt.getTime() + e.durationMin * 60_000, e.endAt.getTime()));
}

async function finalize(attemptId: string) {
  const a = await prisma.examAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { exam: { include: { questions: { include: { question: true } } } } } });
  if (a.status !== 'IN_PROGRESS') return a;
  const g = autoGrade(a.exam.questions.map((q) => q.question), (a.answers ?? {}) as Record<string, unknown>);
  return prisma.examAttempt.update({ where: { id: a.id }, data: { submittedAt: new Date(), autoScore: g.score, status: g.needsManual ? 'SUBMITTED' : 'EVALUATED' } });
}
export { finalize as finalizeAttempt };

function shuffle<T>(arr: T[]) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function attemptView(attemptId: string) {
  const a = await prisma.examAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { exam: { include: { questions: { include: { question: true } } } } } });
  const order = a.questionOrder as { id: string; options?: string[] }[];
  const qmap = Object.fromEntries(a.exam.questions.map((q) => [q.questionId, q.question]));
  return {
    attemptId: a.id,
    status: a.status,
    exam: { id: a.exam.id, title: a.exam.title, totalMarks: a.exam.totalMarks, instructions: a.exam.instructions },
    deadline: deadline(a, a.exam),
    serverTime: new Date(),
    answers: a.answers,
    // Never expose correct answers to the client
    questions: order.map((o, i) => {
      const q = qmap[o.id];
      return { id: q.id, n: i + 1, type: q.type, text: q.text, marks: q.marks, negativeMarks: q.negativeMarks, options: o.options ?? (q.options as string[] | null) };
    }),
  };
}

r.post('/exams/:id/start', ah(async (req, res) => {
  const s = await me(req);
  const { acknowledged } = z.object({ acknowledged: z.literal(true, { message: 'Please read and accept the instructions.' }) }).parse(req.body);
  void acknowledged;
  const exam = await prisma.exam.findUnique({ where: { id: req.params.id }, include: { questions: { include: { question: true }, orderBy: { order: 'asc' } } } });
  if (!exam || exam.mode !== 'ONLINE' || exam.status !== 'SCHEDULED') throw notFound('Exam not available.');
  const assigned = await prisma.examAssignment.findUnique({ where: { examId_studentId: { examId: exam.id, studentId: s.id } } });
  if (!assigned) throw forbidden('You are not assigned to this exam.');
  const now = new Date();
  if (now < exam.startAt) throw badRequest(`The exam opens at ${exam.startAt.toLocaleString('en-IN')}.`);
  if (now > exam.endAt) throw badRequest('The exam window has closed.');
  const attempts = await activeAttempts(exam.id, s.id);
  const running = attempts.find((a) => a.status === 'IN_PROGRESS');
  if (running) {
    if (deadline(running, exam) < now) await finalize(running.id);
    else {
      // EXM-11 single active session: resuming is allowed but logged
      await prisma.examAttempt.update({ where: { id: running.id }, data: { ip: req.ip } });
      return res.json(await attemptView(running.id));
    }
  }
  if (attempts.filter((a) => a.status !== 'IN_PROGRESS').length >= exam.attemptLimit) throw conflict('You have used all allowed attempts for this exam.');
  const qs = exam.shuffle ? shuffle(exam.questions) : exam.questions;
  const order = qs.map((q) => ({ id: q.questionId, options: exam.shuffle && q.question.type.startsWith('MCQ') && Array.isArray(q.question.options) ? shuffle(q.question.options as string[]) : undefined }));
  const a = await prisma.examAttempt.create({ data: { examId: exam.id, studentId: s.id, ip: req.ip, questionOrder: order } });
  res.json(await attemptView(a.id));
}));

async function myAttempt(req: Request) {
  const s = await me(req);
  const a = await prisma.examAttempt.findFirst({ where: { id: req.params.id, studentId: s.id }, include: { exam: true } });
  if (!a) throw notFound();
  return a;
}

// Auto-save (EXM-09)
r.put('/attempts/:id/answers', ah(async (req, res) => {
  const a = await myAttempt(req);
  const { answers } = z.object({ answers: z.record(z.string(), z.any()) }).parse(req.body);
  if (a.status !== 'IN_PROGRESS') throw conflict('This attempt has already been submitted.');
  if (deadline(a, a.exam) < new Date()) {
    await finalize(a.id);
    throw conflict('Time is up — your answers were submitted automatically.');
  }
  await prisma.examAttempt.update({ where: { id: a.id }, data: { answers: { ...(a.answers as object), ...answers } as any } });
  res.json({ ok: true, savedAt: new Date() });
}));
r.post('/attempts/:id/event', ah(async (req, res) => {
  const a = await myAttempt(req);
  const { type } = z.object({ type: z.enum(['TAB_SWITCH', 'BLUR']) }).parse(req.body);
  if (a.status === 'IN_PROGRESS') await prisma.examAttempt.update({ where: { id: a.id }, data: { tabSwitches: { increment: 1 } } });
  res.json({ ok: true, type });
}));
r.post('/attempts/:id/submit', ah(async (req, res) => {
  const a = await myAttempt(req);
  if (req.body?.answers && a.status === 'IN_PROGRESS') await prisma.examAttempt.update({ where: { id: a.id }, data: { answers: { ...(a.answers as object), ...req.body.answers } } });
  const f = await finalize(a.id);
  res.json({ status: f.status, submittedAt: f.submittedAt, message: 'Your exam has been submitted. Results will be available once published.' });
}));

export default r;
