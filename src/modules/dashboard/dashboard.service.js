import dayjs from 'dayjs';
import Lead from '../../models/Lead.js';
import User from '../../models/User.js';
import { LEAD_STATUS, LEAD_STATUS_VALUES, ROLES, TERMINAL_STATUSES, WON_STATUSES } from '../../config/constants.js';

/**
 * Every KPI the management dashboard shows. All of them take the same
 * `scope` object — the caller builds it from the signed-in user's role, so a
 * team leader physically cannot aggregate another branch.
 */

/** Normalise a date range, defaulting to the last 30 days. */
export function resolveRange({ from, to } = {}) {
  const end = to ? dayjs(to).endOf('day') : dayjs().endOf('day');
  const start = from ? dayjs(from).startOf('day') : end.subtract(29, 'day').startOf('day');
  return { start: start.toDate(), end: end.toDate(), days: end.diff(start, 'day') + 1 };
}

const rangeMatch = (scope, start, end) => ({ ...scope, isDuplicate: false, createdAt: { $gte: start, $lte: end } });

/**
 * Headline numbers: volume, response speed, conversion, revenue.
 * @param {object} scope Lead filter narrowing to what the caller may see
 */
export async function getOverview(scope, range) {
  const { start, end } = range;
  const match = rangeMatch(scope, start, end);

  const [totals, responseStats, revenue, todayCount, unassigned, overdue] = await Promise.all([
    Lead.aggregate([{ $match: match }, { $group: { _id: '$status', n: { $sum: 1 } } }]),

    // Response time is only meaningful for leads someone actually called.
    Lead.aggregate([
      { $match: { ...match, firstContactedAt: { $ne: null } } },
      {
        $project: {
          minutes: { $divide: [{ $subtract: ['$firstContactedAt', '$createdAt'] }, 60000] },
        },
      },
      {
        $group: {
          _id: null,
          avgMinutes: { $avg: '$minutes' },
          contacted: { $sum: 1 },
          withinOneHour: { $sum: { $cond: [{ $lte: ['$minutes', 60] }, 1, 0] } },
        },
      },
    ]),

    Lead.aggregate([
      { $match: { ...scope, isDuplicate: false, status: { $in: WON_STATUSES }, enrolledAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$dealValue', 0] } }, enrolments: { $sum: 1 } } },
    ]),

    Lead.countDocuments({ ...scope, isDuplicate: false, createdAt: { $gte: dayjs().startOf('day').toDate() } }),
    Lead.countDocuments({ ...scope, isDuplicate: false, assignedTo: null }),
    Lead.countDocuments({
      ...scope,
      isDuplicate: false,
      status: { $nin: TERMINAL_STATUSES },
      nextFollowUpAt: { $ne: null, $lte: new Date() },
    }),
  ]);

  const byStatus = Object.fromEntries(LEAD_STATUS_VALUES.map((s) => [s, 0]));
  let total = 0;
  totals.forEach((row) => {
    byStatus[row._id] = row.n;
    total += row.n;
  });

  const enrolled = byStatus[LEAD_STATUS.ENROLLED] ?? 0;
  const r = responseStats[0] ?? { avgMinutes: null, contacted: 0, withinOneHour: 0 };

  return {
    totalLeads: total,
    leadsToday: todayCount,
    byStatus,
    unassigned,
    overdueFollowUps: overdue,

    contacted: r.contacted,
    // Share of leads that received a first contact at all.
    responseRate: total > 0 ? +((r.contacted / total) * 100).toFixed(1) : 0,
    avgResponseMinutes: r.avgMinutes != null ? Math.round(r.avgMinutes) : null,
    respondedWithinOneHourRate: r.contacted > 0 ? +((r.withinOneHour / r.contacted) * 100).toFixed(1) : 0,

    enrolled,
    conversionRate: total > 0 ? +((enrolled / total) * 100).toFixed(1) : 0,
    revenue: revenue[0]?.total ?? 0,
    enrolmentsInRange: revenue[0]?.enrolments ?? 0,
  };
}

/** Daily lead volume, for the trend chart. */
export async function getDailyTrend(scope, range) {
  const rows = await Lead.aggregate([
    { $match: rangeMatch(scope, range.start, range.end) },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        leads: { $sum: 1 },
        enrolled: { $sum: { $cond: [{ $eq: ['$status', LEAD_STATUS.ENROLLED] }, 1, 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  // Fill the gaps so the chart has one point per day.
  const byDate = new Map(rows.map((r) => [r._id, r]));
  const out = [];
  for (let d = dayjs(range.start); !d.isAfter(dayjs(range.end), 'day'); d = d.add(1, 'day')) {
    const key = d.format('YYYY-MM-DD');
    const hit = byDate.get(key);
    out.push({ date: key, leads: hit?.leads ?? 0, enrolled: hit?.enrolled ?? 0 });
  }
  return out;
}

/** Leaderboard of sales agents. */
export async function getAgentPerformance(scope, range, limit = 20) {
  const rows = await Lead.aggregate([
    { $match: { ...rangeMatch(scope, range.start, range.end), assignedTo: { $ne: null } } },
    {
      $group: {
        _id: '$assignedTo',
        leads: { $sum: 1 },
        enrolled: { $sum: { $cond: [{ $eq: ['$status', LEAD_STATUS.ENROLLED] }, 1, 0] } },
        contacted: { $sum: { $cond: [{ $ne: ['$firstContactedAt', null] }, 1, 0] } },
        revenue: {
          $sum: {
            $cond: [{ $eq: ['$status', LEAD_STATUS.ENROLLED] }, { $ifNull: ['$dealValue', 0] }, 0],
          },
        },
        avgResponseMinutes: {
          $avg: {
            $cond: [
              { $ne: ['$firstContactedAt', null] },
              { $divide: [{ $subtract: ['$firstContactedAt', '$createdAt'] }, 60000] },
              null,
            ],
          },
        },
      },
    },
    { $sort: { enrolled: -1, leads: -1 } },
    { $limit: limit },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'agent' } },
    { $unwind: '$agent' },
    { $lookup: { from: 'branches', localField: 'agent.branch', foreignField: '_id', as: 'branch' } },
    { $unwind: { path: '$branch', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        agentId: '$_id',
        name: '$agent.name',
        email: '$agent.email',
        isAvailable: '$agent.isAvailable',
        branch: { _id: '$branch._id', name: '$branch.name', code: '$branch.code' },
        leads: 1,
        contacted: 1,
        enrolled: 1,
        revenue: 1,
        avgResponseMinutes: { $round: [{ $ifNull: ['$avgResponseMinutes', 0] }, 0] },
        conversionRate: {
          $cond: [{ $gt: ['$leads', 0] }, { $round: [{ $multiply: [{ $divide: ['$enrolled', '$leads'] }, 100] }, 1] }, 0],
        },
      },
    },
  ]);

  return rows;
}

/** Same shape, grouped by branch. */
export async function getBranchPerformance(scope, range) {
  return Lead.aggregate([
    { $match: { ...rangeMatch(scope, range.start, range.end), branch: { $ne: null } } },
    {
      $group: {
        _id: '$branch',
        leads: { $sum: 1 },
        enrolled: { $sum: { $cond: [{ $eq: ['$status', LEAD_STATUS.ENROLLED] }, 1, 0] } },
        contacted: { $sum: { $cond: [{ $ne: ['$firstContactedAt', null] }, 1, 0] } },
        revenue: {
          $sum: { $cond: [{ $eq: ['$status', LEAD_STATUS.ENROLLED] }, { $ifNull: ['$dealValue', 0] }, 0] },
        },
      },
    },
    { $lookup: { from: 'branches', localField: '_id', foreignField: '_id', as: 'branch' } },
    { $unwind: '$branch' },
    {
      $project: {
        _id: 0,
        branchId: '$_id',
        code: '$branch.code',
        name: '$branch.name',
        leads: 1,
        contacted: 1,
        enrolled: 1,
        revenue: 1,
        conversionRate: {
          $cond: [{ $gt: ['$leads', 0] }, { $round: [{ $multiply: [{ $divide: ['$enrolled', '$leads'] }, 100] }, 1] }, 0],
        },
      },
    },
    { $sort: { enrolled: -1 } },
  ]);
}

/** Which campaigns and courses are actually producing enrolments. */
export async function getSourceBreakdown(scope, range) {
  const [bySource, byCourse, byCampaign, byPlatform] = await Promise.all([
    Lead.aggregate([
      { $match: rangeMatch(scope, range.start, range.end) },
      {
        $group: {
          _id: '$source',
          leads: { $sum: 1 },
          enrolled: { $sum: { $cond: [{ $eq: ['$status', LEAD_STATUS.ENROLLED] }, 1, 0] } },
        },
      },
      { $sort: { leads: -1 } },
    ]),

    Lead.aggregate([
      { $match: { ...rangeMatch(scope, range.start, range.end), course: { $ne: null } } },
      {
        $group: {
          _id: '$course',
          leads: { $sum: 1 },
          enrolled: { $sum: { $cond: [{ $eq: ['$status', LEAD_STATUS.ENROLLED] }, 1, 0] } },
        },
      },
      { $sort: { leads: -1 } },
      { $limit: 10 },
      { $lookup: { from: 'courses', localField: '_id', foreignField: '_id', as: 'course' } },
      { $unwind: '$course' },
      { $project: { _id: 0, courseId: '$_id', name: '$course.name', code: '$course.code', leads: 1, enrolled: 1 } },
    ]),

    Lead.aggregate([
      { $match: { ...rangeMatch(scope, range.start, range.end), 'meta.campaignName': { $ne: null } } },
      {
        $group: {
          // Campaign names repeat across networks, so the network is part of
          // the key — otherwise a TikTok and a Meta campaign sharing a name
          // would be reported as one line.
          _id: { campaign: '$meta.campaignName', network: '$meta.network' },
          leads: { $sum: 1 },
          enrolled: { $sum: { $cond: [{ $eq: ['$status', LEAD_STATUS.ENROLLED] }, 1, 0] } },
          revenue: { $sum: { $ifNull: ['$dealValue', 0] } },
        },
      },
      { $sort: { leads: -1 } },
      { $limit: 12 },
      {
        $project: {
          _id: '$_id.campaign',
          network: '$_id.network',
          leads: 1,
          enrolled: 1,
          revenue: 1,
        },
      },
    ]),

    // Network-level totals: the media buyer's headline question is which of the
    // three platforms is actually converting, not just delivering volume.
    Lead.aggregate([
      { $match: { ...rangeMatch(scope, range.start, range.end), 'meta.network': { $ne: null } } },
      {
        $group: {
          _id: '$meta.network',
          leads: { $sum: 1 },
          contacted: { $sum: { $cond: [{ $ne: ['$firstContactedAt', null] }, 1, 0] } },
          enrolled: { $sum: { $cond: [{ $eq: ['$status', LEAD_STATUS.ENROLLED] }, 1, 0] } },
          revenue: { $sum: { $ifNull: ['$dealValue', 0] } },
        },
      },
      { $sort: { leads: -1 } },
      {
        $addFields: {
          conversionRate: {
            $cond: [{ $gt: ['$leads', 0] }, { $round: [{ $multiply: [{ $divide: ['$enrolled', '$leads'] }, 100] }, 1] }, 0],
          },
        },
      },
    ]),
  ]);

  return { bySource, byCourse, byCampaign, byPlatform };
}

/** Live team state for the "who is on shift" strip. */
export async function getTeamStatus(branchFilter) {
  const agents = await User.find({ role: ROLES.AGENT, isActive: true, ...branchFilter })
    .select('name isAvailable openLeadsCount lastAssignedAt branch')
    .populate('branch', 'code name')
    .sort({ openLeadsCount: -1 })
    .lean();

  return {
    total: agents.length,
    available: agents.filter((a) => a.isAvailable).length,
    agents,
  };
}
