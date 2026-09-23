import { Router } from 'express';
import { z } from 'zod';
import User from '../../models/User.js';
import { authenticate, requireAdmin, requireLeader } from '../../middleware/auth.js';
import { validate, q } from '../../middleware/validate.js';
import { userScopeFilter } from '../../middleware/scope.js';
import { ROLES, ROLE_VALUES, BRANCH_BOUND_ROLES } from '../../config/constants.js';
import { asyncHandler, notFound, forbidden, badRequest } from '../../utils/errors.js';
import { revokeAllSessions } from '../auth/auth.service.js';
import { recalculateAgentLoads } from '../../services/distribution.service.js';

const router = Router();
router.use(authenticate);

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

const listQuerySchema = z.object({
  role: z.enum(ROLE_VALUES).optional(),
  branch: objectId.optional(),
  isActive: z.enum(['true', 'false']).optional(),
  isAvailable: z.enum(['true', 'false']).optional(),
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  phone: z.string().trim().optional(),
  role: z.enum(ROLE_VALUES),
  branch: objectId.optional(),
  dailyLeadCap: z.coerce.number().int().min(0).default(0),
  locale: z.enum(['ar', 'en']).default('ar'),
});

const updateSchema = createSchema
  .omit({ password: true })
  .partial()
  .extend({
    isActive: z.boolean().optional(),
    isAvailable: z.boolean().optional(),
  });

/**
 * A team leader may only touch sales agents inside their own branch.
 *
 * Checked by exact role rather than by rank: a media buyer outranks nobody on
 * the sales team but is not part of it either, so a branch's team leader has
 * no business disabling the person who runs its ad accounts.
 */
function assertCanManage(actor, target) {
  if (actor.role === ROLES.ADMIN) return;
  if (actor.role !== ROLES.TEAM_LEADER) throw forbidden('You cannot manage other users');
  if (target.role !== ROLES.AGENT) throw forbidden('Team leaders can only manage sales agents');

  const own = String(actor.branch?._id ?? actor.branch);
  if (String(target.branch) !== own) throw forbidden('This user belongs to another branch');
}

// --- List ------------------------------------------------------------------

router.get(
  '/',
  validate(listQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { role, branch, isActive, isAvailable, search, page, limit } = q(req);

    const scope = userScopeFilter(req.user);
    const filter = { ...scope };

    // A requested role still has to satisfy the scope's own role rule, so the
    // two are combined. Assigning straight to filter.role would let
    // `?role=media_buyer` overwrite a team leader's scope and reveal exactly
    // the people that scope exists to hide.
    if (role) filter.role = scope.role ? { $eq: role, ...scope.role } : role;
    if (branch && req.user.role === ROLES.ADMIN) filter.branch = branch;
    if (isActive) filter.isActive = isActive === 'true';
    if (isAvailable) filter.isAvailable = isAvailable === 'true';
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    const [items, total] = await Promise.all([
      User.find(filter)
        .populate('branch', 'code name')
        .sort({ name: 1 })
        .skip((page - 1) * limit)
        .limit(limit),
      User.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  }),
);

/** Agents available to receive a lead — used by the reassignment dropdown. */
router.get(
  '/assignable',
  requireLeader,
  asyncHandler(async (req, res) => {
    const branch =
      req.user.role === ROLES.ADMIN ? req.query.branch : String(req.user.branch?._id ?? req.user.branch);
    if (!branch) throw badRequest('A branch is required');

    const agents = await User.find({ role: ROLES.AGENT, branch, isActive: true })
      .select('name email isAvailable openLeadsCount dailyLeadCap')
      .sort({ name: 1 });

    res.json({ success: true, data: agents });
  }),
);

// --- Read ------------------------------------------------------------------

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const filter = { _id: req.params.id, ...userScopeFilter(req.user) };
    const user = await User.findOne(filter).populate('branch', 'code name');
    if (!user) throw notFound('User not found');
    res.json({ success: true, data: user });
  }),
);

// --- Create ----------------------------------------------------------------

router.post(
  '/',
  requireLeader,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const { password, ...fields } = req.body;

    if (req.user.role === ROLES.TEAM_LEADER) {
      if (fields.role !== ROLES.AGENT) throw forbidden('Team leaders can only create sales agents');
      fields.branch = String(req.user.branch?._id ?? req.user.branch);
    }

    if (BRANCH_BOUND_ROLES.includes(fields.role) && !fields.branch) {
      throw badRequest('A branch is required for every role except admin');
    }
    if (fields.role === ROLES.ADMIN) delete fields.branch;

    const user = new User(fields);
    await user.setPassword(password);
    await user.save();

    res.status(201).json({ success: true, data: user.toJSON() });
  }),
);

// --- Update ----------------------------------------------------------------

router.patch(
  '/:id',
  requireLeader,
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw notFound('User not found');
    assertCanManage(req.user, user);

    // Only an admin may change roles or move someone between branches.
    if (req.user.role !== ROLES.ADMIN) {
      delete req.body.role;
      delete req.body.branch;
    }

    Object.assign(user, req.body);
    await user.save();

    // A deactivated account must not keep a live session.
    if (req.body.isActive === false) await revokeAllSessions(user._id);

    res.json({ success: true, data: user.toJSON() });
  }),
);

/** An agent flipping their own on-shift switch. */
router.patch(
  '/me/availability',
  validate(z.object({ isAvailable: z.boolean() })),
  asyncHandler(async (req, res) => {
    req.user.isAvailable = req.body.isAvailable;
    await req.user.save();
    res.json({ success: true, data: { isAvailable: req.user.isAvailable } });
  }),
);

// --- Reset password --------------------------------------------------------

router.post(
  '/:id/reset-password',
  requireLeader,
  validate(z.object({ newPassword: z.string().min(8) })),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id).select('+passwordHash');
    if (!user) throw notFound('User not found');
    assertCanManage(req.user, user);

    await user.setPassword(req.body.newPassword);
    await user.save();
    await revokeAllSessions(user._id);

    res.json({ success: true, data: { message: 'Password reset, the user must sign in again' } });
  }),
);

// --- Maintenance -----------------------------------------------------------

/** Repair the denormalised open-lead counters. */
router.post(
  '/recalculate-loads',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const result = await recalculateAgentLoads();
    res.json({ success: true, data: result });
  }),
);

export default router;
