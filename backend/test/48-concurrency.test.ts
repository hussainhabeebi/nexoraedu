/**
 * Concurrency integrity (8.4 Reliability, FIN-05, STU-09): parallel requests must not overpay an account or
 * overfill a batch.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, as, makeStudent, prisma, sessionFor } from './helpers';
import { createFeePlan } from '../src/services/finance';
import { assertBatchAvailable } from '../src/services/admissions';

describe('concurrency', () => {
  it('parallel payments cannot exceed the outstanding balance', async () => {
    const st = await makeStudent({});
    await prisma.$transaction((tx) => createFeePlan(tx, { studentId: st.id, courseId: st.courseId, installments: 1 }));
    const due = Number((await prisma.installment.findFirstOrThrow({ where: { feePlan: { studentId: st.id } } })).amount);
    const tok = await sessionFor('accounts');
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => request(app).post('/api/v1/finance/payments').set(as(tok)).set('Idempotency-Key', `race-${st.id}-${i}`).send({ studentId: st.id, amount: due, mode: 'CASH' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const paid = await prisma.payment.aggregate({ where: { studentId: st.id }, _sum: { amount: true } });
    expect(Number(paid._sum.amount)).toBeCloseTo(due, 2);
  });

  it('parallel admissions cannot overfill a batch', async () => {
    const course = await prisma.course.findUniqueOrThrow({ where: { code: 'DM' } });
    const batch = await prisma.batch.create({ data: { code: `CAP-${Date.now()}`, name: 'Capacity test', courseId: course.id, startDate: new Date(), capacity: 1, status: 'PLANNED' } });
    const out = await Promise.allSettled(Array.from({ length: 3 }, () => prisma.$transaction(async (tx) => {
      await assertBatchAvailable(tx, batch.id, course.id);
      const n = `${Date.now()}${Math.random()}`.replace('.', '').slice(-9);
      await tx.student.create({ data: { studentCode: `CAP-${n}`, fullName: 'Cap', dob: new Date('2000-01-01'), gender: 'Other', phone: `+916${n}`, phoneNormalized: `+916${n}`, email: `c${n}@example.invalid`, emailNormalized: `c${n}@example.invalid`, address: 'x street 1', courseId: course.id, batchId: batch.id, status: 'ADMITTED' } });
    })));
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.student.count({ where: { batchId: batch.id } })).toBe(1);
  });
});
