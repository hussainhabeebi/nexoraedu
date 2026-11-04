/** Examination (SRS §13): question bank, scheduling, assignment, evaluation, results, certificates. */
import { Router } from 'express';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { ah, badRequest, conflict, notFound, paging } from '../lib/http';
import { can } from '../lib/auth';
import { audit } from '../lib/audit';
import { nextNumber } from '../lib/sequence';
import { getSettings } from '../lib/settings';
import { randomToken } from '../lib/util';
import { createApproval } from '../services/approvals';
import { autoGrade, computeResult } from '../services/exams';
import { notifyLater } from '../services/notify';
import { studentBalance } from '../services/finance';
import { studentAttendancePct } from './academics';

const r = Router();
type Tx = Prisma.TransactionClient;

// ── Question bank (EXM-03/04/05) ──
const questionSchema = z.object({
  courseId: z.string(),
  subjectId: z.string().optional().nullable(),
  topic: z.string().optional().nullable(),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).default('MEDIUM'),
  type: z.enum(['MCQ_SINGLE', 'MCQ_MULTI', 'TRUE_FALSE', 'SHORT', 'LONG']),
  text: z.string().min(3),
  options: z.array(z.string()).optional().nullable(),
  correct: z.any().optional().nullable(),
  marks: z.coerce.number().positive().default(1),
  negativeMarks: z.coerce.number().min(0).default(0),
});
function checkQuestion(q: z.infer<typeof questionSchema>) {
  if (q.type.startsWith('MCQ')) {
    if (!q.options || q.options.length < 2) throw badRequest('MCQ needs at least two options.');
    const c = Array.isArray(q.correct) ? q.correct : [q.correct];
    if (!c.length || c.some((x) => x == null || !q.options!.includes(String(x)))) throw badRequest('Choose the correct answer(s) from the options.');
    if (q.type === 'MCQ_SINGLE' && c.length !== 1) throw badRequest('Single-answer MCQ must have exactly one correct option.');
  }
  if (q.type === 'TRUE_FALSE') {
    q.options = ['True', 'False'];
    if (!['True', 'False'].includes(String(q.correct))) throw badRequest('Correct answer must be True or False.');
  }
}

r.get('/questions', can('exams:read'), ah(async (req, res) => {
  const { skip, take, page, pageSize } = paging(req.query);
  const where: Prisma.QuestionWhereInput = {
    ...(req.query.courseId && { courseId: String(req.query.courseId) }),
    ...(req.query.subjectId && { subjectId: String(req.query.subjectId) }),
    ...(req.query.type && { type: String(req.query.type) }),
    ...(req.query.difficulty && { difficulty: String(req.query.difficulty) }),
    status: req.query.status ? String(req.query.status) : 'ACTIVE',
    ...(req.query.q && { text: { contains: String(req.query.q), mode: 'insensitive' } }),
  };
  const [items, total] = await Promise.all([prisma.question.findMany({ where, skip, take, orderBy: { createdAt: 'desc' }, include: { _count: { select: { exams: true } } } }), prisma.question.count({ where })]);
  res.json({ items, total, page, pageSize });
}));
r.post('/questions', can('exams:manage'), ah(async (req, res) => {
  const d = questionSchema.parse(req.body);
  checkQuestion(d);
  res.status(201).json(await prisma.question.create({ data: d as any }));
}));
r.patch('/questions/:id', can('exams:manage'), ah(async (req, res) => {
  const q = await prisma.question.findUniqueOrThrow({ where: { id: req.params.id }, include: { _count: { select: { exams: true } } } });
  if (q._count.exams > 0 && req.body.status !== 'RETIRED') throw conflict('This question is used in an exam and can only be retired.');
  const d = questionSchema.partial().extend({ status: z.enum(['ACTIVE', 'RETIRED']).optional() }).parse(req.body);
  if (d.type || d.options || d.correct) checkQuestion({ ...(q as any), ...d });
  res.json(await prisma.question.update({ where: { id: q.id }, data: d as any }));
}));
r.post('/questions/import', can('exams:manage'), ah(async (req, res) => {
  const { courseId, rows } = z.object({ courseId: z.string(), rows: z.array(z.record(z.string(), z.any())).max(2000) }).parse(req.body);
  const report: { row: number; ok: boolean; error?: string }[] = [];
  for (const [i, raw] of rows.entries()) {
    try {
      const options = raw.options ? String(raw.options).split('|').map((s) => s.trim()) : undefined;
      const correct = raw.type === 'MCQ_MULTI' ? String(raw.correct).split('|').map((s) => s.trim()) : raw.correct;
      const d = questionSchema.parse({ ...raw, courseId, options, correct });
      checkQuestion(d);
      await prisma.question.create({ data: d as any });
      report.push({ row: i + 2, ok: true });
    } catch (e: any) {
      report.push({ row: i + 2, ok: false, error: e.issues ? e.issues.map((x: any) => `${x.path}: ${x.message}`).join('; ') : e.message });
    }
  }
  res.json({ report, created: report.filter((x) => x.ok).length });
}));

