import { Router } from 'express';
import { z } from 'zod';
import Lead from '../../models/Lead.js';
import Activity from '../../models/Activity.js';
import Assignment from '../../models/Assignment.js';
import { authenticate, requireLeader, requireBranchInsight } from '../../middleware/auth.js';
import { validate, q } from '../../middleware/validate.js';
import { leadScopeFilter, canAccessLead, canModifyLead, assertCanAssignWithin } from '../../middleware/scope.js';
import {
  ACTIVITY_TYPE_VALUES,
  ACTIVITY_TYPE,
  CALL_OUTCOME_VALUES,
  LEAD_SOURCE,
  LEAD_SOURCE_VALUES,
  LEAD_STATUS_VALUES,
  ROLES,
  TERMINAL_STATUSES,
} from '../../config/constants.js';
import { asyncHandler, notFound, forbidden, badRequest } from '../../utils/errors.js';
import { intakeLead, changeLeadStatus, logContact } from '../../services/lead.service.js';
import { importLeads } from '../../services/import.service.js';
import { reassignLead, distributeUnassigned, assignLead } from '../../services/distribution.service.js';

const router = Router();
router.use(authenticate);

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

/** Load a lead and enforce visibility in one step. */
async function loadLead(req) {
  const lead = await Lead.findById(req.params.id)
    .populate('assignedTo', 'name email phone')
    .populate('branch', 'code name')
    .populate('course', 'code name price currency');

  if (!lead) throw notFound('Lead not found');
  if (!canAccessLead(req.user, lead)) throw forbidden('You do not have access to this lead');
  return lead;
}

/**
 * Same lookup, but for routes that change the record. Reading and writing are
 * separate permissions: a media buyer sees the whole branch pipeline and may
 * not touch any of it, so every mutating route must load through this instead
 * of loadLead.
 */
async function loadLeadForWrite(req) {
  const lead = await loadLead(req);
  if (!canModifyLead(req.user, lead)) {
    throw forbidden('Your role can view this lead but not change it', { code: 'READ_ONLY_ROLE' });
  }
  return lead;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  status: z.union([z.enum(LEAD_STATUS_VALUES), z.array(z.enum(LEAD_STATUS_VALUES))]).optional(),
  source: z.enum(LEAD_SOURCE_VALUES).optional(),
  branch: objectId.optional(),
  course: objectId.optional(),
  assignedTo: z.union([objectId, z.literal('unassigned'), z.literal('me')]).optional(),
  search: z.string().trim().max(120).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  followUpDue: z.enum(['true', 'false']).optional(),
  open: z.enum(['true', 'false']).optional(),
  sort: z.enum(['newest', 'oldest', 'activity', 'followup']).default('newest'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const SORTS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  activity: { lastActivityAt: -1 },
  followup: { nextFollowUpAt: 1 },
};

router.get(
  '/',
  validate(listQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const p = q(req);
    const filter = { ...leadScopeFilter(req.user), isDuplicate: false };

    if (p.status) filter.status = Array.isArray(p.status) ? { $in: p.status } : p.status;
    if (p.source) filter.source = p.source;
    if (p.course) filter.course = p.course;

    // Admins may narrow to a branch; everyone else is already narrowed by scope.
    if (p.branch && req.user.role === ROLES.ADMIN) filter.branch = p.branch;

    if (p.assignedTo) {
      if (p.assignedTo === 'unassigned') {
        if (req.user.role === ROLES.AGENT) throw forbidden('Agents cannot browse the unassigned queue');
        filter.assignedTo = null;
      } else if (p.assignedTo === 'me') {
        filter.assignedTo = req.user._id;
      } else if (req.user.role !== ROLES.AGENT) {
        filter.assignedTo = p.assignedTo;
      }
    }

    if (p.open === 'true') filter.status = { $nin: TERMINAL_STATUSES };
    if (p.open === 'false') filter.status = { $in: TERMINAL_STATUSES };

    if (p.followUpDue === 'true') {
      filter.nextFollowUpAt = { $ne: null, $lte: new Date() };
      filter.status = { $nin: TERMINAL_STATUSES };
    }

    if (p.from || p.to) {
      filter.createdAt = {};
      if (p.from) filter.createdAt.$gte = p.from;
      if (p.to) filter.createdAt.$lte = p.to;
    }

    if (p.search) {
      filter.$or = [
        { fullName: { $regex: p.search, $options: 'i' } },
        { phone: { $regex: p.search.replace(/\D/g, ''), $options: 'i' } },
        { email: { $regex: p.search, $options: 'i' } },
        { courseRaw: { $regex: p.search, $options: 'i' } },
      ];
    }

    const [items, total] = await Promise.all([
      Lead.find(filter)
        .populate('assignedTo', 'name email')
        .populate('branch', 'code name')
        .populate('course', 'code name')
        .sort(SORTS[p.sort])
        .skip((p.page - 1) * p.limit)
        .limit(p.limit),
      Lead.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: items,
      pagination: { page: p.page, limit: p.limit, total, pages: Math.ceil(total / p.limit) },
    });
  }),
);

