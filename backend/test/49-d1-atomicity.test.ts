/**
 * Cloudflare D1: atomicity, rollback, idempotency and concurrency of the money workflows (lib/db.ts atomic()).
 * D1 has no interactive transactions; every workflow is one atomic batch with database-enforced rules.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, as, makeStudent, prisma, sessionFor } from './helpers';
import { createFeePlan, recordPayment } from '../src/services/finance';
import { atomic } from '../src/lib/db';

const planFor = async (studentId: string, courseId: string, installments = 1) => atomic((tx) => createFeePlan(tx, { studentId, courseId, installments }));

describe('D1 atomic batches', () => {
  it('a failure in the LAST statement rolls back the whole payment (receipt, allocations, ledger, installment, number)', async () => {
    const st = await makeStudent({ batchId: null });
    await planFor(st.id, st.courseId);
    const before = {
      payments: await prisma.payment.count({ where: { studentId: st.id } }),
      ledger: await prisma.ledgerEntry.count({ where: { studentId: st.id } }),
      paid: Number((await prisma.installment.findFirstOrThrow({ where: { feePlan: { studentId: st.id } } })).paidAmount),
      seq: await prisma.sequence.findMany({ where: { name: { startsWith: 'receipt:' } } }),
    };
    await expect(
      atomic(async (tx) => {
        await recordPayment(tx, { studentId: st.id, amount: 100, mode: 'CASH' });
        tx.assert('0', [], 'forced failure after all writes');
      }),
    ).rejects.toThrow(/forced failure/);
    expect(await prisma.payment.count({ where: { studentId: st.id } })).toBe(before.payments);
    expect(await prisma.ledgerEntry.count({ where: { studentId: st.id } })).toBe(before.ledger);
    expect(Number((await prisma.installment.findFirstOrThrow({ where: { feePlan: { studentId: st.id } } })).paidAmount)).toBe(before.paid);
    expect(await prisma.sequence.findMany({ where: { name: { startsWith: 'receipt:' } } })).toEqual(before.seq); // no receipt number used
  });

  it('10 parallel retries with the same Idempotency-Key record exactly one receipt', async () => {
    const st = await makeStudent({ batchId: null });
    await planFor(st.id, st.courseId);
    const tok = await sessionFor('accounts');
    const key = `idem-${st.id}`;
    const out = await Promise.all(Array.from({ length: 10 }, () => request(app).post('/api/v1/finance/payments').set(as(tok)).set('Idempotency-Key', key).send({ studentId: st.id, amount: 500, mode: 'CASH' })));
    expect(out.every((r) => [200, 201].includes(r.status)), JSON.stringify(out.map((r) => [r.status, r.body?.error?.code]))).toBe(true);
    expect(new Set(out.map((r) => r.body.id ?? r.body.payment?.id)).size).toBe(1);
    expect(await prisma.payment.count({ where: { studentId: st.id } })).toBe(1);
    expect(await prisma.ledgerEntry.count({ where: { studentId: st.id, type: 'PAYMENT' } })).toBe(1);
  });

  it('parallel payments for different students get unique, gap-free receipt numbers', async () => {
    const students = [];
    for (let i = 0; i < 8; i++) students.push(await makeStudent({ batchId: null }));
    for (const s of students) await planFor(s.id, s.courseId);
    const tok = await sessionFor('accounts');
    const out = await Promise.all(students.map((s, i) => request(app).post('/api/v1/finance/payments').set(as(tok)).set('Idempotency-Key', `gap-${s.id}-${i}`).send({ studentId: s.id, amount: 250, mode: 'UPI', reference: `UPI${i}` })));
    expect(out.map((r) => r.status), JSON.stringify(out.map((r) => r.body?.error))).toEqual(students.map(() => 201));
    const nums = (await prisma.payment.findMany({ where: { studentId: { in: students.map((s) => s.id) } }, select: { receiptNumber: true } })).map((p) => p.receiptNumber);
    expect(new Set(nums).size).toBe(8);
    const tail = nums.map((n) => Number(n.match(/(\d+)$/)![1])).sort((a, b) => a - b);
    expect(tail[7] - tail[0]).toBe(7); // consecutive: no gaps, no reuse
  });

  it('money is stored with at most 2 decimals and installments can never be overpaid (database rules)', async () => {
    const st = await makeStudent({ batchId: null });
    await planFor(st.id, st.courseId);
    const ins = await prisma.installment.findFirstOrThrow({ where: { feePlan: { studentId: st.id } } });
    // Raw SQL so the database's own message is visible (Prisma reports trigger failures as a generic constraint error).
    const set = (v: number) => prisma.$executeRawUnsafe(`UPDATE "installments" SET "paidAmount" = ? WHERE "id" = ?`, v, ins.id);
    await expect(set(0.001)).rejects.toThrow(/paidAmount_money/);
    await expect(set(-1)).rejects.toThrow(/paidAmount_money/);
    await expect(set(Number(ins.amount) + 1)).rejects.toThrow(/paid_le_amount/);
    await expect(prisma.installment.update({ where: { id: ins.id }, data: { paidAmount: Number(ins.amount) + 1 } })).rejects.toThrow(); // also refused through Prisma
  });
});
