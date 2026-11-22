import { Router } from 'express';
import { z } from 'zod';
import env from '../../config/env.js';
import logger from '../../utils/logger.js';
import Lead from '../../models/Lead.js';
import Branch from '../../models/Branch.js';
import MetaLeadEvent from '../../models/MetaLeadEvent.js';
import {
  AD_PLATFORM,
  LEAD_DATA_ISSUE,
  WEBHOOK_EVENT_STATUS,
  WEBHOOK_EVENT_STATUS_VALUES,
  WEBHOOK_MAX_ATTEMPTS,
  META_AUTH_ERROR_CODE,
} from '../../config/constants.js';
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
  branchCodeForPage,
  tokenForPage,
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

/**
 * Record the delivery, then try to turn it into a lead.
 *
 * The event row is written before anything that can fail. Meta has already
 * been answered 200 by this point and will never resend, so an id that is not
 * written down here is a customer nobody will ever call.
 */
async function processLeadgen(value = {}, entry = {}) {
  const leadgenId = value.leadgen_id;
  if (!leadgenId) return;

  const pageId = String(value.page_id ?? entry.id ?? '') || undefined;
  logger.info(`Meta leadgen received: ${leadgenId}${pageId ? ` (page ${pageId})` : ''}`);

  const event = await MetaLeadEvent.findOneAndUpdate(
    { leadgenId: String(leadgenId) },
    {
      $set: { pageId, formId: value.form_id, adId: value.ad_id, payload: value },
      $setOnInsert: { network: AD_PLATFORM.META, status: WEBHOOK_EVENT_STATUS.RECEIVED },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  if (event.status === WEBHOOK_EVENT_STATUS.PROCESSED) {
    logger.info(`Meta lead ${leadgenId} was already processed, ignoring the repeat delivery`);
    return;
  }

  await ingestEvent(event);
}

/**
 * Fetch, map and store one recorded event. Used by the webhook and by every
 * recovery path, so they cannot drift apart.
 *
 * @param {object} event             a MetaLeadEvent document
 * @param {object} [options]
 * @param {Array}  [options.fieldData]  answers supplied by hand, skipping the
 *                                      Graph call — the way an admin rescues
 *                                      a lead whose fetch can no longer work
 * @returns {Promise<object>} { status, leadId?, error? }
 */
export async function ingestEvent(event, { fieldData } = {}) {
  const leadgenId = event.leadgenId;
  const payload = event.payload ?? {};

  event.attempts += 1;
  event.lastAttemptAt = new Date();

  let graphLead;
  if (fieldData) {
    graphLead = { id: leadgenId, field_data: fieldData, created_time: new Date().toISOString() };
  } else if (!env.isProd && Array.isArray(payload.field_data)) {
    // Outside production a delivery may carry the answers inline. Meta never
    // does this, but it lets the whole intake path — mapping, branch
    // fallback, dedupe, distribution — be tested against real payloads
    // without a live Graph token.
    graphLead = { id: leadgenId, field_data: payload.field_data, created_time: payload.created_time };
  } else {
    try {
      graphLead = await fetchLeadFromGraph(leadgenId, { pageId: event.pageId });
    } catch (err) {
      event.status = WEBHOOK_EVENT_STATUS.FAILED;
      event.lastError = err.message;
      event.lastErrorCode = err.code;
      await event.save();
      logger.error(
        `Could not fetch Meta lead ${leadgenId}: ${err.message}. ` +
          'The event is stored as failed and can be retried.',
      );
      return { status: WEBHOOK_EVENT_STATUS.FAILED, error: err.message };
    }
  }

  try {
    const draft = await mapGraphLeadToDraft(graphLead, {
      leadgenId,
      formId: payload.form_id ?? event.formId,
      pageId: event.pageId,
      adId: payload.ad_id ?? event.adId,
    });

    draft.branch = await resolveLeadBranch(draft, event.pageId);

    // No usable number: store the lead rather than lose it, flagged so it
    // shows up for a human instead of going quietly to an agent.
    if (!draft.phone) {
      draft.dataIssue = LEAD_DATA_ISSUE.PHONE_MISSING;
    }

    const { lead, duplicate, assignment } = await intakeLead(draft, { autoAssign: true });

    event.status = WEBHOOK_EVENT_STATUS.PROCESSED;
    event.processedAt = new Date();
    event.lead = lead._id;
    event.fieldData = graphLead.field_data;
    event.lastError = undefined;
    event.lastErrorCode = undefined;
    await event.save();

    logger.info(
      `Meta lead ${leadgenId} -> ${duplicate ? 'duplicate of' : 'created as'} ${lead._id}` +
        (draft.isTest ? ' [test lead]' : '') +
        (draft.dataIssue ? ` [${draft.dataIssue}]` : '') +
        (assignment?.assigned ? `, assigned to ${assignment.agent.name}` : ', unassigned'),
    );

    return { status: WEBHOOK_EVENT_STATUS.PROCESSED, leadId: String(lead._id), duplicate };
  } catch (err) {
    event.status = WEBHOOK_EVENT_STATUS.FAILED;
    event.lastError = err.message;
    event.fieldData = graphLead?.field_data;
    await event.save();
    logger.error(`Could not store Meta lead ${leadgenId}`, err);
    return { status: WEBHOOK_EVENT_STATUS.FAILED, error: err.message };
  }
}

/**
 * Decide which branch a lead belongs to.
 *
 * The answer on the form wins when there is one, because the person said it
 * themselves. Otherwise the Facebook page decides: each page belongs to one
 * branch, and the new Ajman form does not ask about branches at all — it asks
 * which country the person is in, which is a different question and must
 * never be read as one. Falling back to the only active branch keeps a
 * single-branch setup working with no configuration.
 *
 * @param {object} draft
 * @param {string} [pageId]
 * @returns {Promise<mongoose.Types.ObjectId|undefined>}
 */
async function resolveLeadBranch(draft, pageId) {
  if (draft.branch) return draft.branch;

  const label = branchCodeForPage(pageId);
  if (label) {
    // Matched the same way a form answer is: by code, by name or by city, in
    // either language. Whoever fills in META_PAGE_BRANCHES is reading a page
    // name off Facebook and writing the branch they mean — "عجمان" and
    // "ajman" are the same answer, and demanding the internal code would turn
    // a reasonable entry into leads that silently arrive with no branch.
    const branch = await resolveBranch(label);
    if (branch) return branch._id;
    logger.warn(
      `META_PAGE_BRANCHES maps page ${pageId} to "${label}", which matches no active branch`,
    );
  }

  const active = await Branch.find({ isActive: true }).select('_id').limit(2).lean();
  if (active.length === 1) return active[0]._id;

  logger.warn(
    `Lead from page ${pageId ?? 'unknown'} has no branch: the form did not ask, and the page is ` +
      'not listed in META_PAGE_BRANCHES. It will wait in the unassigned queue.',
  );
  return undefined;
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

    // Anything that arrived but never became a lead. The count alone is the
    // alert: a healthy integration keeps it at zero.
    const [failedCount, authFailure, pendingPhoneFix] = await Promise.all([
      MetaLeadEvent.countDocuments({ status: WEBHOOK_EVENT_STATUS.FAILED }),
      MetaLeadEvent.findOne({
        status: WEBHOOK_EVENT_STATUS.FAILED,
        lastErrorCode: META_AUTH_ERROR_CODE,
      })
        .sort({ lastAttemptAt: -1 })
        .select('lastError lastAttemptAt pageId')
        .lean(),
      Lead.countDocuments({ dataIssue: LEAD_DATA_ISSUE.PHONE_MISSING, ...leadScopeFilter(req.user) }),
    ]);

    const pages = Object.keys({ ...env.metaPageBranches, ...env.metaPageTokens });

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

        /** Per-page wiring, so a half-configured second branch is visible. */
        pages: pages.map((pageId) => ({
          pageId,
          branchCode: branchCodeForPage(pageId) ?? null,
          tokenConfigured: Boolean(tokenForPage(pageId)),
        })),

        failedEvents: failedCount,
        leadsMissingPhone: pendingPhoneFix,

        /**
         * Set when a fetch failed because the token is expired or revoked.
         * This is the failure that silently stops every lead, so it is
         * reported as its own flag rather than buried in a count.
         */
        tokenExpired: Boolean(authFailure),
        tokenError: authFailure
          ? { message: authFailure.lastError, at: authFailure.lastAttemptAt, pageId: authFailure.pageId ?? null }
          : null,
      },
    });
  }),
);

