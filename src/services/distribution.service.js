import User from '../models/User.js';
import Branch from '../models/Branch.js';
import Course from '../models/Course.js';
import Lead from '../models/Lead.js';
import Activity from '../models/Activity.js';
import Assignment from '../models/Assignment.js';
import DistributionCursor, { cursorKey } from '../models/DistributionCursor.js';
import { ROLES, ACTIVITY_TYPE, DISTRIBUTION_STRATEGY, TERMINAL_STATUSES } from '../config/constants.js';
import { notifyLeadAssigned } from './notification.service.js';
import { emitTo, room } from './realtime.js';
import logger from '../utils/logger.js';

/**
 * Automatic lead distribution.
 *
 * The rules, straight from the spec:
 *   - only ACTIVE and AVAILABLE agents receive leads
 *   - distribution is scoped to the branch on the lead
 *   - it can be narrowed further by course (a course may name specialists)
 *   - the same lead is never distributed twice
 *   - every decision, including every failure, is written to Assignment
 *
 * Fairness comes from an atomic cursor rather than an in-memory index, so two
 * leads arriving in the same millisecond cannot collide on the same agent even
 * with several server processes running.
 */

/** Midnight-to-now window used for the daily cap check. */
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Who may receive a lead for this branch/course right now.
 * @returns {Promise<{agents: Array, narrowedByCourse: boolean}>}
 */
export async function findEligibleAgents(branchId, courseId) {
  if (!branchId) return { agents: [], narrowedByCourse: false };

  const agents = await User.find({
    role: ROLES.AGENT,
    branch: branchId,
    isActive: true,
    isAvailable: true,
  })
    .select('_id name email dailyLeadCap openLeadsCount lastAssignedAt')
    .sort({ _id: 1 }) // stable order, the cursor depends on it
    .lean();

  if (agents.length === 0) return { agents: [], narrowedByCourse: false };

  // Drop anyone who already hit their cap today.
  const capped = agents.filter((a) => a.dailyLeadCap > 0);
  let available = agents;

  if (capped.length > 0) {
    const todayCounts = await Assignment.aggregate([
      {
        $match: {
          assignedTo: { $in: capped.map((a) => a._id) },
          succeeded: true,
          createdAt: { $gte: startOfToday() },
        },
      },
      { $group: { _id: '$assignedTo', n: { $sum: 1 } } },
    ]);
    const byAgent = new Map(todayCounts.map((r) => [String(r._id), r.n]));
    available = agents.filter(
      (a) => a.dailyLeadCap === 0 || (byAgent.get(String(a._id)) ?? 0) < a.dailyLeadCap,
    );
  }

  if (available.length === 0) return { agents: [], narrowedByCourse: false };

  // If the course names specialists and any of them are available, the lead
  // stays inside that pool. Otherwise the whole branch team is fair game.
  if (courseId) {
    const course = await Course.findById(courseId).select('specialistAgents').lean();
    const specialistIds = new Set((course?.specialistAgents ?? []).map(String));
    if (specialistIds.size > 0) {
      const specialists = available.filter((a) => specialistIds.has(String(a._id)));
      if (specialists.length > 0) return { agents: specialists, narrowedByCourse: true };
    }
  }

  return { agents: available, narrowedByCourse: false };
}

/**
 * Pick the next agent using a strict rotation backed by an atomic counter.
 * @returns {Promise<{agent: object, key: string, seq: number, reason: string}>}
 */
async function pickRoundRobin(agents, branchId, courseId, narrowedByCourse) {
  const key = cursorKey(branchId, narrowedByCourse ? courseId : null);

  const cursor = await DistributionCursor.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  // seq is 1 after the first increment, so subtract to make the very first
  // lead land on agents[0].
  const index = (cursor.seq - 1) % agents.length;
  return {
    agent: agents[index],
    key,
    seq: cursor.seq,
    reason: `round_robin: seq ${cursor.seq} over ${agents.length} eligible agent(s), index ${index}`,
  };
}

/** Whoever currently holds the fewest open leads; ties broken by who waited longest. */
function pickLeastLoaded(agents) {
  const sorted = [...agents].sort((a, b) => {
    if (a.openLeadsCount !== b.openLeadsCount) return a.openLeadsCount - b.openLeadsCount;
    return new Date(a.lastAssignedAt ?? 0) - new Date(b.lastAssignedAt ?? 0);
  });
  return {
    agent: sorted[0],
    key: null,
    seq: null,
    reason: `least_loaded: ${sorted[0].openLeadsCount} open lead(s), fewest of ${agents.length}`,
  };
}

