/**
 * Demo data (R1): staff users, courses, batches and sample leads — for development, test and staging ONLY.
 * Refuses to run when NODE_ENV or APP_ENV is production. Each user gets a random password (printed once),
 * an @example.invalid email, and must change the password at first sign-in. In APP_ENV=test or development,
 * DEMO_PASSWORD may set a known password that still has to satisfy the password policy.
 *
 *   APP_ENV=development npm run db:seed:demo
 */
import type { PrismaClient } from '#prisma';
import { withLocalDb } from '../cli/local-db';
import { DEFAULT_ROLES } from '../lib/permissions';
import { hashPassword, passwordProblems } from '../lib/password';
import { randomPassword } from '../lib/util';
import { seedReference } from './reference';

export { DEMO_USERNAMES, LEGACY_DEFAULT_USERNAMES } from './demo-accounts';
import { DEMO_USERNAMES } from './demo-accounts';

export function assertDemoAllowed(e: NodeJS.ProcessEnv = process.env) {
  const appEnv = e.APP_ENV ?? (e.NODE_ENV === 'test' ? 'test' : undefined);
  if (e.NODE_ENV === 'production' || !['development', 'test', 'staging'].includes(appEnv ?? '')) {
    throw new Error('Demo seed refused: set APP_ENV to development, test or staging (never production).');
  }
  return appEnv as 'development' | 'test' | 'staging';
}

