import cron from 'node-cron';
import dayjs from 'dayjs';
import env from '../config/env.js';
import logger from '../utils/logger.js';
import Lead from '../models/Lead.js';
import Notification from '../models/Notification.js';
import { TERMINAL_STATUSES, LEAD_STATUS, NOTIFICATION_TYPE, DEFAULT_TIMEZONE } from '../config/constants.js';
import { notifyFollowUpDue, notifyLeadStale } from '../services/notification.service.js';
import { distributeUnassigned } from '../services/distribution.service.js';

/**
 * The scheduled half of the automation. Everything here is idempotent — a job
 * that runs twice must not send the same reminder twice, which is why each one
 * checks for a recent notification before creating another.
 */

const tz = { timezone: DEFAULT_TIMEZONE };

/** Has this user already been told about this lead recently? */
async function alreadyNotified(userId, leadId, type, withinHours) {
  const since = dayjs().subtract(withinHours, 'hour').toDate();
  const existing = await Notification.findOne({
    user: userId,
    lead: leadId,
    type,
    createdAt: { $gte: since },
  }).select('_id');
  return Boolean(existing);
}

/** Every 15 minutes: ping agents whose follow-up time has arrived. */
async function followUpReminders() {
  const due = await Lead.find({
    status: { $nin: TERMINAL_STATUSES },
    assignedTo: { $ne: null },
    nextFollowUpAt: { $ne: null, $lte: new Date() },
  })
    .select('fullName assignedTo nextFollowUpAt')
    .limit(500);

  let sent = 0;
  for (const lead of due) {
    // eslint-disable-next-line no-await-in-loop
    if (await alreadyNotified(lead.assignedTo, lead._id, NOTIFICATION_TYPE.FOLLOW_UP_DUE, 12)) continue;
    // eslint-disable-next-line no-await-in-loop
    await notifyFollowUpDue(lead.assignedTo, lead);
    sent += 1;
  }

  if (sent > 0) logger.info(`Follow-up reminders sent: ${sent}`);
  return sent;
}

/**
 * Hourly: a lead that has been sitting on "new" past the SLA is the single
 * biggest cause of lost enrolments, so the owning agent gets nudged.
 */
async function staleLeadAlerts() {
  const cutoff = dayjs().subtract(env.LEAD_STALE_HOURS, 'hour').toDate();

  const stale = await Lead.find({
    status: LEAD_STATUS.NEW,
    assignedTo: { $ne: null },
    contactAttempts: 0,
    assignedAt: { $ne: null, $lte: cutoff },
  })
    .select('fullName assignedTo assignedAt')
    .limit(500);

  let sent = 0;
  for (const lead of stale) {
    // eslint-disable-next-line no-await-in-loop
    if (await alreadyNotified(lead.assignedTo, lead._id, NOTIFICATION_TYPE.LEAD_STALE, 24)) continue;
    // eslint-disable-next-line no-await-in-loop
    await notifyLeadStale(lead.assignedTo, lead, env.LEAD_STALE_HOURS);
    sent += 1;
  }

  if (sent > 0) logger.info(`Stale lead alerts sent: ${sent}`);
  return sent;
}

/**
 * Every 10 minutes: retry the unassigned queue. Leads land there when no agent
 * was available; this picks them up as soon as someone comes back on shift.
 */
async function retryUnassigned() {
  const result = await distributeUnassigned({}, 100);
  if (result.assigned > 0) logger.info(`Unassigned queue swept: ${result.assigned}/${result.total} distributed`);
  return result;
}

export function startJobs() {
  if (!env.ENABLE_CRON) {
    logger.warn('Scheduled jobs are disabled (ENABLE_CRON=false)');
    return [];
  }

  const tasks = [
    cron.schedule('*/15 * * * *', () => followUpReminders().catch((e) => logger.error('followUpReminders failed', e)), tz),
    cron.schedule('0 * * * *', () => staleLeadAlerts().catch((e) => logger.error('staleLeadAlerts failed', e)), tz),
    cron.schedule('*/10 * * * *', () => retryUnassigned().catch((e) => logger.error('retryUnassigned failed', e)), tz),
  ];

  logger.info(`Scheduled jobs started (${tasks.length}) on ${DEFAULT_TIMEZONE}`);
  return tasks;
}

export const jobs = { followUpReminders, staleLeadAlerts, retryUnassigned };
