/**
 * Reference data seed (production-safe, idempotent): roles, departments, branch, master data,
 * notification templates and approval workflows. Creates NO users and NO passwords (R1).
 * Existing rows are not overwritten, so changes made by a Super Administrator are preserved.
 *
 *   npm run db:seed:reference
 */
import { PrismaClient } from '@prisma/client';
import { DEFAULT_ROLES } from '../lib/permissions';

export async function seedReference(prisma: PrismaClient) {
  for (const r of DEFAULT_ROLES) {
    // Permissions are only set on create; later changes come from migrations or the role editor.
    await prisma.role.upsert({ where: { key: r.key }, create: { ...r, isSystem: true }, update: { isSystem: true, ...(r.key === 'super_admin' && { permissions: ['*'] }) } });
  }
  for (const name of ['Sales & Counselling', 'Administration', 'Finance', 'Academics', 'Examinations', 'Management']) {
    await prisma.department.upsert({ where: { name }, create: { name }, update: {} });
  }
  await prisma.branch.upsert({ where: { code: 'HQ' }, create: { code: 'HQ', name: 'Main Campus' }, update: {} });

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

  // Notification templates (FR-NTF-02). Set waTemplateName to an approved WhatsApp template to send outside the 24h window.
  const T: [string, string, string, string][] = [
    ['admission.confirmed', 'Admission confirmed', 'Welcome to Nexora Academy, {{name}}!', 'Hi {{name}}, your admission to {{course}} ({{batch}}) is confirmed. Student ID: {{studentCode}}. Activate your student portal account (username {{username}}) with this single-use link, valid {{hours}} hours: {{link}}'],
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
    ['security.email_changed', 'Security: email changed', 'Your Nexora sign-in email was changed', 'Hi {{name}}, the sign-in email for your Nexora account was changed to {{newEmail}}. If you did not request this, contact the academy immediately.'],
    ['security.account_locked', 'Security: account locked', 'Your Nexora account was locked', 'Hi {{name}}, your Nexora account was locked for {{minutes}} minutes after several failed sign-in attempts. If this was not you, contact the academy.'],
    ['security.session_reuse', 'Security: suspicious sign-in', 'Suspicious activity on your Nexora account', 'Hi {{name}}, we detected reuse of an old sign-in token and signed you out everywhere. If this was not you, change your password.'],
    ['user.welcome', 'Staff welcome', 'Your Nexora portal account', 'Hi {{name}}, your Nexora staff account (username {{username}}) is ready. Set your password with this single-use link, valid {{hours}} hours: {{link}}. Administrative roles will then set up an authenticator app.'],
  ];
  for (const [key, name, subject, body] of T) {
    await prisma.notificationTemplate.upsert({ where: { key }, create: { key, name, subject, body, channels: key.startsWith('timetable') || key === 'assignment.created' ? ['IN_APP'] : ['admission.confirmed', 'user.welcome', 'auth.password_reset'].includes(key) ? ['EMAIL', 'WHATSAPP'] : ['IN_APP', 'EMAIL', 'WHATSAPP'] }, update: {} });
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
    // SRS 22.2: privileged role grants need a second Super Administrator (requesters cannot approve their own request).
    ['USER_PRIVILEGE', 'Privileged role grant', [{ level: 1, role: 'super_admin' }]],
  ];
  for (const [type, name, levels] of W) await prisma.approvalWorkflow.upsert({ where: { type }, create: { type, name, levels }, update: {} });
}

if (require.main === module) {
  const prisma = new PrismaClient();
  seedReference(prisma)
    .then(() => console.log('Reference data seeded (no users created). Create the first Super Administrator with `npm run admin:bootstrap`.'))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
