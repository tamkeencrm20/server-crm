/**
 * One router shape, three ad networks.
 *
 * Meta, TikTok and Snapchat differ in how they sign a webhook, how they answer
 * the subscription handshake, and whether the delivery carries the answers or
 * only a lead id. Everything after that — dedupe, branch fallback, round-robin
 * distribution, the audit row, the agent's notification — is identical, and
 * lives in intakeLead. This factory holds the identical part so a fourth
 * network is a service file plus three lines of wiring.
 */
import { Router } from 'express';
import { z } from 'zod';
import env from '../../config/env.js';
import logger from '../../utils/logger.js';
import Lead from '../../models/Lead.js';
import Branch from '../../models/Branch.js';
import { authenticate, requireMediaBuyer } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler, badRequest } from '../../utils/errors.js';
import { intakeLead } from '../../services/lead.service.js';
import { leadScopeFilter } from '../../middleware/scope.js';
import { resolveBranch, resolveCourse } from '../../services/leadFields.js';
import { PLATFORM_SOURCE } from '../../config/constants.js';

/**
 * @param {object}   config
 * @param {string}   config.platform        one of AD_PLATFORM
 * @param {string}   config.signatureHeader header carrying the HMAC digest
 * @param {object}   config.service         the platform service module
 * @param {Function} config.extractDeliveries  (body) => [{ leadId, inlineLead, envelope }]
 */
export function createPlatformRouter({ platform, signatureHeader, service, extractDeliveries }) {
  const router = Router();
  const label = platform[0].toUpperCase() + platform.slice(1);

  // -------------------------------------------------------------------------
  // Webhook — called by the network, never by the browser. No session auth;
  // the caller proves itself with the app-secret HMAC instead.
  // -------------------------------------------------------------------------

  router.get('/webhook', (req, res) => {
    const challenge = service.verifySubscription({
      token: req.query['hub.verify_token'] ?? req.query.verify_token ?? req.query.token,
      challenge: req.query['hub.challenge'] ?? req.query.challenge ?? 'ok',
    });

    if (challenge === null) {
      logger.warn(`Rejected ${label} webhook verification: token mismatch`);
      return res.sendStatus(403);
    }

    logger.info(`${label} webhook verified`);
    return res.status(200).send(challenge);
  });

  /**
   * Lead delivery. The network expects a fast 200 and retries anything else,
   * so the response goes out before any work starts. The unique lead-id index
   * is what makes those retries harmless.
   */
  router.post(
    '/webhook',
    asyncHandler(async (req, res) => {
      if (!service.verifySignature(req.rawBody ?? Buffer.from(''), req.get(signatureHeader))) {
        logger.warn(`Rejected ${label} webhook delivery: bad signature`);
        return res.sendStatus(401);
      }

      res.sendStatus(200);

      let deliveries = [];
      try {
        deliveries = extractDeliveries(req.body ?? {}) ?? [];
      } catch (err) {
        logger.error(`Could not read the ${label} webhook payload`, err);
        return;
      }

      for (const delivery of deliveries) {
        // Deliberately not awaited: the response is already out.
        processDelivery(delivery).catch((err) =>
          logger.error(`Failed to process ${label} lead event`, err),
        );
      }
    }),
  );

  /** Map one delivery and push it through the shared intake pipeline. */
  async function processDelivery({ leadId, inlineLead, envelope = {} }) {
    // Some networks put the answers straight in the webhook; others send only
    // a reference and expect a pull. Prefer what we already have.
    let raw = inlineLead;
    if (!raw || !hasAnswers(raw)) {
      if (!leadId) return;
      raw = await service.fetchLead(leadId);
    }

    if (!raw) {
      logger.error(`Could not obtain ${label} lead ${leadId}, dropping the event`);
      return;
    }

    const draft = await service.mapLeadToDraft(raw, { ...envelope, leadId });
    await finishIntake(draft, `${label} lead ${leadId}`);
  }

  // -------------------------------------------------------------------------
  // Operator-facing: the media buyer's own domain, plus admins.
  // -------------------------------------------------------------------------

  router.use(authenticate);

  router.get(
    '/status',
    requireMediaBuyer,
    asyncHandler(async (req, res) => {
      // Scoped like every other list: a branch's media buyer counts that
      // branch's traffic, not the whole company's.
      const filter = { 'meta.network': platform, ...leadScopeFilter(req.user) };
      const [total, last] = await Promise.all([
        Lead.countDocuments(filter),
        Lead.findOne(filter).sort({ createdAt: -1 }).select('createdAt meta.formName meta.campaignName'),
      ]);

      res.json({
        success: true,
        data: {
          ...service.integrationStatus(),
          totalLeads: total,
          lastLeadAt: last?.createdAt ?? null,
          lastCampaign: last?.meta?.campaignName ?? null,
        },
      });
    }),
  );

  /** Replay one lead by id — the recovery path when a delivery was missed. */
  router.post(
    '/leads/:leadId/sync',
    requireMediaBuyer,
    asyncHandler(async (req, res) => {
      const raw = await service.fetchLead(req.params.leadId);
      if (!raw) throw badRequest(`Could not fetch that lead from ${label}, check the access token`);

      const draft = await service.mapLeadToDraft(raw, { leadId: req.params.leadId });
      const result = await finishIntake(draft, `${label} replay ${req.params.leadId}`);

      res.json({ success: true, data: { leadId: result.lead._id, duplicate: result.duplicate } });
    }),
  );

  /**
   * Feed the pipeline a synthetic lead in the shape this network sends, so the
   * whole chain can be exercised before the ad account is connected.
   */
  const simulateSchema = z.object({
    fullName: z.string().trim().min(2),
    phone: z.string().trim().min(6),
    email: z.string().email().optional(),
    course: z.string().trim().optional(),
    branch: z.string().trim().optional(),
    campaignName: z.string().trim().optional(),
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

      const result = await finishIntake(
        {
          fullName: req.body.fullName,
          phone: req.body.phone,
          email: req.body.email,
          courseRaw: req.body.course,
          branchRaw: req.body.branch,
          course: course?._id,
          branch: branch?._id,
          source: PLATFORM_SOURCE[platform],
          meta: {
            network: platform,
            leadgenId: `${platform}:sim_${Date.now()}`,
            formName: 'Simulated form',
            campaignName: req.body.campaignName || 'Simulated campaign',
            createdTime: new Date(),
          },
        },
        `${label} simulation`,
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

  return router;
}

/** Did this payload actually carry the form answers, or only a reference? */
function hasAnswers(raw) {
  const answers = raw.field_data ?? raw.form_data ?? raw.answers ?? raw.fields ?? raw.form_response ?? raw.user_data;
  if (!answers) return false;
  return Array.isArray(answers) ? answers.length > 0 : Object.keys(answers).length > 0;
}

/**
 * The last two steps every network shares: fall back to the only branch when
 * the form did not ask, then run the shared intake.
 */
async function finishIntake(draft, label) {
  if (!draft.branch) {
    const active = await Branch.find({ isActive: true }).select('_id').limit(2).lean();
    if (active.length === 1) draft.branch = active[0]._id;
  }

  const result = await intakeLead(draft, { autoAssign: true });
  logger.info(
    `${label} -> ${result.duplicate ? 'duplicate of' : 'created as'} ${result.lead._id}` +
      (result.assignment?.assigned ? `, assigned to ${result.assignment.agent.name}` : ', unassigned'),
  );
  return result;
}