/** Write the audit row for a distribution attempt that produced nothing. */
async function recordFailure(lead, failureReason, extra = {}) {
  logger.warn(`Lead ${lead._id} not distributed: ${failureReason}`);
  await Assignment.create({
    lead: lead._id,
    branch: lead.branch?._id ?? lead.branch,
    course: lead.course?._id ?? lead.course,
    strategy: extra.strategy ?? DISTRIBUTION_STRATEGY.ROUND_ROBIN,
    eligibleCount: 0,
    succeeded: false,
    failureReason,
  });
}

/**
 * Assign one lead automatically.
 *
 * Refuses to touch a lead that already has an owner, which is what makes this
 * safe to call from the Meta webhook (Meta retries deliveries) and from a
 * manual "distribute unassigned" sweep at the same time.
 *
 * @param {import('mongoose').Document} lead
 * @param {object} [options]
 * @param {boolean} [options.force] reassign even if already owned
 * @returns {Promise<{assigned: boolean, agent?: object, reason: string}>}
 */
export async function assignLead(lead, { force = false, notify = true } = {}) {
  if (lead.assignedTo && !force) {
    return { assigned: false, reason: 'Lead already has an owner' };
  }

  const branchId = lead.branch?._id ?? lead.branch;
  const courseId = lead.course?._id ?? lead.course;

  if (!branchId) {
    await recordFailure(lead, 'No branch resolved for this lead, left in the unassigned queue');
    return { assigned: false, reason: 'No branch on lead' };
  }

  const branch = await Branch.findById(branchId).select('distributionStrategy isActive').lean();
  if (!branch?.isActive) {
    await recordFailure(lead, 'Branch is inactive');
    return { assigned: false, reason: 'Branch inactive' };
  }

  if (branch.distributionStrategy === DISTRIBUTION_STRATEGY.MANUAL) {
    await recordFailure(lead, 'Branch is set to manual distribution', {
      strategy: DISTRIBUTION_STRATEGY.MANUAL,
    });
    return { assigned: false, reason: 'Manual distribution' };
  }

  const { agents, narrowedByCourse } = await findEligibleAgents(branchId, courseId);

  if (agents.length === 0) {
    await recordFailure(lead, 'No active and available agent in this branch', {
      strategy: branch.distributionStrategy,
    });
    return { assigned: false, reason: 'No eligible agents' };
  }

  const pick =
    branch.distributionStrategy === DISTRIBUTION_STRATEGY.LEAST_LOADED
      ? pickLeastLoaded(agents)
      : await pickRoundRobin(agents, branchId, courseId, narrowedByCourse);

  const previousAssignee = lead.assignedTo ?? null;

  if (previousAssignee) lead.previousAssignees.push(previousAssignee);
  lead.assignedTo = pick.agent._id;
  lead.assignedAt = new Date();
  lead.lastActivityAt = new Date();
  await lead.save();

  await Promise.all([
    User.updateOne(
      { _id: pick.agent._id },
      { $inc: { openLeadsCount: 1, totalLeadsCount: 1 }, $set: { lastAssignedAt: new Date() } },
    ),
    previousAssignee
      ? User.updateOne({ _id: previousAssignee }, { $inc: { openLeadsCount: -1 } })
      : null,
    Assignment.create({
      lead: lead._id,
      branch: branchId,
      course: courseId,
      assignedTo: pick.agent._id,
      previousAssignee,
      assignedBy: null,
      strategy: branch.distributionStrategy,
      cursorKey: pick.key,
      cursorSeq: pick.seq,
      eligibleAgents: agents.map((a) => a._id),
      eligibleCount: agents.length,
      reason: narrowedByCourse ? `${pick.reason} (course specialists only)` : pick.reason,
      succeeded: true,
    }),
    Activity.log({
      lead: lead._id,
      branch: branchId,
      type: ACTIVITY_TYPE.ASSIGNMENT,
      toUser: pick.agent._id,
      fromUser: previousAssignee,
      note: `Auto-assigned to ${pick.agent.name}`,
      isSystem: true,
    }),
    DistributionCursor.updateOne(
      { key: pick.key ?? cursorKey(branchId, null) },
      { $set: { lastAssignedTo: pick.agent._id, lastAssignedAt: new Date() } },
    ),
  ]);

  // A bulk import turns this off and sends one summary per agent instead of
  // one alert per row.
  if (notify) notifyLeadAssigned(pick.agent._id, lead);
  emitTo([room.branch(String(branchId)), room.admins()], 'lead:assigned', {
    leadId: String(lead._id),
    agentId: String(pick.agent._id),
    agentName: pick.agent.name,
  });

  logger.info(`Lead ${lead._id} -> ${pick.agent.name} (${pick.reason})`);
  return { assigned: true, agent: pick.agent, reason: pick.reason };
}