// ── Exams (EXM-01/02/06) ──
const examSchema = z.object({
  title: z.string().min(3),
  courseId: z.string(),
  batchId: z.string().optional().nullable(),
  subjectId: z.string().optional().nullable(),
  type: z.enum(['INTERNAL', 'MODULE_TEST', 'MID_TERM', 'FINAL', 'PRACTICAL']),
  mode: z.enum(['ONLINE', 'OFFLINE']),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  durationMin: z.coerce.number().int().min(5).max(600),
  totalMarks: z.coerce.number().positive(),
  passMarks: z.coerce.number().min(0),
  weightage: z.coerce.number().min(0).max(100).default(100),
  instructions: z.string().optional().nullable(),
  attemptLimit: z.coerce.number().int().min(1).max(10).default(1),
  shuffle: z.boolean().default(true),
});

r.get('/exams', can('exams:read'), ah(async (req, res) => {
  const items = await prisma.exam.findMany({
    where: { ...(req.query.courseId && { courseId: String(req.query.courseId) }), ...(req.query.batchId && { batchId: String(req.query.batchId) }), ...(req.query.status && { status: String(req.query.status) }) },
    orderBy: { startAt: 'desc' },
    include: { _count: { select: { questions: true, assignments: true, attempts: true, results: true } } },
  });
  res.json({ items });
}));

r.get('/exams/:id', can('exams:read'), ah(async (req, res) => {
  const e = await prisma.exam.findUnique({
    where: { id: req.params.id },
    include: { questions: { orderBy: { order: 'asc' }, include: { question: true } }, assignments: true, results: { orderBy: { marks: 'desc' } }, attempts: { orderBy: { startedAt: 'desc' } } },
  });
  if (!e) throw notFound('Exam not found');
  const studentIds = [...new Set([...e.assignments.map((a) => a.studentId), ...e.results.map((x) => x.studentId), ...e.attempts.map((x) => x.studentId)])];
  const students = await prisma.student.findMany({ where: { id: { in: studentIds } }, select: { id: true, fullName: true, studentCode: true } });
  res.json({ ...e, students: Object.fromEntries(students.map((s) => [s.id, s])) });
}));

r.post('/exams', can('exams:manage'), ah(async (req, res) => {
  const d = examSchema.parse(req.body);
  if (d.endAt <= d.startAt) throw badRequest('Exam window end must be after start.');
  if (d.passMarks > d.totalMarks) throw badRequest('Pass marks cannot exceed total marks.');
  const code = await nextNumber(`exam:${new Date().getFullYear()}`, 'EX-{YYYY}-####');
  const e = await prisma.exam.create({ data: { ...d, code } });
  await audit(req, 'CREATE', 'exam', e.id, null, d);
  res.status(201).json(e);
}));

r.patch('/exams/:id', can('exams:manage'), ah(async (req, res) => {
  const before = await prisma.exam.findUniqueOrThrow({ where: { id: req.params.id }, include: { _count: { select: { attempts: true } } } });
  if (before._count.attempts > 0) throw conflict('This exam already has attempts and cannot be edited.');
  const d = examSchema.partial().parse(req.body);
  const e = await prisma.exam.update({ where: { id: before.id }, data: d });
  await audit(req, 'UPDATE', 'exam', e.id, before, d);
  res.json(e);
}));

