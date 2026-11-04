/* Seed: roles, admin + demo staff, masters, courses, batches, notification templates, approval workflows, sample CRM data. Idempotent. */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { DEFAULT_ROLES } from '../src/lib/permissions';

const prisma = new PrismaClient();
const DEMO = process.env.SEED_DEMO !== 'false';

async function main() {
  for (const r of DEFAULT_ROLES) {
    await prisma.role.upsert({ where: { key: r.key }, create: { ...r, isSystem: true }, update: { name: r.name, permissions: r.permissions, isSystem: true } });
  }
  const roles = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.key, r.id]));

  for (const name of ['Sales & Counselling', 'Administration', 'Finance', 'Academics', 'Examinations', 'Management']) {
    await prisma.department.upsert({ where: { name }, create: { name }, update: {} });
  }
  await prisma.branch.upsert({ where: { code: 'HQ' }, create: { code: 'HQ', name: 'Main Campus' }, update: {} });
  const dept = Object.fromEntries((await prisma.department.findMany()).map((d) => [d.name, d.id]));

  const pw = await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD || 'Admin@12345', 10);
  const mkUser = async (username: string, name: string, role: string, department?: string, phone?: string) =>
    prisma.user.upsert({
      where: { username },
      create: { username, email: `${username}@nexoraed.com`, name, phone, passwordHash: pw, departmentId: department ? dept[department] : null, designation: DEFAULT_ROLES.find((r) => r.key === role)?.name, roles: { create: { roleId: roles[role] } }, ...(role === 'faculty' && { faculty: { create: { qualifications: 'M.Tech', subjects: [] } } }) },
      update: {},
    });
  await mkUser('admin', 'Super Administrator', 'super_admin');
  if (DEMO) {
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
  }

  const masters: Record<string, [string, string, any?][]> = {
    lead_source: [['website', 'Website'], ['whatsapp', 'WhatsApp'], ['walk_in', 'Walk-in'], ['phone', 'Phone call'], ['referral', 'Referral'], ['instagram', 'Instagram'], ['facebook', 'Facebook'], ['google_ads', 'Google Ads'], ['event', 'Education fair / event'], ['import', 'Imported list']],
    lost_reason: [['fees_high', 'Fees too high'], ['joined_other', 'Joined another institute'], ['no_response', 'No response'], ['location', 'Location / timing'], ['not_eligible', 'Not eligible'], ['postponed', 'Postponed plans'], ['wrong_number', 'Wrong number']],
    qualification: [['sslc', 'SSLC / 10th'], ['plus_two', 'Plus Two / 12th'], ['diploma', 'Diploma'], ['ug', "Bachelor's degree"], ['pg', "Master's degree"], ['other', 'Other']],
    document_type: [['photo', 'Passport photo', { mandatory: true }], ['id_proof', 'ID proof (Aadhaar / Passport)', { mandatory: true }], ['marksheet', 'Latest marksheet', { mandatory: true }], ['tc', 'Transfer certificate'], ['other', 'Other']],
    payment_mode: [['CASH', 'Cash'], ['UPI', 'UPI'], ['CARD', 'Card'], ['BANK_TRANSFER', 'Bank transfer'], ['CHEQUE', 'Cheque'], ['ONLINE', 'Online gateway']],
    city: [['kochi', 'Kochi'], ['kozhikode', 'Kozhikode'], ['thrissur', 'Thrissur'], ['trivandrum', 'Thiruvananthapuram'], ['malappuram', 'Malappuram'], ['kannur', 'Kannur']],
    discount_reason: [['early_bird', 'Early-bird offer'], ['sibling', 'Sibling discount'], ['merit', 'Merit'], ['staff_ref', 'Staff referral'], ['financial', 'Financial hardship']],
  };
  for (const [type, items] of Object.entries(masters)) {
    for (const [i, [code, label, meta]] of items.entries()) {
      await prisma.masterItem.upsert({ where: { type_code: { type, code } }, create: { type, code, label, sortOrder: i, meta }, update: { label, meta } });
    }
  }

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

  // Notification templates (FR-NTF-02). Set waTemplateName to an approved WhatsApp template to send outside the 24h window.
  const T: [string, string, string, string][] = [
    ['admission.confirmed', 'Admission confirmed', 'Welcome to Nexora Academy, {{name}}!', 'Hi {{name}}, your admission to {{course}} ({{batch}}) is confirmed. Student ID: {{studentCode}}. Portal login: {{username}} / {{password}} at {{portalUrl}}/login. Please change your password on first login.'],
    ['application.received', 'Application received', 'Application {{code}} received', 'Hi {{name}}, we have received your application {{code}} for {{course}}. Our counselor will contact you soon. Track it any time on our website.'],
    ['enquiry.received', 'Enquiry received', 'Thanks for contacting Nexora Academy', 'Hi {{name}}, thank you for your interest in Nexora Academy! A counselor will reach out shortly. Reply here on WhatsApp for any questions.'],
    ['payment.received', 'Payment receipt', 'Payment received — {{receipt}}', 'Hi {{name}}, we received ₹{{amount}} on {{date}} (receipt {{receipt}}). Balance outstanding: ₹{{balance}}. Thank you!'],
    ['fee.reminder_upcoming', 'Fee reminder (upcoming)', 'Fee installment due on {{dueDate}}', 'Hi {{name}}, a gentle reminder that installment #{{installment}} of ₹{{amount}} is due on {{dueDate}}. Please ignore if already paid.'],
    ['fee.reminder_overdue', 'Fee reminder (overdue)', 'Fee installment overdue', 'Hi {{name}}, installment #{{installment}} of ₹{{amount}} was due on {{dueDate}} and is {{days}} day(s) overdue. Please pay at the earliest or contact accounts.'],
    ['exam.scheduled', 'Exam scheduled', 'Exam scheduled: {{exam}}', 'Hi {{name}}, your {{mode}} exam "{{exam}}" is scheduled on {{start}} ({{duration}} min). All the best!'],
    ['result.published', 'Result published', 'Result published: {{exam}}', 'Hi {{name}}, your result for "{{exam}}" is published: {{marks}}/{{total}}, grade {{grade}} — {{status}}. View details in the student portal.'],
    ['result.corrected', 'Result corrected', 'Result updated: {{exam}}', 'Hi {{name}}, your marks for "{{exam}}" have been corrected to {{marks}} after review.'],
    ['certificate.issued', 'Certificate issued', 'Your certificate is ready', 'Congratulations {{name}}! Certificate {{number}} has been issued. Verification code: {{code}}. Download it from the student portal.'],
    ['timetable.published', 'Timetable published', 'Timetable published', 'Hi {{name}}, your class timetable from {{from}} to {{to}} is now available in the portal.'],
    ['timetable.changed', 'Timetable changed', 'Class {{status}}', 'Hi {{name}}, the class "{{title}}" on {{when}} has been {{status}}. Check the portal for details.'],
    ['assignment.created', 'New assignment', 'New assignment: {{title}}', 'Hi {{name}}, a new assignment "{{title}}" has been posted. Due: {{due}}.'],
    ['auth.password_reset', 'Password reset', 'Reset your Nexora password', 'Hi {{name}}, use this link to reset your password (valid 30 minutes): {{link}}. If you did not request this, ignore this message.'],
    ['user.welcome', 'Staff welcome', 'Your Nexora portal account', 'Hi {{name}}, your Nexora staff account is ready. Username: {{username}}, temporary password: {{password}}. You will be asked to change it at first login.'],
  ];
  for (const [key, name, subject, body] of T) {
    await prisma.notificationTemplate.upsert({ where: { key }, create: { key, name, subject, body, channels: key.startsWith('timetable') || key === 'assignment.created' ? ['IN_APP'] : ['IN_APP', 'EMAIL', 'WHATSAPP'] }, update: {} });
  }

  // Approval workflows (SRS §22)
  const W: [string, string, { level: number; role: string; minAmount?: number }[]][] = [
    ['ADMISSION', 'Admission', [{ level: 1, role: 'sales_manager' }]],
    ['DISCOUNT', 'Fee discount / scholarship', [{ level: 1, role: 'finance_manager' }, { level: 2, role: 'management', minAmount: 10000 }]],
    ['REFUND', 'Refund', [{ level: 1, role: 'finance_manager' }, { level: 2, role: 'management', minAmount: 5000 }]],
    ['PAYMENT_CANCELLATION', 'Payment / receipt cancellation', [{ level: 1, role: 'finance_manager' }]],
    ['BATCH_TRANSFER', 'Batch transfer / course change', [{ level: 1, role: 'academic_manager' }]],
    ['RESULT_CORRECTION', 'Result correction', [{ level: 1, role: 'exam_officer' }, { level: 2, role: 'academic_manager' }]],
    ['CERTIFICATE', 'Certificate issue', [{ level: 1, role: 'exam_officer' }]],
    ['ATTENDANCE_EDIT', 'Late attendance edit', [{ level: 1, role: 'academic_manager' }]],
    ['EXAM_REATTEMPT', 'Exam re-attempt / eligibility exception', [{ level: 1, role: 'exam_officer' }]],
  ];
  for (const [type, name, levels] of W) await prisma.approvalWorkflow.upsert({ where: { type }, create: { type, name, levels }, update: {} });

  if (DEMO && (await prisma.lead.count()) === 0) {
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
  console.log('Seed complete. Login: admin / ' + (process.env.SEED_ADMIN_PASSWORD ? '<SEED_ADMIN_PASSWORD>' : 'Admin@12345'));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
