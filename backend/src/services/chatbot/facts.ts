/**
 * Verified Nexora Academy facts for the chatbot: generated from the same published data as the public website
 * (active public courses with their published fees and open batches, and the academy contact details). Nothing about
 * individual students, leads or staff is ever included.
 */
import { prisma } from '../../lib/prisma';
import { getSettings } from '../../lib/settings';
import { formatDate } from '../../lib/caldate';

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

export async function academyFacts(): Promise<{ text: string; courses: { id: string; code: string; name: string }[] }> {
  const s = await getSettings();
  const courses = await prisma.course.findMany({
    where: { isActive: true, isPublic: true },
    orderBy: { name: 'asc' },
    select: {
      id: true, code: true, name: true, summary: true, durationMonths: true, eligibility: true, mode: true,
      feeComponents: { where: { isActive: true }, select: { name: true, amount: true, taxPercent: true } },
      batches: { where: { status: { in: ['PLANNED', 'RUNNING'] as any } }, orderBy: { startDate: 'asc' }, take: 3, select: { name: true, startDate: true, timing: true, mode: true, status: true } },
    },
  });
  const lines: string[] = [];
  const a = s.academy;
  lines.push(`Academy: ${a.name}${a.tagline ? ` — ${a.tagline}` : ''}`);
  lines.push(`Contact: phone ${a.phone}, WhatsApp ${a.whatsapp}, email ${a.email}. Address: ${a.address}.`);
  lines.push('Website: https://nexoraed.com (online application: https://nexoraed.com/apply).');
  if (!courses.length) lines.push('Courses: none are published at the moment.');
  for (const c of courses) {
    const total = c.feeComponents.reduce((sum, f) => sum + Number(f.amount) * (1 + Number(f.taxPercent) / 100), 0);
    lines.push('');
    lines.push(`Course: ${c.name} (code ${c.code})`);
    if (c.summary) lines.push(`  About: ${c.summary}`);
    lines.push(`  Duration: ${c.durationMonths} months. Mode: ${c.mode}.`);
    if (c.eligibility) lines.push(`  Eligibility: ${c.eligibility}`);
    lines.push(c.feeComponents.length ? `  Total fee: ${inr(total)} (including tax). Components: ${c.feeComponents.map((f) => `${f.name} ${inr(Number(f.amount))}${Number(f.taxPercent) ? ` + ${Number(f.taxPercent)}% tax` : ''}`).join('; ')}.` : '  Fee: not published — a counsellor will confirm.');
    lines.push(c.batches.length ? `  Upcoming / running batches: ${c.batches.map((b) => `${b.name} starting ${formatDate(b.startDate, a.timeZone)}${b.timing ? `, ${b.timing}` : ''}, ${b.mode}${b.status === 'RUNNING' ? ' (already running)' : ''}`).join('; ')}.` : '  Batches: no batch dates are published — a counsellor will confirm.');
  }
  return { text: lines.join('\n'), courses: courses.map((c) => ({ id: c.id, code: c.code, name: c.name })) };
}