r.put('/exams/:id/questions', can('exams:manage'), ah(async (req, res) => {
  const { questionIds, random } = z.object({ questionIds: z.array(z.string()).optional(), random: z.object({ count: z.number().int().min(1), difficulty: z.string().optional(), subjectId: z.string().optional() }).optional() }).parse(req.body);
  const exam = await prisma.exam.findUniqueOrThrow({ where: { id: req.params.id }, include: { _count: { select: { attempts: true } } } });
  if (exam._count.attempts > 0) throw conflict('Questions cannot change after attempts have started.');
  let ids = questionIds ?? [];
  if (random) {
    const pool = await prisma.question.findMany({ where: { courseId: exam.courseId, status: 'ACTIVE', ...(random.difficulty && { difficulty: random.difficulty }), ...(random.subjectId && { subjectId: random.subjectId }) }, select: { id: true } });
    ids = pool.sort(() => Math.random() - 0.5).slice(0, random.count).map((q) => q.id);
  }
  await prisma.$transaction([prisma.examQuestion.deleteMany({ where: { examId: exam.id } }), prisma.examQuestion.createMany({ data: ids.map((questionId, i) => ({ examId: exam.id, questionId, order: i + 1 })) })]);
  const qs = await prisma.question.findMany({ where: { id: { in: ids } }, select: { marks: true } });
  res.json({ count: ids.length, marks: qs.reduce((s, q) => s + q.marks, 0) });
}));

/** EXM-07 eligibility: fees & attendance rules (configurable). */
async function eligibility(studentId: string) {
  const s = await getSettings();
  const reasons: string[] = [];
  if (s.exams.requireFeesCleared) {
    const overdue = await prisma.installment.findFirst({ where: { feePlan: { studentId }, status: { not: 'PAID' }, dueDate: { lt: new Date() } } });
    if (overdue) reasons.push('Overdue fees');
  }
  if (s.exams.minAttendanceForExam > 0) {
    const a = await studentAttendancePct(studentId);
    if (a.percentage != null && a.percentage < s.exams.minAttendanceForExam) reasons.push(`Attendance ${a.percentage}% < ${s.exams.minAttendanceForExam}%`);
  }
  return reasons;
}

r.post('/exams/:id/assign', can('exams:manage'), ah(async (req, res) => {
  const { batchId, studentIds } = z.object({ batchId: z.string().optional(), studentIds: z.array(z.string()).optional() }).parse(req.body);
  const exam = await prisma.exam.findUniqueOrThrow({ where: { id: req.params.id } });
  const ids = studentIds ?? (await prisma.student.findMany({ where: { batchId: batchId ?? exam.batchId ?? undefined, status: { in: ['ADMITTED', 'ACTIVE'] } }, select: { id: true } })).map((s) => s.id);
  const assigned: string[] = [];
  const ineligible: { studentId: string; reasons: string[] }[] = [];
  for (const id of ids) {
    // EXM-06 clash detection for students
    const clash = await prisma.examAssignment.findFirst({ where: { studentId: id, exam: { id: { not: exam.id }, startAt: { lt: exam.endAt }, endAt: { gt: exam.startAt } } } });
    const reasons = await eligibility(id);
    if (clash) reasons.push('Clashes with another exam');
    if (reasons.length) ineligible.push({ studentId: id, reasons });
    else assigned.push(id);
  }
  await prisma.examAssignment.createMany({ data: assigned.map((studentId) => ({ examId: exam.id, studentId })), skipDuplicates: true });
  res.json({ assigned: assigned.length, ineligible });
}));

