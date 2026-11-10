/**
 * Individual PDF receipts (fee month, remaining balance frozen at payment time, cancelled marking, download audit)
 * and the parent / guardian portal (accounts linked to guardians; linked children's fees and receipts only).
 * Synthetic data only.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import zlib from 'node:zlib';
import { app, as, makeStudent, makeUser, prisma, sessionFor } from './helpers';
import { atomic } from '../src/lib/db';
import { cancelPayment, createFeePlan, studentBalance } from '../src/services/finance';
import { UNUSABLE_PASSWORD } from '../src/lib/password';
import { enqueueDueReminders } from '../src/services/feeReminders';

/** Text drawn on a PDFKit page: inflate the content streams and join the hex glyph strings of each TJ. */
function pdfText(buf: Buffer) {
  const out: string[] = [];
  const s = buf.toString('latin1');
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body: string;
    try {
      body = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    for (const tj of body.matchAll(/\[([^\]]*)\]\s*TJ/g)) out.push([...tj[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1], 'hex').toString('latin1')).join(''));
  }
  return out.join('\n').replace(/\s+/g, ' ');
}
const binary = (res: any, cb: any) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

let fin: string, staff: string, admin: string;
beforeAll(async () => {
  [fin, staff, admin] = await Promise.all(['finmgr', 'accounts', 'office'].map((u) => sessionFor(u)));
});

async function billed(startDate = '2031-06-03') {
  const st = await makeStudent({});
  await atomic((tx) => createFeePlan(tx, { studentId: st.id, courseId: st.courseId, installments: 3, startDate }));
  return st;
}
const pay = (studentId: string, amount: number, key: string) => request(app).post('/api/v1/finance/payments').set(as(fin)).set('Idempotency-Key', key).send({ studentId, amount, mode: 'UPI', reference: key });

describe('PDF receipts', () => {
  it('show branding, receipt number, student name and ID, fee month, date, amount, method and the remaining balance', async () => {
    const st = await billed();
    const before = await studentBalance(st.id);
    const p = await pay(st.id, 1500, `rcpt-${st.id}`);
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: p.body.id } });
    expect(Number(row.balanceAfter)).toBeCloseTo(before - 1500, 2);

    const pdf = await request(app).get(`/api/v1/finance/payments/${row.id}/receipt.pdf`).set(as(staff)).buffer(true).parse(binary);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const text = pdfText(pdf.body);
    for (const want of ['Nexora Academy', 'FEE RECEIPT', row.receiptNumber, st.fullName, st.studentCode, 'Fee month:', 'June 2031', 'UPI', '1500.00', 'Remaining balance after this payment', (before - 1500).toFixed(2)]) expect(text).toContain(want);
    expect(text).not.toContain('CANCELLED');

    // A later payment does not change what an earlier receipt says; the stored balance cannot be edited.
    await pay(st.id, 500, `rcpt2-${st.id}`);
    expect(pdfText((await request(app).get(`/api/v1/finance/payments/${row.id}/receipt.pdf`).set(as(staff)).buffer(true).parse(binary)).body)).toContain((before - 1500).toFixed(2));
    await expect(prisma.payment.update({ where: { id: row.id }, data: { balanceAfter: 1 } })).rejects.toThrow(/balanceAfter cannot change/);

    expect(await prisma.auditLog.count({ where: { action: 'DOWNLOAD', entity: 'receipt', entityId: row.id } })).toBe(2);
  });

  it('a cancelled payment\'s receipt is marked CANCELLED, and its amount no longer counts', async () => {
    const st = await billed();
    const p = await pay(st.id, 800, `rcpt-c-${st.id}`);
    const finUser = await prisma.user.findUniqueOrThrow({ where: { username: 'finmgr' } });
    await atomic((tx) => cancelPayment(tx, p.body.id, finUser.id));
    const text = pdfText((await request(app).get(`/api/v1/finance/payments/${p.body.id}/receipt.pdf`).set(as(fin)).buffer(true).parse(binary)).body);
    expect(text).toContain('FEE RECEIPT — CANCELLED'.replace('—', '\u0097'));
    const months = await request(app).get(`/api/v1/finance/students/${st.id}/fee-months`).set(as(fin));
    expect(months.body.totals.paid).toBe(0);
  });

  it('students download only their own receipts (ID tampering returns 404), and it is audited', async () => {
    const st = await billed();
    const u = await makeUser(['student']);
    await prisma.student.update({ where: { id: st.id }, data: { userId: u.id } });
    const mine = await pay(st.id, 300, `rcpt-s-${st.id}`);
    const other = await billed();
    const theirs = await pay(other.id, 300, `rcpt-o-${other.id}`);
    const tok = await sessionFor(u.username);
    expect((await request(app).get(`/api/v1/portal/payments/${mine.body.id}/receipt.pdf`).set(as(tok))).status).toBe(200);
    expect((await request(app).get(`/api/v1/portal/payments/${theirs.body.id}/receipt.pdf`).set(as(tok))).status).toBe(404);
    expect(await prisma.auditLog.count({ where: { action: 'DOWNLOAD', entity: 'receipt', entityId: mine.body.id, userId: u.id } })).toBe(1);
    const fees = await request(app).get('/api/v1/portal/fees').set(as(tok));
    expect(fees.body.months.rows[0]).toMatchObject({ feeMonth: '2031-06', paid: 300 });
  });
});