/** The delivery log — what arrived, and what became of it. */
router.get(
  '/events',
  requireMediaBuyer,
  asyncHandler(async (req, res) => {
    const { status, limit = 50 } = req.query;
    const filter = {};
    if (status && WEBHOOK_EVENT_STATUS_VALUES.includes(status)) filter.status = status;

    const events = await MetaLeadEvent.find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 50, 200))
      .select('leadgenId pageId status attempts lastError lastErrorCode lead createdAt processedAt')
      .lean();

    res.json({ success: true, data: events });
  }),
);

/**
 * Retry one failed delivery. With `fieldData` in the body the Graph call is
 * skipped and those answers are used — the way a lead is rescued when the
 * fetch can no longer succeed but the answers are still readable in Meta's
 * own dashboard.
 */
router.post(
  '/events/:leadgenId/retry',
  requireMediaBuyer,
  asyncHandler(async (req, res) => {
    const event = await MetaLeadEvent.findOne({ leadgenId: String(req.params.leadgenId) });
    if (!event) throw badRequest('No delivery was recorded with that id');

    const result = await ingestEvent(event, { fieldData: req.body?.fieldData });
    res.json({ success: result.status === WEBHOOK_EVENT_STATUS.PROCESSED, data: result });
  }),
);

/** Retry every failed delivery — the button to press after fixing a token. */
router.post(
  '/events/retry-failed',
  requireMediaBuyer,
  asyncHandler(async (req, res) => {
    const result = await retryFailedEvents();
    res.json({ success: true, data: result });
  }),
);