/**
 * Move a lead to a specific agent by hand (team leader / admin action).
 *
 * @param {import('mongoose').Document} lead
 * @param {string} agentId
 * @param {import('mongoose').Document} actor who is doing the reassignment
 */
export async function reassignLead(lead, agentId, actor) {
  const agent = await User.findOne({ _id: agentId, isActive: true }).select('_id name branch role');
  if (!agent) throw new Error('Target agent not found or inactive');

  const previousAssignee = lead.assignedTo ?? null;
  if (previousAssignee && String(previousAssignee) === String(agent._id)) {
    return { assigned: false, reason: 'Lead already belongs to this agent' };
  }

  if (previousAssignee) lead.previousAssignees.push(previousAssignee);
  lead.assignedTo = agent._id;
  lead.assignedAt = new Date();
  lead.lastActivityAt = new Date();
  await lead.save();

  const stillOpen = !TERMINAL_STATUSES.includes(lead.status);

  await Promise.all([
    User.updateOne(
      { _id: agent._id },
      {
        $inc: stillOpen ? { openLeadsCount: 1, totalLeadsCount: 1 } : { totalLeadsCount: 1 },
        $set: { lastAssignedAt: new Date() },
      },
    ),
    previousAssignee && stillOpen
      ? User.updateOne({ _id: previousAssignee }, { $inc: { openLeadsCount: -1 } })
      : null,
    Assignment.create({
      lead: lead._id,
      branch: lead.branch,
      course: lead.course,
      assignedTo: agent._id,
      previousAssignee,
      assignedBy: actor._id,
      strategy: 'manual',
      eligibleCount: 1,
      reason: `Manually reassigned by ${actor.name}`,
      succeeded: true,
    }),
    Activity.log({
      lead: lead._id,
      branch: lead.branch,
      actor: actor._id,
      type: ACTIVITY_TYPE.ASSIGNMENT,
      fromUser: previousAssignee,
      toUser: agent._id,
      note: `Reassigned to ${agent.name} by ${actor.name}`,
    }),
  ]);

  notifyLeadAssigned(agent._id, lead);
  return { assigned: true, agent, reason: 'manual' };
}

/**
 * Sweep the unassigned queue, used after agents come back online and by the
 * scheduled job. Processes sequentially so the rotation order is preserved.
 *
 * @param {object} [filter] extra Lead filter, e.g. { branch }
 * @param {number} [limit]
 */
export async function distributeUnassigned(filter = {}, limit = 200) {
  const leads = await Lead.find({ assignedTo: null, isDuplicate: false, ...filter })
    .sort({ createdAt: 1 })
    .limit(limit);

  const results = { total: leads.length, assigned: 0, skipped: 0 };
  for (const lead of leads) {
    // Sequential on purpose: parallel calls would interleave the cursor.
    // eslint-disable-next-line no-await-in-loop
    const res = await assignLead(lead);
    if (res.assigned) results.assigned += 1;
    else results.skipped += 1;
  }
  return results;
}

/**
 * Recompute openLeadsCount from scratch. The denormalised counter is what the
 * least-loaded strategy reads, so it gets a repair path.
 */
export async function recalculateAgentLoads() {
  const counts = await Lead.aggregate([
    { $match: { assignedTo: { $ne: null }, status: { $nin: TERMINAL_STATUSES } } },
    { $group: { _id: '$assignedTo', n: { $sum: 1 } } },
  ]);

  const byAgent = new Map(counts.map((c) => [String(c._id), c.n]));
  const agents = await User.find({ role: ROLES.AGENT }).select('_id').lean();

  const ops = agents.map((a) => ({
    updateOne: {
      filter: { _id: a._id },
      update: { $set: { openLeadsCount: byAgent.get(String(a._id)) ?? 0 } },
    },
  }));

  if (ops.length > 0) await User.bulkWrite(ops);
  return { agentsUpdated: ops.length };
}