r.post('/exams/:id/exception', can('exams:manage'), ah(async (req, res) => {
  const { studentId, reason, reattempt } = z.object({ studentId: z.string(), reason: z.string().min(3), reattempt: z.boolean().default(false) }).parse(req.body);
  const exam = await prisma.exam.findUniqueOrThrow({ where: { id: req.params.id } });
  const st = await prisma.student.findUniqueOrThrow({ where: { id: studentId } });
  const a = await prisma.$transaction((tx) => createApproval(tx, { type: 'EXAM_REATTEMPT', entityType: 'exam', entityId: exam.id, title: `${reattempt ? 'Re-attempt' : 'Eligibility exception'}: ${st.fullName} — ${exam.title}`, payload: { examId: exam.id, studentId, reason, reattempt }, requestedById: req.user!.id }));
  res.json({ approval: a });
}));

r.post('/exams/:id/schedule', can('exams:manage'), ah(async (req, res) => {
  const exam = await prisma.exam.findUniqueOrThrow({ where: { id: req.params.id }, include: { _count: { select: { questions: true } }, assignments: true } });
  if (exam.mode === 'ONLINE' && exam._count.questions === 0) throw badRequest('Add questions before scheduling an online exam.');
  if (!exam.assignments.length) throw badRequest('Assign students before scheduling.');
  await prisma.exam.update({ where: { id: exam.id }, data: { status: 'SCHEDULED' } });
  const students = await prisma.student.findMany({ where: { id: { in: exam.assignments.map((a) => a.studentId) } } });
  for (const s of students) notifyLater('exam.scheduled', { userId: s.userId, name: s.fullName, phone: s.phone, email: s.email }, { name: s.fullName, exam: exam.title, start: exam.startAt.toLocaleString('en-IN'), duration: exam.durationMin, mode: exam.mode.toLowerCase() });
  await audit(req, 'SCHEDULE', 'exam', exam.id);
  res.json({ ok: true, notified: students.length });
}));

// ── Evaluation (EXM-12/13/14) ──
r.get('/attempts/pending', can('exams:manage'), ah(async (_req, res) => {
  const items = await prisma.examAttempt.findMany({ where: { status: 'SUBMITTED' }, include: { exam: { select: { id: true, title: true } }, student: { select: { fullName: true, studentCode: true } } }, orderBy: { submittedAt: 'asc' } });
  res.json({ items });
}));
r.get('/attempts/:id', can('exams:manage'), ah(async (req, res) => {
  const a = await prisma.examAttempt.findUniqueOrThrow({ where: { id: req.params.id }, include: { student: { select: { fullName: true, studentCode: true } }, exam: { include: { questions: { include: { question: true }, orderBy: { order: 'asc' } } } } } });
  res.json(a);
}));
r.post('/attempts/:id/evaluate', can('exams:manage'), ah(async (req, res) => {
  const { marks } = z.object({ marks: z.record(z.string(), z.coerce.number().min(0)) }).parse(req.body);
  const a = await prisma.examAttempt.findUniqueOrThrow({ where: { id: req.params.id }, include: { exam: { include: { questions: { include: { question: true } } } } } });
  if (a.status === 'IN_PROGRESS') throw badRequest('Attempt is still in progress.');
  for (const [qid, m] of Object.entries(marks)) {
    const q = a.exam.questions.find((x) => x.questionId === qid)?.question;
    if (!q) throw badRequest('Unknown question in marks.');
    if (m > q.marks) throw badRequest(`Marks for a question cannot exceed ${q.marks}.`);
  }
  const manual = Object.values(marks).reduce((s, m) => s + m, 0);
  const u = await prisma.examAttempt.update({ where: { id: a.id }, data: { manualMarks: marks, manualScore: manual, status: 'EVALUATED' } });
  await audit(req, 'EVALUATE', 'exam_attempt', a.id, null, { marks });
  res.json(u);
}));

async function upsertResult(tx: Tx, exam: { id: string; totalMarks: number; passMarks: number }, studentId: string, marks: number) {
  const s = await getSettings();
  const existing = await tx.result.findUnique({ where: { examId_studentId: { examId: exam.id, studentId } } });
  if (existing?.locked) throw conflict('Marks are locked after verification. Request a correction instead.');
  const c = computeResult(marks, exam.totalMarks, exam.passMarks, s.exams.gradeScale);
  return tx.result.upsert({ where: { examId_studentId: { examId: exam.id, studentId } }, create: { examId: exam.id, studentId, marks, ...c }, update: { marks, ...c } });
}

