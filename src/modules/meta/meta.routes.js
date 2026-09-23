import { Router } from 'express';
import { z } from 'zod';
import env from '../../config/env.js';
import logger from '../../utils/logger.js';
import Lead from '../../models/Lead.js';
import Branch from '../../models/Branch.js';
import { authenticate, requireMediaBuyer } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { leadScopeFilter } from '../../middleware/scope.js';
import { asyncHandler, badRequest } from '../../utils/errors.js';
import {
  verifySignature,
  verifySubscription,
  fetchLeadFromGraph,
  mapGraphLeadToDraft,
  resolveBranch,
  resolveCourse,
} from '../../services/meta.service.js';
import { intakeLead } from '../../services/lead.service.js';

const router = Router();

// ---------------------------------------------------------------------------
// Webhook — called by Meta, never by the browser. No session auth here; the
// caller proves itself with the app-secret HMAC signature instead.
// ---------------------------------------------------------------------------

/** Meta's one-time subscription handshake. */
router.get('/webhook', (req, res) => {
  const challenge = verifySubscription({
    mode: req.query['hub.mode'],
    token: req.query['hub.verify_token'],
    challenge: req.query['hub.challenge'],
  });

  if (challenge === null) {
    logger.warn('Rejected Meta webhook verification: token mismatch');
    return res.sendStatus(403);
  }

  logger.info('Meta webhook verified');
  return res.status(200).send(challenge);
});

/**
 * Lead delivery.
 *
 * Meta expects a 200 within a few seconds and retries anything else, so the
 * response is sent immediately and the leads are processed afterwards. The
 * leadgen_id unique index makes those retries harmless.
 */
router.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    if (!verifySignature(req.rawBody ?? Buffer.from(''), req.get('x-hub-signature-256'))) {
      logger.warn('Rejected Meta webhook delivery: bad signature');
      return res.sendStatus(401);
    }

    res.sendStatus(200);

    const body = req.body ?? {};
    if (body.object !== 'page') return;

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'leadgen') continue;
        // Deliberately not awaited: the response is already out.
        processLeadgen(change.value, entry).catch((err) =>
          logger.error('Failed to process Meta leadgen event', err),
        );
      }
    }
  }),
);

/** Pull the lead from the Graph API, map it, and run it through intake. */
async function processLeadgen(value = {}, entry = {}) {
  const leadgenId = value.leadgen_id;
  if (!leadgenId) return;

  logger.info(`Meta leadgen received: ${leadgenId}`);

  const graphLead = await fetchLeadFromGraph(leadgenId);
  if (!graphLead) {
    logger.error(`Could not fetch lead ${leadgenId} from the Graph API, dropping the event`);
    return;
  }

  const draft = await mapGraphLeadToDraft(graphLead, {
    leadgenId,
    formId: value.form_id,
    pageId: value.page_id ?? entry.id,
    adId: value.ad_id,
  });

  // A form that does not ask which branch still has to reach someone: fall
  // back to the single active branch when there is exactly one.
  if (!draft.branch) {
    const active = await Branch.find({ isActive: true }).select('_id').limit(2).lean();
    if (active.length === 1) draft.branch = active[0]._id;
  }

  const { lead, duplicate, assignment } = await intakeLead(draft, { autoAssign: true });
  logger.info(
    `Meta lead ${leadgenId} -> ${duplicate ? 'duplicate of' : 'created as'} ${lead._id}` +
      (assignment?.assigned ? `, assigned to ${assignment.agent.name}` : ', unassigned'),
  );
}

// ---------------------------------------------------------------------------
// Admin-facing helpers
// ---------------------------------------------------------------------------

router.use(authenticate);

/** Is the Meta integration actually wired up? Shown on the settings screen. */
router.get(
  '/status',
  requireMediaBuyer,
  asyncHandler(async (req, res) => {
    // Scoped like every other list, so a branch's media buyer sees that
    // branch's traffic rather than the whole company's.
    const filter = { 'meta.network': 'meta', ...leadScopeFilter(req.user) };
    const [totalFromMeta, last] = await Promise.all([
      Lead.countDocuments(filter),
      Lead.findOne(filter).sort({ createdAt: -1 }).select('createdAt meta.formName'),
    ]);

    res.json({
      success: true,
      data: {
        appSecretConfigured: Boolean(env.META_APP_SECRET),
        verifyTokenConfigured: Boolean(env.META_VERIFY_TOKEN),
        pageAccessTokenConfigured: Boolean(env.META_PAGE_ACCESS_TOKEN),
        graphVersion: env.META_GRAPH_VERSION,
        webhookPath: '/api/meta/webhook',
        totalLeadsFromMeta: totalFromMeta,
        lastLeadAt: last?.createdAt ?? null,
      },
    });
  }),
);

/**
 * Replay a lead by its Meta id — the recovery path when the Graph fetch failed
 * or the webhook was down.
 */
router.post(
  '/leads/:leadgenId/sync',
  requireMediaBuyer,
  asyncHandler(async (req, res) => {
    const graphLead = await fetchLeadFromGraph(req.params.leadgenId);
    if (!graphLead) throw badRequest('Could not fetch that lead from Meta, check the page access token');

    const draft = await mapGraphLeadToDraft(graphLead, { leadgenId: req.params.leadgenId });
    const result = await intakeLead(draft, { autoAssign: true });

    res.json({ success: true, data: { leadId: result.lead._id, duplicate: result.duplicate } });
  }),
);

/**
 * Feed the pipeline a synthetic lead in exactly the shape a Meta form sends.
 * Lets the whole automation chain be tested before the Business account is
 * connected. Admin only, and refused in production.
 */
const simulateSchema = z.object({
  fullName: z.string().trim().min(2),
  phone: z.string().trim().min(6),
  email: z.string().email().optional(),
  course: z.string().trim().optional(),
  branch: z.string().trim().optional(),
  platform: z.enum(['fb', 'ig']).default('fb'),
});

router.post(
  '/simulate-lead',
  requireMediaBuyer,
  validate(simulateSchema),
  asyncHandler(async (req, res) => {
    if (env.isProd) throw badRequest('Lead simulation is disabled in production');

    const [branch, course] = await Promise.all([
      resolveBranch(req.body.branch),
      resolveCourse(req.body.course),
    ]);

    const result = await intakeLead(
      {
        fullName: req.body.fullName,
        phone: req.body.phone,
        email: req.body.email,
        courseRaw: req.body.course,
        branchRaw: req.body.branch,
        course: course?._id,
        branch: branch?._id,
        source: req.body.platform === 'ig' ? 'meta_instagram' : 'meta_facebook',
        meta: {
          network: 'meta',
          leadgenId: `meta:sim_${Date.now()}`,
          formName: 'Simulated form',
          platform: req.body.platform,
          createdTime: new Date(),
        },
      },
      { autoAssign: true },
    );

    res.status(201).json({
      success: true,
      data: {
        leadId: result.lead._id,
        duplicate: result.duplicate,
        assignedTo: result.assignment?.agent?.name ?? null,
        reason: result.assignment?.reason ?? null,
      },
    });
  }),
);

export default router;
