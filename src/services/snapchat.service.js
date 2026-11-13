/**
 * Snapchat Lead Generation intake.
 *
 * Same job as the Meta and TikTok services, with Snapchat's own quirks:
 *
 *   - Webhooks are signed HMAC-SHA256 over the raw body and delivered in
 *     `x-snap-signature`, usually prefixed with "sha256=".
 *   - The Marketing API returns a form submission as `{ data: [{ lead: {...} }] }`,
 *     one level deeper than the other two.
 *   - Answers arrive as a flat question/answer object rather than a list.
 *
 * Compliance: identical to the other networks — the data answers the enquiry
 * the person submitted, and goes nowhere else. See docs/META_COMPLIANCE.md.
 */
import crypto from 'node:crypto';
import env from '../config/env.js';
import logger from '../utils/logger.js';
import { AD_PLATFORM, LEAD_SOURCE } from '../config/constants.js';
import { extractLeadIdentity } from './leadFields.js';

const API = 'https://adsapi.snapchat.com';

// ---------------------------------------------------------------------------
// Webhook security
// ---------------------------------------------------------------------------

/**
 * Verify the `x-snap-signature` header over the exact bytes Snapchat sent.
 * @param {Buffer|string} rawBody
 * @param {string} signatureHeader
 */
export function verifySignature(rawBody, signatureHeader) {
  if (!env.SNAPCHAT_APP_SECRET) {
    logger.warn('SNAPCHAT_APP_SECRET is not set, rejecting webhook delivery');
    return false;
  }
  if (!signatureHeader) return false;

  const received = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader;
  const expected = crypto.createHmac('sha256', env.SNAPCHAT_APP_SECRET).update(rawBody).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Answers Snapchat's subscription handshake. */
export function verifySubscription({ token, challenge }) {
  if (token && token === env.SNAPCHAT_VERIFY_TOKEN) return challenge;
  return null;
}

// ---------------------------------------------------------------------------
// Marketing API
// ---------------------------------------------------------------------------

/**
 * Pull a lead's answers from the Marketing API.
 * @param {string} leadId
 * @returns {Promise<object|null>}
 */
export async function fetchLead(leadId) {
  if (!env.SNAPCHAT_ACCESS_TOKEN) {
    logger.warn('SNAPCHAT_ACCESS_TOKEN is not set, cannot fetch lead details');
    return null;
  }

  const url = `${API}/${env.SNAPCHAT_API_VERSION}/leads/${encodeURIComponent(leadId)}`;

  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${env.SNAPCHAT_ACCESS_TOKEN}` } });
    const body = await res.json();

    if (!res.ok) {
      logger.error(`Snapchat lead fetch failed for ${leadId}: ${body.message ?? res.status}`);
      return null;
    }
    // Unwrap the { data: [{ lead }] } envelope the API returns.
    return body.data?.[0]?.lead ?? body.lead ?? body ?? null;
  } catch (err) {
    logger.error(`Snapchat lead fetch threw for ${leadId}`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Turn a Snapchat lead record into the draft shape the Lead model expects.
 *
 * @param {object} lead      the lead object from the webhook or the API
 * @param {object} envelope  ids carried on the webhook wrapper
 * @returns {Promise<object>} draft lead payload
 */
export async function mapLeadToDraft(lead = {}, envelope = {}) {
  const answers = lead.form_response ?? lead.field_data ?? lead.answers ?? lead.user_data ?? {};
  const identity = await extractLeadIdentity(answers);

  const leadId = String(lead.id ?? lead.lead_id ?? envelope.leadId ?? '');
  const createdRaw = lead.created_at ?? lead.create_time ?? envelope.createdAt;

  return {
    fullName: identity.fullName,
    phone: identity.phone,
    email: identity.email,
    courseRaw: identity.courseRaw,
    branchRaw: identity.branchRaw,
    course: identity.course,
    branch: identity.branch,
    source: LEAD_SOURCE.SNAPCHAT,
    meta: {
      network: AD_PLATFORM.SNAPCHAT,
      leadgenId: leadId ? `snapchat:${leadId}` : undefined,
      formId: lead.lead_form_id ?? envelope.formId,
      formName: lead.lead_form_name,
      adId: lead.ad_id ?? envelope.adId,
      adName: lead.ad_name,
      campaignId: lead.campaign_id,
      campaignName: lead.campaign_name,
      adsetId: lead.ad_squad_id,
      adsetName: lead.ad_squad_name,
      createdTime: createdRaw ? new Date(createdRaw) : new Date(),
      rawFields: identity.flat,
    },
  };
}

/** Everything the admin settings page needs to show about this integration. */
export function integrationStatus() {
  return {
    platform: AD_PLATFORM.SNAPCHAT,
    appSecretConfigured: Boolean(env.SNAPCHAT_APP_SECRET),
    verifyTokenConfigured: Boolean(env.SNAPCHAT_VERIFY_TOKEN),
    accessTokenConfigured: Boolean(env.SNAPCHAT_ACCESS_TOKEN),
    apiVersion: env.SNAPCHAT_API_VERSION,
    webhookPath: '/api/snapchat/webhook',
  };
}