// Offline marks entry
r.post('/exams/:id/marks', can('exams:manage'), ah(async (req, res) => {
  const { entries } = z.object({ entries: z.array(z.object({ studentId: z.string(), marks: z.coerce.number().min(0) })).min(1) }).parse(req.body);
  const exam = await prisma.exam.findUniqueOrThrow({ where: { id: req.params.id } });
  const bad = entries.find((e) => e.marks > exam.totalMarks);
  if (bad) throw badRequest(`Marks cannot exceed the maximum of ${exam.totalMarks}.`);
  await prisma.$transaction(async (tx) => {
    for (const e of entries) await upsertResult(tx, exam, e.studentId, e.marks);
  });
  await audit(req, 'MARKS_ENTRY', 'exam', exam.id, null, { count: entries.length });
  res.json({ ok: true });
}));

// EXM-15 process online attempts → results (best evaluated attempt)
r.post('/exams/:id/process', can('exams:manage'), ah(async (req, res) => {
  const exam = await prisma.exam.findUniqueOrThrow({ where: { id: req.params.id }, include: { attempts: true } });
  const pending = exam.attempts.filter((a) => a.status === 'SUBMITTED' || a.status === 'IN_PROGRESS');
  if (pending.length) throw conflict(`${pending.length} attempt(s) are still in progress or awaiting manual evaluation.`);
  const best = new Map<string, number>();
  for (const a of exam.attempts.filter((x) => x.status === 'EVALUATED')) {
    const total = (a.autoScore ?? 0) + (a.manualScore ?? 0);
    best.set(a.studentId, Math.max(best.get(a.studentId) ?? 0, total));
  }
  await prisma.$transaction(async (tx) => {
    for (const [sid, m] of best) await upsertResult(tx, exam, sid, Math.min(m, exam.totalMarks));
  });
  await prisma.exam.update({ where: { id: exam.id }, data: { status: 'COMPLETED' } });
  res.json({ processed: best.size });
}));

r.post('/exams/:id/lock', can('exams:manage'), ah(async (req, res) => {
  const u = await prisma.result.updateMany({ where: { examId: req.params.id }, data: { locked: true } });
  await audit(req, 'LOCK', 'exam_results', req.params.id, null, { count: u.count });
  res.json({ locked: u.count });
}));

r.post('/exams/:id/publish', can('exams:manage'), ah(async (req, res) => {
  const exam = await prisma.exam.findUniqueOrThrow({ where: { id: req.params.id }, include: { results: { include: { student: true } } } });
  if (!exam.results.length) throw badRequest('No results to publish.');
  await prisma.$transaction([prisma.result.updateMany({ where: { examId: exam.id }, data: { locked: true } }), prisma.exam.update({ where: { id: exam.id }, data: { resultsPublished: true, status: 'COMPLETED' } })]);
  for (const r0 of exam.results) {
    const s = r0.student;
    notifyLater('result.published', { userId: s.userId, name: s.fullName, phone: s.phone, email: s.email }, { name: s.fullName, exam: exam.title, marks: r0.marks, total: exam.totalMarks, grade: r0.grade, status: r0.passed ? 'PASSED' : 'NOT PASSED' });
  }
  await audit(req, 'PUBLISH', 'exam_results', exam.id);
  res.json({ published: exam.results.length });
}));

// EXM-18 correction via approval
r.post('/results/:id/correction', can('exams:manage', 'materials:manage'), ah(async (req, res) => {
  const { newMarks, reason, evidence } = z.object({ newMarks: z.coerce.number().min(0), reason: z.string().min(5), evidence: z.string().min(3) }).parse(req.body);
  const rs = await prisma.result.findUniqueOrThrow({ where: { id: req.params.id }, include: { exam: true, student: true } });
  if (newMarks > rs.exam.totalMarks) throw badRequest(`Marks cannot exceed ${rs.exam.totalMarks}.`);
  const a = await prisma.$transaction((tx) => createApproval(tx, { type: 'RESULT_CORRECTION', entityType: 'result', entityId: rs.id, title: `Result correction: ${rs.student.fullName} — ${rs.exam.title} (${rs.marks} → ${newMarks})`, payload: { oldMarks: rs.marks, newMarks, reason, evidence }, requestedById: req.user!.id }));
  res.json({ approval: a });
}));

