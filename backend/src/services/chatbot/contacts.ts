/**
 * Who is writing on WhatsApp: matched to the EXISTING lead / student / guardian records by normalised phone
 * (no copy of their details), and duplicate-safe lead creation for new enquiries.
 */
import { prisma } from '../../lib/prisma';
import { atomic, type ReadDb } from '../../lib/db';
import { createLead, findDuplicateLead } from '../../routes/crm';

export type ContactKind = 'LEAD' | 'STUDENT' | 'PARENT' | 'UNKNOWN';

export async function matchContact(phoneNormalized: string, db: ReadDb = prisma) {
  const [student, guardian, lead] = await Promise.all([
    db.student.findUnique({ where: { phoneNormalized }, select: { id: true, fullName: true } }),
    db.guardian.findFirst({ where: { phoneNormalized }, select: { id: true, name: true, studentId: true } }),
    db.lead.findFirst({ where: { phoneNormalized }, orderBy: { createdAt: 'desc' } }),
  ]);
  const kind: ContactKind = student ? 'STUDENT' : guardian ? 'PARENT' : lead ? 'LEAD' : 'UNKNOWN';
  return { student, guardian, lead, kind };
}

/**
 * New enquiry from an unknown number: creates ONE lead even when several messages from that number are processed at
 * the same moment. A per-phone lock serialises check-and-create; a concurrent creator makes this batch retry, and the
 * retry finds the lead the other one created. New leads are assigned by the existing CRM rules (createLead).
 */
export async function findOrCreateLeadForPhone(phoneNormalized: string, name: string | null, firstMessage: string, extra: { chatwootContactId?: number | null; chatwootConversationId?: number | null } = {}) {
  return atomic(async (tx) => {
    await tx.lock(`lead-phone:${phoneNormalized}`);
    const dup = await findDuplicateLead(tx, phoneNormalized);
    if (dup) return { lead: dup, created: false };
    const lead = await createLead(
      tx,
      { name: (name || '').trim().slice(0, 120) || phoneNormalized, phone: phoneNormalized, source: 'whatsapp', notes: `First WhatsApp message: ${firstMessage.slice(0, 500)}` },
      undefined,
      { chatwootContactId: extra.chatwootContactId ?? null, chatwootConversationId: extra.chatwootConversationId ?? null },
    );
    return { lead, created: true };
  });
}