describe('parent / guardian portal', () => {
  let child: any, sibling: any, stranger: any, parentTok: string, parentId: string, email: string;

  it('staff create a parent account from a guardian; it starts unactivated with an activation link', async () => {
    child = await billed();
    email = `parent-${child.id.slice(-8)}@example.invalid`;
    const g = await prisma.guardian.create({ data: { studentId: child.id, name: 'Synthetic Parent', relation: 'Mother', phone: '+919990001111', email } });
    expect((await request(app).post(`/api/v1/students/${child.id}/guardians/${g.id}/parent-account`).set(as(fin))).status).toBe(403); // finance cannot create logins
    const r = await request(app).post(`/api/v1/students/${child.id}/guardians/${g.id}/parent-account`).set(as(admin));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ linkedExisting: false, activationSent: true });
    expect(JSON.stringify(r.body)).not.toMatch(/token|https?:|reset-password/i);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: r.body.userId }, include: { roles: { include: { role: true } } } });
    expect(u.roles.map((x) => x.role.key)).toEqual(['parent']);
    expect(u.passwordHash).toBe(UNUSABLE_PASSWORD);
    expect(await prisma.passwordReset.count({ where: { userId: u.id, purpose: 'ENROLL', usedAt: null } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'CREATE_PARENT', entityId: g.id } })).toBe(1);
    expect((await request(app).post(`/api/v1/students/${child.id}/guardians/${g.id}/parent-account`).set(as(admin))).status).toBe(400); // already linked
    parentId = u.id;
    parentTok = await sessionFor(u.username);
  });

  it('a sibling\'s guardian with the same email links to the same account; other accounts\' emails are refused', async () => {
    sibling = await billed();
    const g2 = await prisma.guardian.create({ data: { studentId: sibling.id, name: 'Synthetic Parent', relation: 'Mother', phone: '+919990001111', email } });
    const r = await request(app).post(`/api/v1/students/${sibling.id}/guardians/${g2.id}/parent-account`).set(as(admin));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ userId: parentId, linkedExisting: true });
    const staffUser = await prisma.user.findUniqueOrThrow({ where: { username: 'accounts' } });
    const g3 = await prisma.guardian.create({ data: { studentId: sibling.id, name: 'Other', relation: 'Father', phone: '+919990002222', email: staffUser.email } });
    expect((await request(app).post(`/api/v1/students/${sibling.id}/guardians/${g3.id}/parent-account`).set(as(admin))).status).toBe(409);
    const g4 = await prisma.guardian.create({ data: { studentId: sibling.id, name: 'No Email', relation: 'Uncle', phone: '+919990003333' } });
    expect((await request(app).post(`/api/v1/students/${sibling.id}/guardians/${g4.id}/parent-account`).set(as(admin))).status).toBe(400);
  });

  it('the parent sees only linked children, their fee months and payments — no other personal data', async () => {
    stranger = await billed();
    const p = await pay(child.id, 700, `par-${child.id}`);
    const kids = await request(app).get('/api/v1/parent/children').set(as(parentTok));
    expect(kids.status).toBe(200);
    expect(kids.body.items.map((k: any) => k.id).sort()).toEqual([child.id, sibling.id].sort());
    const fees = await request(app).get(`/api/v1/parent/children/${child.id}/fees`).set(as(parentTok));
    expect(fees.status).toBe(200);
    expect(fees.body.months.rows[0]).toMatchObject({ feeMonth: '2031-06', paid: 700 });
    expect(fees.body.payments[0]).toMatchObject({ id: p.body.id, status: 'POSTED' });
    const text = JSON.stringify(kids.body) + JSON.stringify(fees.body);
    for (const pii of [child.phone, child.email, child.address, 'dob']) expect(text).not.toContain(pii);

    const pdf = await request(app).get(`/api/v1/parent/children/${child.id}/payments/${p.body.id}/receipt.pdf`).set(as(parentTok));
    expect(pdf.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'DOWNLOAD', entity: 'receipt', entityId: p.body.id, userId: parentId } })).toBe(1);
  });

  it('tampering with student or payment ids never reaches another family', async () => {
    const theirs = await pay(stranger.id, 200, `par-x-${stranger.id}`);
    expect((await request(app).get(`/api/v1/parent/children/${stranger.id}/fees`).set(as(parentTok))).status).toBe(404);
    expect((await request(app).get(`/api/v1/parent/children/${stranger.id}/payments/${theirs.body.id}/receipt.pdf`).set(as(parentTok))).status).toBe(404);
    expect((await request(app).get(`/api/v1/parent/children/${child.id}/payments/${theirs.body.id}/receipt.pdf`).set(as(parentTok))).status).toBe(404);
    // Staff and student APIs are closed to parents.
    for (const path of ['/portal/fees', '/finance/payments', `/finance/payments/${theirs.body.id}/receipt.pdf`, `/students/${child.id}`, '/finance/summary']) {
      expect((await request(app).get(`/api/v1${path}`).set(as(parentTok))).status, path).toBe(403);
    }
  });

  it('a linked parent account also gets in-app fee reminders', async () => {
    const recent = await makeStudent({});
    const d = new Date(Date.now() - 864e5);
    await atomic((tx) => createFeePlan(tx, { studentId: recent.id, courseId: recent.courseId, installments: 1, startDate: d.toISOString().slice(0, 10) }));
    await prisma.guardian.create({ data: { studentId: recent.id, name: 'Synthetic Parent', relation: 'Mother', phone: '+919990001111', email, userId: parentId } });
    await enqueueDueReminders();
    const rows = await prisma.feeReminder.findMany({ where: { studentId: recent.id, recipientType: 'GUARDIAN' } });
    expect(rows.find((r) => r.channel === 'IN_APP')?.address).toBe(parentId);
  });

  it('unlinking: the account stays while a child remains, then is deactivated and signed out', async () => {
    const links = await prisma.guardian.findMany({ where: { userId: parentId } });
    for (const [i, g] of links.entries()) {
      const r = await request(app).delete(`/api/v1/students/${g.studentId}/guardians/${g.id}/parent-account`).set(as(admin));
      expect(r.status).toBe(200);
      const u = await prisma.user.findUniqueOrThrow({ where: { id: parentId } });
      expect(u.isActive).toBe(i < links.length - 1);
    }
    expect((await request(app).get('/api/v1/parent/children').set(as(parentTok))).status).toBe(401);
    expect(await prisma.auditLog.count({ where: { action: 'UNLINK_PARENT', entityId: { in: links.map((l) => l.id) } } })).toBe(links.length);
  });
});
