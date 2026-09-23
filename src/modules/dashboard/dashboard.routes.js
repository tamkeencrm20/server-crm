import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireBranchInsight } from '../../middleware/auth.js';
import { validate, q } from '../../middleware/validate.js';
import { leadScopeFilter } from '../../middleware/scope.js';
import { ROLES } from '../../config/constants.js';
import { asyncHandler, forbidden } from '../../utils/errors.js';
import * as dash from './dashboard.service.js';

const router = Router();
router.use(authenticate);

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

const rangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  branch: objectId.optional(),
});

/**
 * Build the Lead filter this user is allowed to aggregate over. An admin may
 * additionally narrow to one branch; nobody else can widen past their own.
 */
function scopeFor(user, requestedBranch) {
  const scope = leadScopeFilter(user);
  if (requestedBranch) {
    if (user.role !== ROLES.ADMIN) throw forbidden('You can only view your own branch');
    scope.branch = requestedBranch;
  }
  return scope;
}

router.get(
  '/overview',
  validate(rangeSchema, 'query'),
  asyncHandler(async (req, res) => {
    const p = q(req);
    const range = dash.resolveRange(p);
    const scope = scopeFor(req.user, p.branch);

    const [overview, trend] = await Promise.all([
      dash.getOverview(scope, range),
      dash.getDailyTrend(scope, range),
    ]);

    res.json({
      success: true,
      data: { range: { from: range.start, to: range.end, days: range.days }, overview, trend },
    });
  }),
);

/** Agent leaderboard — a leader sees their branch, an admin sees everyone. */
router.get(
  '/agents',
  requireBranchInsight,
  validate(rangeSchema, 'query'),
  asyncHandler(async (req, res) => {
    const p = q(req);
    const range = dash.resolveRange(p);
    const rows = await dash.getAgentPerformance(scopeFor(req.user, p.branch), range);
    res.json({ success: true, data: rows });
  }),
);

/** Branch comparison — admin only, since it spans branches by definition. */
router.get(
  '/branches',
  validate(rangeSchema, 'query'),
  asyncHandler(async (req, res) => {
    if (req.user.role !== ROLES.ADMIN) throw forbidden('Branch comparison is available to admins only');
    const p = q(req);
    const rows = await dash.getBranchPerformance({}, dash.resolveRange(p));
    res.json({ success: true, data: rows });
  }),
);

router.get(
  '/sources',
  requireBranchInsight,
  validate(rangeSchema, 'query'),
  asyncHandler(async (req, res) => {
    const p = q(req);
    const data = await dash.getSourceBreakdown(scopeFor(req.user, p.branch), dash.resolveRange(p));
    res.json({ success: true, data });
  }),
);

router.get(
  '/team-status',
  requireBranchInsight,
  asyncHandler(async (req, res) => {
    const branchFilter =
      req.user.role === ROLES.ADMIN ? {} : { branch: req.user.branch?._id ?? req.user.branch };
    const data = await dash.getTeamStatus(branchFilter);
    res.json({ success: true, data });
  }),
);

export default router;