/**
 * Re-attempt the failed deliveries, oldest first.
 *
 * Exported for the scheduled job as well as the endpoint. Events that have
 * already been tried WEBHOOK_MAX_ATTEMPTS times are left alone so a
 * permanently broken id cannot keep the sweep busy forever; the admin
 * endpoint can still force one by id.
 */
export async function retryFailedEvents(limit = 50) {
  const events = await MetaLeadEvent.find({
    status: WEBHOOK_EVENT_STATUS.FAILED,
    attempts: { $lt: WEBHOOK_MAX_ATTEMPTS },
  })
    .sort({ createdAt: 1 })
    .limit(limit);

  const result = { total: events.length, recovered: 0, stillFailing: 0 };
  for (const event of events) {
    // Sequential: a burst of Graph calls after an outage is what got the
    // token rate-limited in the first place.
    // eslint-disable-next-line no-await-in-loop
    const outcome = await ingestEvent(event);
    if (outcome.status === WEBHOOK_EVENT_STATUS.PROCESSED) result.recovered += 1;
    else result.stillFailing += 1;
  }
  if (result.recovered > 0) logger.info(`Recovered ${result.recovered} Meta lead(s) on retry`);
  return result;
}

/**
 * Replay a lead by its Meta id — the recovery path when the Graph fetch failed
 * or the webhook was down.
 */
router.post(
  '/leads/:leadgenId/sync',
  requireMediaBuyer,
  asyncHandler(async (req, res) => {
    const leadgenId = String(req.params.leadgenId);
    const pageId = req.query.pageId ? String(req.query.pageId) : undefined;

    // Route it through the event log like every other delivery, so a lead
    // pulled in by hand is recorded and recoverable in exactly the same way.
    const event = await MetaLeadEvent.findOneAndUpdate(
      { leadgenId },
      {
        $setOnInsert: {
          network: AD_PLATFORM.META,
          status: WEBHOOK_EVENT_STATUS.RECEIVED,
          payload: { leadgen_id: leadgenId, page_id: pageId, source: 'manual-sync' },
        },
        ...(pageId ? { $set: { pageId } } : {}),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    const result = await ingestEvent(event, { fieldData: req.body?.fieldData });
    if (result.status !== WEBHOOK_EVENT_STATUS.PROCESSED) {
      throw badRequest(result.error ?? 'Could not fetch that lead from Meta, check the page access token');
    }

    res.json({ success: true, data: { leadId: result.leadId, duplicate: result.duplicate } });
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
