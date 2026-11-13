import { Router } from 'express';
import { z } from 'zod';
import Branch from '../../models/Branch.js';
import User from '../../models/User.js';
import Lead from '../../models/Lead.js';
import { authenticate, requireAdmin } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { ROLES, DISTRIBUTION_STRATEGY_VALUES, TERMINAL_STATUSES } from '../../config/constants.js';
import { asyncHandler, notFound, conflict } from '../../utils/errors.js';

const router = Router();
router.use(authenticate);

const bilingual = z.object({ ar: z.string().trim().min(1), en: z.string().trim().min(1) });
const bilingualOptional = z.object({ ar: z.string().trim().optional(), en: z.string().trim().optional() }).partial();

const createSchema = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]+$/, 'Use lowercase letters, digits, - or _'),
  name: bilingual,
  city: bilingualOptional.optional(),
  address: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  email: z.string().email().optional(),
  distributionStrategy: z.enum(DISTRIBUTION_STRATEGY_VALUES).optional(),
});

const updateSchema = createSchema.partial().extend({ isActive: z.boolean().optional() });

/**
 * Everyone can read the branch list — agents need it to label leads — but only
 * an admin can create or change one.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter = req.user.role === ROLES.ADMIN ? {} : { isActive: true };
    const branches = await Branch.find(filter).sort({ 'name.en': 1 });
    res.json({ success: true, data: branches });
  }),
);

/** Branch card for the dashboard: team size and live pipeline volume. */
router.get(
  '/:id/summary',
  asyncHandler(async (req, res) => {
    const branch = await Branch.findById(req.params.id);
    if (!branch) throw notFound('Branch not found');

    const [teamCounts, openLeads, totalLeads] = await Promise.all([
      User.aggregate([
        { $match: { branch: branch._id, isActive: true } },
        { $group: { _id: '$role', n: { $sum: 1 } } },
      ]),
      Lead.countDocuments({ branch: branch._id, status: { $nin: TERMINAL_STATUSES } }),
      Lead.countDocuments({ branch: branch._id }),
    ]);

    res.json({
      success: true,
      data: {
        branch,
        team: Object.fromEntries(teamCounts.map((t) => [t._id, t.n])),
        openLeads,
        totalLeads,
      },
    });
  }),
);

router.post(
  '/',
  requireAdmin,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const exists = await Branch.findOne({ code: req.body.code });
    if (exists) throw conflict(`A branch with the code "${req.body.code}" already exists`);

    const branch = await Branch.create(req.body);
    res.status(201).json({ success: true, data: branch });
  }),
);

router.patch(
  '/:id',
  requireAdmin,
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const branch = await Branch.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!branch) throw notFound('Branch not found');
    res.json({ success: true, data: branch });
  }),
);

/**
 * Branches are deactivated, never deleted — their leads and history have to
 * stay readable.
 */
router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const branch = await Branch.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!branch) throw notFound('Branch not found');
    res.json({ success: true, data: { message: 'Branch deactivated', branch } });
  }),
);

export default router;