/** Counts per pipeline stage, for the kanban column headers. */
router.get(
  '/stats/pipeline',
  asyncHandler(async (req, res) => {
    const match = { ...leadScopeFilter(req.user), isDuplicate: false };
    const rows = await Lead.aggregate([{ $match: match }, { $group: { _id: '$status', n: { $sum: 1 } } }]);

    const counts = Object.fromEntries(LEAD_STATUS_VALUES.map((s) => [s, 0]));
    rows.forEach((r) => {
      counts[r._id] = r.n;
    });

    res.json({ success: true, data: counts });
  }),
);

/** The agent's own work queue: overdue follow-ups first, then untouched leads. */
router.get(
  '/my/queue',
  asyncHandler(async (req, res) => {
    const base = { assignedTo: req.user._id, isDuplicate: false, status: { $nin: TERMINAL_STATUSES } };

    const [dueFollowUps, untouched] = await Promise.all([
      Lead.find({ ...base, nextFollowUpAt: { $ne: null, $lte: new Date() } })
        .populate('course', 'code name')
        .sort({ nextFollowUpAt: 1 })
        .limit(50),
      Lead.find({ ...base, contactAttempts: 0 })
        .populate('course', 'code name')
        .sort({ createdAt: 1 })
        .limit(50),
    ]);

    res.json({ success: true, data: { dueFollowUps, untouched } });
  }),
);

// ---------------------------------------------------------------------------
// Read one
// ---------------------------------------------------------------------------

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const lead = await loadLead(req);
    const activities = await Activity.find({ lead: lead._id })
      .populate('actor', 'name role')
      .populate('fromUser toUser', 'name')
      .sort({ createdAt: -1 })
      .limit(200);

    res.json({ success: true, data: { lead, activities } });
  }),
);

/**
 * Bulk import from a spreadsheet. Open to every role — what changes is where
 * the leads land, which the service decides from the caller's role rather than
 * from anything the browser sends.
 */
const importSchema = z.object({
  rows: z.array(z.record(z.any())).min(1),
  branch: z.string().optional(),
  dryRun: z.boolean().optional(),
});

router.post(
  '/import',
  validate(importSchema),
  asyncHandler(async (req, res) => {
    const result = await importLeads(req.body.rows, {
      user: req.user,
      branch: req.body.branch,
      dryRun: req.body.dryRun === true,
    });
    res.status(result.dryRun ? 200 : 201).json({ success: true, data: result });
  }),
);

/** Why this lead landed where it did. Read-only, so media buyers see it too. */
router.get(
  '/:id/assignments',
  requireBranchInsight,
  asyncHandler(async (req, res) => {
    const lead = await loadLead(req);
    const history = await Assignment.find({ lead: lead._id })
      .populate('assignedTo previousAssignee assignedBy', 'name email')
      .sort({ createdAt: -1 });

    res.json({ success: true, data: history });
  }),
);

// ---------------------------------------------------------------------------
// Create (manual entry: walk-in, phone call, referral)
// ---------------------------------------------------------------------------

const createSchema = z.object({
  fullName: z.string().trim().min(2).max(160),
  phone: z.string().trim().min(6),
  email: z.string().email().optional().or(z.literal('')),
  branch: objectId.optional(),
  course: objectId.optional(),
  courseRaw: z.string().trim().optional(),
  source: z.enum(LEAD_SOURCE_VALUES).default(LEAD_SOURCE.MANUAL),
  tags: z.array(z.string().trim()).default([]),
  note: z.string().trim().max(2000).optional(),
  autoAssign: z.boolean().default(true),
});

