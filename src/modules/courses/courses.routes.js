import { Router } from 'express';
import { z } from 'zod';
import Course from '../../models/Course.js';
import { authenticate, requireAdmin } from '../../middleware/auth.js';
import { validate, q } from '../../middleware/validate.js';
import { ROLES, DEFAULT_CURRENCY } from '../../config/constants.js';
import { asyncHandler, notFound, conflict } from '../../utils/errors.js';

const router = Router();
router.use(authenticate);

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');
const bilingual = z.object({ ar: z.string().trim().min(1), en: z.string().trim().min(1) });
const bilingualOptional = z.object({ ar: z.string().trim().optional(), en: z.string().trim().optional() }).partial();

const createSchema = z.object({
  code: z.string().trim().toUpperCase().min(2).max(24),
  name: bilingual,
  category: bilingualOptional.optional(),
  description: bilingualOptional.optional(),
  price: z.coerce.number().min(0).default(0),
  currency: z.string().trim().default(DEFAULT_CURRENCY),
  durationHours: z.coerce.number().min(0).optional(),
  branches: z.array(objectId).default([]),
  specialistAgents: z.array(objectId).default([]),
});

const updateSchema = createSchema.partial().extend({ isActive: z.boolean().optional() });

const listQuerySchema = z.object({
  branch: objectId.optional(),
  search: z.string().trim().max(120).optional(),
  includeInactive: z.enum(['true', 'false']).default('false'),
});

router.get(
  '/',
  validate(listQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { branch, search, includeInactive } = q(req);

    const filter = {};
    if (!(includeInactive === 'true' && req.user.role === ROLES.ADMIN)) filter.isActive = true;
    // An empty `branches` array means the course runs at every branch.
    if (branch) filter.$or = [{ branches: branch }, { branches: { $size: 0 } }];
    if (search) {
      filter.$and = [
        {
          $or: [
            { 'name.ar': { $regex: search, $options: 'i' } },
            { 'name.en': { $regex: search, $options: 'i' } },
            { code: { $regex: search, $options: 'i' } },
          ],
        },
      ];
    }

    const courses = await Course.find(filter).populate('branches', 'code name').sort({ 'name.en': 1 });
    res.json({ success: true, data: courses });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const course = await Course.findById(req.params.id)
      .populate('branches', 'code name')
      .populate('specialistAgents', 'name email');
    if (!course) throw notFound('Course not found');
    res.json({ success: true, data: course });
  }),
);

router.post(
  '/',
  requireAdmin,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const exists = await Course.findOne({ code: req.body.code });
    if (exists) throw conflict(`A course with the code "${req.body.code}" already exists`);

    const course = await Course.create(req.body);
    res.status(201).json({ success: true, data: course });
  }),
);

router.patch(
  '/:id',
  requireAdmin,
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const course = await Course.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!course) throw notFound('Course not found');
    res.json({ success: true, data: course });
  }),
);

/** Deactivated, not deleted — historical leads still point at it. */
router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const course = await Course.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!course) throw notFound('Course not found');
    res.json({ success: true, data: { message: 'Course deactivated', course } });
  }),
);

export default router;
