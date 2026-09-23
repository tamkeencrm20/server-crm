import dayjs from 'dayjs';
import Lead from '../models/Lead.js';
import User from '../models/User.js';
import Activity from '../models/Activity.js';
import env from '../config/env.js';
import logger from '../utils/logger.js';
import { normalizePhone } from '../utils/phone.js';
import { assignLead } from './distribution.service.js';
import { notifyLeadEnrolled } from './notification.service.js';
import { emitTo, room } from './realtime.js';
import {
  ACTIVITY_TYPE,
  LEAD_STATUS,
  ROLES,
  STATUS_TRANSITIONS,
  TERMINAL_STATUSES,
  WON_STATUSES,
} from '../config/constants.js';
import { badRequest, conflict } from '../utils/errors.js';

/**
 * Look for an existing lead that is really the same person.
 *
 * Two guards, in order of strength:
 *   1. Meta's own leadgen id — exact, and the reason webhook retries are safe.
 *   2. Same normalised phone within the dedupe window.
 *
 * @returns {Promise<import('mongoose').Document|null>}
 */
export async function findDuplicate({ phone, metaLeadgenId }) {
  if (metaLeadgenId) {
    const byMeta = await Lead.findOne({ 'meta.leadgenId': String(metaLeadgenId) });
    if (byMeta) return byMeta;
  }

  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const since = dayjs().subtract(env.LEAD_DEDUPE_WINDOW_DAYS, 'day').toDate();
  return Lead.findOne({ phone: normalized, isDuplicate: false, createdAt: { $gte: since } }).sort({
    createdAt: -1,
  });
}

/**
 * Create a lead and run it through the automation: de-duplicate, persist,
 * distribute, notify. The single entry point used by the Meta webhook, the
 * manual create form, and CSV import, so all three behave identically.
 *
 * @param {object} draft lead fields
 * @param {object} [options]
 * @param {boolean} [options.autoAssign=true]
 * @param {string}  [options.createdBy] user id, for manually entered leads
 * @param {boolean} [options.throwOnDuplicate=false] manual entry wants an error;
 *   the webhook wants a quiet no-op so Meta stops retrying.
 * @returns {Promise<{lead, duplicate: boolean, assignment: object|null}>}
 */
export async function intakeLead(draft, { autoAssign = true, createdBy, throwOnDuplicate = false, notify = true } = {}) {
  const existing = await findDuplicate({
    phone: draft.phone,
    metaLeadgenId: draft.meta?.leadgenId,
  });

  if (existing) {
    if (throwOnDuplicate) {
      throw conflict('A lead with this phone number already exists', {
        code: 'DUPLICATE_LEAD',
        details: { leadId: String(existing._id), assignedTo: existing.assignedTo },
      });
    }

    // Record the repeat enquiry on the original lead instead of creating a
    // second one, so the owning agent sees the person came back.
    await Activity.log({
      lead: existing._id,
      branch: existing.branch,
      type: ACTIVITY_TYPE.SYSTEM,
      note: `Duplicate enquiry received from ${draft.source ?? 'unknown source'} and merged into this lead`,
      isSystem: true,
    });
    await Lead.updateOne({ _id: existing._id }, { $set: { lastActivityAt: new Date() } });

    logger.info(`Duplicate lead ignored (matches ${existing._id})`);
    return { lead: existing, duplicate: true, assignment: null };
  }

  const lead = await Lead.create({ ...draft, createdBy });

  await Activity.log({
    lead: lead._id,
    branch: lead.branch,
    actor: createdBy,
    type: ACTIVITY_TYPE.SYSTEM,
    note: `Lead created from ${lead.source}`,
    isSystem: !createdBy,
  });

  let assignment = null;
  if (autoAssign) {
    assignment = await assignLead(lead, { notify });
  }

  emitTo([room.branch(String(lead.branch)), room.admins()], 'lead:created', {
    leadId: String(lead._id),
    fullName: lead.fullName,
    source: lead.source,
  });

  return { lead, duplicate: false, assignment };
}

/**
 * Move a lead through the pipeline, keeping every derived field honest:
 * timestamps, contact counters, the agent's open-lead count, and the timeline.
 *
 * @param {import('mongoose').Document} lead
 * @param {string} nextStatus
 * @param {import('mongoose').Document} actor
 * @param {object} [extra]
 * @param {string} [extra.note]
 * @param {Date}   [extra.nextFollowUpAt]
 * @param {number} [extra.dealValue]
 * @param {string} [extra.lostReason]
 */