router.post(
  '/',
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const { note, autoAssign, ...draft } = req.body;
    if (!draft.email) delete draft.email;

    // An agent entering a walk-in gets it in their own branch, assigned to them.
    if (req.user.role === ROLES.AGENT) {
      draft.branch = String(req.user.branch?._id ?? req.user.branch);
    } else if (!draft.branch) {
      draft.branch = req.user.branch ? String(req.user.branch?._id ?? req.user.branch) : undefined;
    }
    if (!draft.branch) throw badRequest('A branch is required');

    const { lead, duplicate } = await intakeLead(draft, {
      autoAssign: req.user.role === ROLES.AGENT ? false : autoAssign,
      createdBy: req.user._id,
      throwOnDuplicate: true,
    });

    // Manually entered by an agent: they keep it themselves.
    if (req.user.role === ROLES.AGENT && !lead.assignedTo) {
      await reassignLead(lead, req.user._id, req.user);
    }

    if (note) {
      await logContact(lead, req.user, { type: ACTIVITY_TYPE.NOTE, note });
    }

    res.status(201).json({ success: true, data: lead, duplicate });
  }),
);

// ---------------------------------------------------------------------------
// Update the record itself
// ---------------------------------------------------------------------------

const updateSchema = z.object({
  fullName: z.string().trim().min(2).max(160).optional(),
  phone: z.string().trim().min(6).optional(),
  email: z.string().email().optional().or(z.literal('')),
  course: objectId.nullable().optional(),
  courseRaw: z.string().trim().optional(),
  branch: objectId.optional(),
  tags: z.array(z.string().trim()).optional(),
  dealValue: z.coerce.number().min(0).optional(),
  nextFollowUpAt: z.coerce.date().nullable().optional(),
});

router.patch(
  '/:id',
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const lead = await loadLeadForWrite(req);

    // Moving a lead between branches is a routing decision, not data entry.
    if (req.body.branch && req.user.role !== ROLES.ADMIN) {
      throw forbidden('Only an admin can move a lead to another branch');
    }

    Object.assign(lead, req.body);
    lead.lastActivityAt = new Date();
    await lead.save();

    res.json({ success: true, data: lead });
  }),
);

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

const statusSchema = z.object({
  status: z.enum(LEAD_STATUS_VALUES),
  note: z.string().trim().max(2000).optional(),
  nextFollowUpAt: z.coerce.date().optional(),
  dealValue: z.coerce.number().min(0).optional(),
  lostReason: z.string().trim().max(500).optional(),
});

router.patch(
  '/:id/status',
  validate(statusSchema),
  asyncHandler(async (req, res) => {
    const lead = await loadLeadForWrite(req);
    const { status, ...extra } = req.body;
    const updated = await changeLeadStatus(lead, status, req.user, extra);
    res.json({ success: true, data: updated });
  }),
);

// ---------------------------------------------------------------------------
// Follow-up log
// ---------------------------------------------------------------------------

const activitySchema = z.object({
  type: z.enum(ACTIVITY_TYPE_VALUES).default(ACTIVITY_TYPE.NOTE),
  note: z.string().trim().max(4000).optional(),
  callOutcome: z.enum(CALL_OUTCOME_VALUES).optional(),
  callDurationSeconds: z.coerce.number().int().min(0).optional(),
  nextFollowUpAt: z.coerce.date().optional(),
});

router.post(
  '/:id/activities',
  validate(activitySchema),
  asyncHandler(async (req, res) => {
    const lead = await loadLeadForWrite(req);

    // These two are written by the system, never posted by a client.
    if ([ACTIVITY_TYPE.STATUS_CHANGE, ACTIVITY_TYPE.ASSIGNMENT].includes(req.body.type)) {
      throw badRequest('Status changes and assignments are recorded automatically');
    }

    const activity = await logContact(lead, req.user, req.body);
    res.status(201).json({ success: true, data: activity });
  }),
);

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

router.post(
  '/:id/assign',
  requireLeader,
  validate(z.object({ agentId: objectId })),
  asyncHandler(async (req, res) => {
    const lead = await loadLead(req);
    assertCanAssignWithin(req.user, lead.branch?._id ?? lead.branch);

    const result = await reassignLead(lead, req.body.agentId, req.user);
    res.json({ success: true, data: result });
  }),
);

/** Push one lead back through the automatic engine. */
router.post(
  '/:id/redistribute',
  requireLeader,
  asyncHandler(async (req, res) => {
    const lead = await loadLead(req);
    assertCanAssignWithin(req.user, lead.branch?._id ?? lead.branch);

    const result = await assignLead(lead, { force: true });
    res.json({ success: true, data: result });
  }),
);

/** Drain the unassigned queue — after a branch comes back online, say. */
router.post(
  '/distribute/unassigned',
  requireLeader,
  asyncHandler(async (req, res) => {
    const filter =
      req.user.role === ROLES.ADMIN ? {} : { branch: req.user.branch?._id ?? req.user.branch };
    const result = await distributeUnassigned(filter);
    res.json({ success: true, data: result });
  }),
);

export default router;