// ── Certificates (EXM-19/20) ──
r.get('/certificates', can('exams:read'), ah(async (_req, res) => {
  res.json({ items: await prisma.certificate.findMany({ orderBy: { createdAt: 'desc' }, include: { student: { select: { fullName: true, studentCode: true } } } }) });
}));
r.post('/certificates', can('exams:manage'), ah(async (req, res) => {
  const { studentId } = z.object({ studentId: z.string() }).parse(req.body);
  const st = await prisma.student.findUniqueOrThrow({ where: { id: studentId }, include: { results: { include: { exam: true } }, course: true } });
  const problems: string[] = [];
  if (!['COMPLETED', 'ACTIVE'].includes(st.status)) problems.push(`Student status is ${st.status}`);
  const finals = st.results.filter((x) => x.exam.type === 'FINAL' && x.exam.resultsPublished);
  if (!finals.length || finals.some((x) => !x.passed)) problems.push('Final exam not passed');
  if ((await studentBalance(st.id)) > 0) problems.push('Fees not cleared');
  if (problems.length) throw badRequest(`Not eligible for certificate: ${problems.join('; ')}.`);
  const existing = await prisma.certificate.findFirst({ where: { studentId, courseId: st.courseId, status: { in: ['ISSUED', 'PENDING_APPROVAL'] } } });
  if (existing) throw conflict(`Certificate ${existing.number} already ${existing.status === 'ISSUED' ? 'issued' : 'pending approval'}.`);
  const s = await getSettings();
  const out = await prisma.$transaction(async (tx) => {
    const number = await nextNumber(`certificate:${new Date().getFullYear()}`, s.ids.certificate, tx);
    const c = await tx.certificate.create({ data: { number, studentId, courseId: st.courseId, verificationCode: randomToken(9).toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 10) } });
    const a = await createApproval(tx, { type: 'CERTIFICATE', entityType: 'certificate', entityId: c.id, title: `Certificate ${number} — ${st.fullName} (${st.course.name})`, requestedById: req.user!.id });
    return { certificate: c, approval: a };
  });
  res.status(201).json(out);
}));

export async function certificatePdf(id: string, out: NodeJS.WritableStream) {
  const c = await prisma.certificate.findUnique({ where: { id }, include: { student: { include: { course: true } } } });
  if (!c || c.status !== 'ISSUED') throw notFound('Certificate not issued');
  const s = await getSettings();
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 50 });
  doc.pipe(out);
  doc.rect(25, 25, doc.page.width - 50, doc.page.height - 50).lineWidth(3).stroke('#4338ca');
  doc.moveDown(2).fillColor('#4338ca').fontSize(30).text(s.academy.name, { align: 'center' });
  doc.fillColor('#333').fontSize(14).text('Certificate of Completion', { align: 'center' });
  doc.moveDown(2).fontSize(12).text('This is to certify that', { align: 'center' });
  doc.moveDown(0.5).fontSize(26).fillColor('#111').text(c.student.fullName, { align: 'center' });
  doc.moveDown(0.5).fontSize(12).fillColor('#333').text(`(${c.student.studentCode}) has successfully completed the course`, { align: 'center' });
  doc.moveDown(0.5).fontSize(18).fillColor('#4338ca').text(c.student.course.name, { align: 'center' });
  doc.moveDown(3).fontSize(10).fillColor('#555').text(`Certificate No: ${c.number}    ·    Issued: ${c.issuedAt?.toLocaleDateString('en-IN')}    ·    Verification code: ${c.verificationCode}`, { align: 'center' });
  doc.end();
}
r.get('/certificates/:id/pdf', can('exams:read'), ah(async (req, res) => {
  res.setHeader('Content-Type', 'application/pdf');
  await certificatePdf(req.params.id, res);
}));

export { autoGrade };
export default r;
