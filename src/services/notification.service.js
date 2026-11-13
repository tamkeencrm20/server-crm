import Notification from '../models/Notification.js';
import { NOTIFICATION_TYPE } from '../config/constants.js';
import { emitTo, room } from './realtime.js';
import logger from '../utils/logger.js';

/**
 * Persist a notification and push it down the recipient's socket immediately.
 * Notifications are best-effort: a failure here must never roll back the
 * business action that triggered it.
 */
export async function notify({ user, type, title, body, lead, link }) {
  if (!user) return null;
  try {
    const doc = await Notification.create({ user, type, title, body, lead, link });
    emitTo(room.user(user), 'notification:new', doc.toJSON());
    return doc;
  } catch (err) {
    logger.error('Failed to create notification', err);
    return null;
  }
}

/** Fan a single notification out to many recipients. */
export async function notifyMany(userIds, payload) {
  const unique = [...new Set(userIds.filter(Boolean).map(String))];
  return Promise.all(unique.map((user) => notify({ ...payload, user })));
}

// ---------------------------------------------------------------------------
// Ready-made notifications for the events the spec calls out.
// ---------------------------------------------------------------------------

export function notifyLeadAssigned(agentId, lead) {
  return notify({
    user: agentId,
    type: NOTIFICATION_TYPE.LEAD_ASSIGNED,
    title: { ar: 'عميل جديد تم إسناده إليك', en: 'A new lead was assigned to you' },
    body: {
      ar: `${lead.fullName} — ${lead.courseRaw || 'استفسار عام'}`,
      en: `${lead.fullName} — ${lead.courseRaw || 'General enquiry'}`,
    },
    lead: lead._id,
    link: `/leads/${lead._id}`,
  });
}

/**
 * One message covering a whole imported batch. A 500-row upload would otherwise
 * ring an agent's bell 500 times, which trains people to ignore the bell.
 */
export function notifyLeadsImported(agentId, count, uploaderName) {
  return notify({
    user: agentId,
    type: NOTIFICATION_TYPE.LEAD_ASSIGNED,
    title: { ar: 'عملاء جدد من ملف مستورد', en: 'New leads from an import' },
    body: {
      ar: `تم إسناد ${count} عميلاً إليك من ملف رفعه ${uploaderName}`,
      en: `${count} leads were assigned to you from a file uploaded by ${uploaderName}`,
    },
    link: '/leads?assignedTo=me&source=import',
  });
}

export function notifyFollowUpDue(agentId, lead) {
  return notify({
    user: agentId,
    type: NOTIFICATION_TYPE.FOLLOW_UP_DUE,
    title: { ar: 'موعد متابعة مستحق', en: 'Follow-up due' },
    body: {
      ar: `حان موعد متابعة ${lead.fullName}`,
      en: `It is time to follow up with ${lead.fullName}`,
    },
    lead: lead._id,
    link: `/leads/${lead._id}`,
  });
}

export function notifyLeadStale(agentId, lead, hours) {
  return notify({
    user: agentId,
    type: NOTIFICATION_TYPE.LEAD_STALE,
    title: { ar: 'عميل بانتظار التواصل', en: 'Lead still waiting' },
    body: {
      ar: `${lead.fullName} لم يتم التواصل معه منذ ${hours} ساعة`,
      en: `${lead.fullName} has not been contacted for ${hours} hours`,
    },
    lead: lead._id,
    link: `/leads/${lead._id}`,
  });
}

export function notifyLeadEnrolled(recipientIds, lead, agentName) {
  return notifyMany(recipientIds, {
    type: NOTIFICATION_TYPE.LEAD_ENROLLED,
    title: { ar: 'تسجيل جديد 🎉', en: 'New enrolment 🎉' },
    body: {
      ar: `${agentName} سجّل ${lead.fullName}`,
      en: `${agentName} enrolled ${lead.fullName}`,
    },
    lead: lead._id,
    link: `/leads/${lead._id}`,
  });
}