export async function changeLeadStatus(lead, nextStatus, actor, extra = {}) {
  const current = lead.status;

  if (current === nextStatus) {
    throw badRequest(`Lead is already marked as "${nextStatus}"`, { code: 'STATUS_UNCHANGED' });
  }

  const allowed = STATUS_TRANSITIONS[current] ?? [];
  if (!allowed.includes(nextStatus)) {
    throw badRequest(`Cannot move a lead from "${current}" to "${nextStatus}"`, {
      code: 'INVALID_TRANSITION',
      details: { from: current, to: nextStatus, allowed },
    });
  }

  const now = new Date();
  const wasOpen = !TERMINAL_STATUSES.includes(current);
  const nowOpen = !TERMINAL_STATUSES.includes(nextStatus);

  lead.status = nextStatus;
  lead.statusChangedAt = now;
  lead.lastActivityAt = now;

  // The first move off "new" is the response the KPI dashboard measures.
  if (current === LEAD_STATUS.NEW && !lead.firstContactedAt) {
    lead.firstContactedAt = now;
  }
  if (nextStatus === LEAD_STATUS.CONTACTED || nextStatus === LEAD_STATUS.NO_RESPONSE) {
    lead.contactAttempts += 1;
  }

  if (nextStatus === LEAD_STATUS.FOLLOW_UP) {
    if (!extra.nextFollowUpAt) {
      throw badRequest('A follow-up date is required when setting the status to "follow_up"', {
        code: 'FOLLOW_UP_DATE_REQUIRED',
      });
    }
    lead.nextFollowUpAt = extra.nextFollowUpAt;
  } else if (TERMINAL_STATUSES.includes(nextStatus)) {
    lead.nextFollowUpAt = undefined;
  } else if (extra.nextFollowUpAt) {
    lead.nextFollowUpAt = extra.nextFollowUpAt;
  }

  if (WON_STATUSES.includes(nextStatus)) {
    lead.enrolledAt = now;
    if (extra.dealValue != null) lead.dealValue = extra.dealValue;
  }
  if (nextStatus === LEAD_STATUS.NOT_INTERESTED || nextStatus === LEAD_STATUS.CLOSED) {
    if (extra.lostReason) lead.lostReason = extra.lostReason;
  }

  await lead.save();

  // Keep the agent's open-lead counter in step with the pipeline.
  if (lead.assignedTo && wasOpen !== nowOpen) {
    await User.updateOne({ _id: lead.assignedTo }, { $inc: { openLeadsCount: nowOpen ? 1 : -1 } });
  }

  await Activity.log({
    lead: lead._id,
    branch: lead.branch,
    actor: actor._id,
    type: ACTIVITY_TYPE.STATUS_CHANGE,
    fromStatus: current,
    toStatus: nextStatus,
    note: extra.note,
    scheduledFor: lead.nextFollowUpAt,
  });

  if (WON_STATUSES.includes(nextStatus)) {
    const watchers = await User.find({
      $or: [{ role: ROLES.ADMIN }, { role: ROLES.TEAM_LEADER, branch: lead.branch }],
    })
      .select('_id')
      .lean();
    notifyLeadEnrolled(
      watchers.map((w) => w._id),
      lead,
      actor.name,
    );
  }

  emitTo([room.branch(String(lead.branch)), room.admins()], 'lead:status', {
    leadId: String(lead._id),
    from: current,
    to: nextStatus,
  });

  return lead;
}

/**
 * Record a contact attempt (call, WhatsApp, note) without necessarily moving
 * the lead through the pipeline.
 */
export async function logContact(lead, actor, { type, note, callOutcome, callDurationSeconds, nextFollowUpAt }) {
  const now = new Date();

  lead.lastActivityAt = now;
  if (type === ACTIVITY_TYPE.CALL || type === ACTIVITY_TYPE.WHATSAPP) {
    lead.contactAttempts += 1;
    if (!lead.firstContactedAt) lead.firstContactedAt = now;
  }
  if (nextFollowUpAt) lead.nextFollowUpAt = nextFollowUpAt;

  await lead.save();

  return Activity.log({
    lead: lead._id,
    branch: lead.branch,
    actor: actor._id,
    type,
    note,
    callOutcome,
    callDurationSeconds,
    scheduledFor: nextFollowUpAt,
  });
}