export async function seedDemo(prisma: PrismaClient, e: NodeJS.ProcessEnv = process.env) {
  const appEnv = assertDemoAllowed(e);
  await seedReference(prisma);
  const roles = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.key, r.id]));
  const dept = Object.fromEntries((await prisma.department.findMany()).map((d) => [d.name, d.id]));
  const fixed = appEnv !== 'staging' ? e.DEMO_PASSWORD : undefined;
  if (fixed && passwordProblems(fixed).length) throw new Error(`DEMO_PASSWORD does not meet the password policy: ${passwordProblems(fixed).join(' ')}`);
  const issued: [string, string][] = [];
  const mkUser = async (username: string, name: string, role: string, department?: string, phone?: string) => {
    if (await prisma.user.findUnique({ where: { username } })) return;
    const pw = fixed ?? randomPassword();
    await prisma.user.create({
      data: {
        username, email: `${username}@example.invalid`, name, phone, passwordHash: await hashPassword(pw), mustChangePassword: appEnv !== 'test',
        departmentId: department ? dept[department] : null, designation: DEFAULT_ROLES.find((r) => r.key === role)?.name,
        roles: { create: { roleId: roles[role] } }, ...(role === 'faculty' && { faculty: { create: { qualifications: 'M.Tech', subjects: [] } } }),
      },
    });
    if (!fixed) issued.push([username, pw]);
  };
  await mkUser('director', 'Anita Menon', 'management', 'Management');
  await mkUser('office', 'Rahul Nair', 'admin', 'Administration');
  await mkUser('salesmgr', 'Fathima Rasheed', 'sales_manager', 'Sales & Counselling');
  await mkUser('counselor1', 'Arjun Das', 'counselor', 'Sales & Counselling', '+919000000101');
  await mkUser('counselor2', 'Sneha Pillai', 'counselor', 'Sales & Counselling', '+919000000102');
  await mkUser('finmgr', 'George Thomas', 'finance_manager', 'Finance');
  await mkUser('accounts', 'Meera Krishnan', 'finance_staff', 'Finance');
  await mkUser('acadmgr', 'Dr. Lakshmi Iyer', 'academic_manager', 'Academics');
  await mkUser('faculty1', 'Vivek Sharma', 'faculty', 'Academics');
  await mkUser('faculty2', 'Divya Raj', 'faculty', 'Academics');
  await mkUser('examofficer', 'Suresh Kumar', 'exam_officer', 'Examinations');

  const courses = [
    { code: 'FSD', name: 'Full Stack Web Development', category: 'Technology', durationMonths: 6, defaultInstallments: 3, summary: 'Build production-grade web apps with React, Node.js and PostgreSQL.', highlights: ['Live projects', 'Placement support', 'Industry mentors'], eligibility: 'Plus Two / any degree', fee: [['Admission fee', 5000, 0], ['Tuition fee', 45000, 18], ['Exam fee', 2000, 0]], subjects: [['WEB', 'Web Fundamentals', ['HTML & CSS', 'JavaScript', 'Responsive design']], ['FE', 'Front-end with React', ['Components & hooks', 'State management', 'Routing']], ['BE', 'Back-end with Node.js', ['Express & REST', 'Databases & SQL', 'Auth & security']]] },
    { code: 'DM', name: 'Digital Marketing Professional', category: 'Marketing', durationMonths: 4, defaultInstallments: 2, summary: 'SEO, social media, performance marketing and analytics — hands-on with live campaigns.', highlights: ['Google & Meta certifications', 'Live ad budget', 'Freelance toolkit'], eligibility: 'Plus Two', fee: [['Admission fee', 3000, 0], ['Tuition fee', 27000, 18]], subjects: [['SEO', 'Search Engine Optimisation', ['On-page SEO', 'Technical SEO']], ['SMM', 'Social Media Marketing', ['Content strategy', 'Paid social']], ['ANL', 'Analytics', ['GA4', 'Reporting']]] },
    { code: 'DSA', name: 'Data Science & AI', category: 'Technology', durationMonths: 8, defaultInstallments: 4, summary: 'Python, statistics, machine learning and generative AI with real datasets.', highlights: ['Capstone project', 'GPU lab access', 'Kaggle mentoring'], eligibility: 'Any degree (Maths in +2 preferred)', fee: [['Admission fee', 5000, 0], ['Tuition fee', 70000, 18], ['Exam fee', 3000, 0]], subjects: [['PY', 'Python for Data', ['Python basics', 'NumPy & Pandas']], ['ML', 'Machine Learning', ['Regression', 'Classification', 'Model evaluation']], ['GAI', 'Generative AI', ['LLMs', 'RAG applications']]] },
    { code: 'ACC', name: 'Accounting with Tally & GST', category: 'Commerce', durationMonths: 3, defaultInstallments: 1, summary: 'Practical accounting, Tally Prime, GST filing and payroll basics.', highlights: ['Job-ready in 3 months', 'GST portal practice'], eligibility: 'Plus Two (Commerce preferred)', fee: [['Admission fee', 2000, 0], ['Tuition fee', 14000, 18]], subjects: [['FA', 'Financial Accounting', ['Journal & ledger', 'Final accounts']], ['TLY', 'Tally Prime', ['Vouchers', 'Inventory']], ['GST', 'GST', ['Returns', 'E-way bill']]] },
  ];
  for (const c of courses) {
    const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const existing = await prisma.course.findUnique({ where: { code: c.code } });
    if (existing) continue;
    const course = await prisma.course.create({
      data: {
        code: c.code, name: c.name, slug, category: c.category, durationMonths: c.durationMonths, defaultInstallments: c.defaultInstallments, summary: c.summary, description: c.summary, highlights: c.highlights, eligibility: c.eligibility,
        feeComponents: { create: c.fee.map(([name, amount, taxPercent]) => ({ name: name as string, amount: amount as number, taxPercent: taxPercent as number })) },
      },
    });
    for (const [i, [code, name, mods]] of c.subjects.entries()) {
      await prisma.subject.create({ data: { courseId: course.id, code: code as string, name: name as string, sequence: i + 1, hours: 40, modules: { create: (mods as string[]).map((m, j) => ({ name: m, sequence: j + 1, hours: 10 })) } } });
    }
    const start = new Date();
    start.setDate(1);
    start.setMonth(start.getMonth() + 1);
    await prisma.batch.create({ data: { code: `${c.code}-${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`, name: `${c.name} — ${start.toLocaleString('en', { month: 'short' })} ${start.getFullYear()}`, courseId: course.id, startDate: start, endDate: new Date(start.getTime() + c.durationMonths * 30 * 864e5), timing: '10:00 AM – 1:00 PM', capacity: 30, status: 'PLANNED' } });
    const running = new Date();
    running.setMonth(running.getMonth() - 1);
    await prisma.batch.create({ data: { code: `${c.code}-${running.getFullYear()}-${String(running.getMonth() + 1).padStart(2, '0')}`, name: `${c.name} — ${running.toLocaleString('en', { month: 'short' })} ${running.getFullYear()}`, courseId: course.id, startDate: running, endDate: new Date(running.getTime() + c.durationMonths * 30 * 864e5), timing: '2:00 PM – 5:00 PM', capacity: 30, status: 'RUNNING' } });
  }

  if ((await prisma.lead.count()) === 0) {
    const counselors = await prisma.user.findMany({ where: { roles: { some: { role: { key: 'counselor' } } } } });
    const cs = await prisma.course.findMany();
    const names = ['Aditya Menon', 'Nihala Basheer', 'Rohan George', 'Ananya Suresh', 'Mohammed Shafi', 'Keerthana R', 'Jithin Joseph', 'Sana Fathima', 'Akhil Varghese', 'Devika Nair', 'Hari Prasad', 'Riya Thomas'];
    const statuses = ['NEW', 'CONTACTED', 'INTERESTED', 'COUNSELLED', 'NEW', 'CONTACTED', 'INTERESTED', 'LOST', 'NEW', 'COUNSELLED', 'CONTACTED', 'NEW'] as const;
    const sources = ['website', 'whatsapp', 'instagram', 'walk_in', 'referral', 'google_ads'];
    for (const [i, name] of names.entries()) {
      const phone = `+9198470${String(10000 + i).slice(-5)}`;
      const owner = counselors[i % counselors.length];
      const lead = await prisma.lead.create({
        data: {
          code: `LD-DEMO-${String(i + 1).padStart(4, '0')}`, name, phone, phoneNormalized: phone, email: `${name.split(' ')[0].toLowerCase()}${i}@example.com`, emailNormalized: `${name.split(' ')[0].toLowerCase()}${i}@example.com`,
          courseId: cs[i % cs.length].id, source: sources[i % sources.length], status: statuses[i], ownerId: owner?.id, closeReason: statuses[i] === 'LOST' ? 'Fees too high' : null,
          createdAt: new Date(Date.now() - i * 2 * 864e5), lastActivityAt: new Date(Date.now() - i * 864e5), nextFollowUpAt: i % 3 === 0 ? new Date(Date.now() + (i - 4) * 3600_000) : null,
        },
      });
      await prisma.leadActivity.create({ data: { leadId: lead.id, type: 'SYSTEM', content: `Lead created from ${lead.source}` } });
      if (lead.nextFollowUpAt && owner) await prisma.followUp.create({ data: { leadId: lead.id, dueAt: lead.nextFollowUpAt, mode: i % 2 ? 'WHATSAPP' : 'CALL', note: 'Discuss batch timings & fee plan', userId: owner.id } });
    }
    await prisma.sequence.upsert({ where: { name: 'lead' }, create: { name: 'lead', next: 100 }, update: {} });
  }
  return issued;
}

if (require.main === module) {
  withLocalDb((prisma) => seedDemo(prisma)
    .then((issued) => {
      console.log('Demo data seeded. Privileged demo users must enrol MFA at first sign-in.');
      if (issued.length) {
        console.log('One-time demo passwords (shown once; change at first sign-in):');
        for (const [u, p] of issued) console.log(`  ${u.padEnd(12)} ${p}`);
      }
    })
    .catch((e) => {
      console.error(e.message ?? e);
      process.exitCode = 1;
    })
  );
}
