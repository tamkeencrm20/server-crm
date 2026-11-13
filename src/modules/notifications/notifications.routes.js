import { Router } from 'express';
import { z } from 'zod';
import Notification from '../../models/Notification.js';
import { authenticate } from '../../middleware/auth.js';
import { validate, q } from '../../middleware/validate.js';
import { asyncHandler, notFound } from '../../utils/errors.js';

const router = Router();
router.use(authenticate);

const listQuerySchema = z.object({
  unreadOnly: z.enum(['true', 'false']).default('false'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

router.get(
  '/',
  validate(listQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { unreadOnly, page, limit } = q(req);

    const filter = { user: req.user._id };
    if (unreadOnly === 'true') filter.readAt = null;

    const [items, total, unread] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      Notification.countDocuments(filter),
      Notification.countDocuments({ user: req.user._id, readAt: null }),
    ]);

    res.json({
      success: true,
      data: items,
      meta: { unread },
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  }),
);

router.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    const unread = await Notification.countDocuments({ user: req.user._id, readAt: null });
    res.json({ success: true, data: { unread } });
  }),
);

router.patch(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const doc = await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: { readAt: new Date() } },
      { new: true },
    );
    if (!doc) throw notFound('Notification not found');
    res.json({ success: true, data: doc });
  }),
);

router.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    const result = await Notification.updateMany(
      { user: req.user._id, readAt: null },
      { $set: { readAt: new Date() } },
    );
    res.json({ success: true, data: { updated: result.modifiedCount } });
  }),
);

export default router;
