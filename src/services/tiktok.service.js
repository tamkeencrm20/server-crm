/**
 * TikTok Lead Generation intake.
 *
 * Shaped deliberately like meta.service.js so the three platforms stay
 * comparable, but the protocols genuinely differ:
 *
 *   - TikTok signs webhooks with HMAC-SHA256 over the raw body, the same as
 *     Meta, but sends the digest bare in `x-tt-signature` rather than prefixed
 *     with "sha256=".
 *   - The webhook payload already carries the answers for most form types, so
 *     unlike Meta there is often no second fetch. The Business API pull is kept
 *     as a fallback for payloads that only reference a lead id.
 *
 * Compliance: lead data handled here is used only to answer the enquiry the
 * person submitted on Tamkeen's own ad. See docs/META_COMPLIANCE.md — the same
 * commitments apply to every network.
 */
import crypto from 'node:crypto';
import env from '../config/env.js';
import logger from '../utils/logger.js';
import { AD_PLATFORM, LEAD_SOURCE } from '../config/constants.js';
import { extractLeadIdentity } from './leadFields.js';

const API = 'https://business-api.tiktok.com/open_api';

// ---------------------------------------------------------------------------
// Webhook security
// ---------------------------------------------------------------------------

/**
 * Verify the `x-tt-signature` header over the exact bytes TikTok sent.
 * @param {Buffer|string} rawBody
 * @param {string} signatureHeader
 */
export function verifySignature(rawBody, signatureHeader) {
  if (!env.TIKTOK_APP_SECRET) {
    logger.warn('TIKTOK_APP_SECRET is not set, rejecting webhook delivery');
    return false;
  }
  if (!signatureHeader) return false;

  // Accept a bare digest or a "sha256=" prefixed one; TikTok has shipped both.
  const received = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader;
  const expected = crypto.createHmac('sha256', env.TIKTOK_APP_SECRET).update(rawBody).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Answers TikTok's subscription handshake, which echoes a challenge like Meta's. */
export function verifySubscription({ token, challenge }) {
  if (token && token === env.TIKTOK_VERIFY_TOKEN) return challenge;
  return null;
}

// ---------------------------------------------------------------------------
// Business API
// ---------------------------------------------------------------------------

/**
 * Pull a lead's answers when the webhook carried only a reference.
 * @param {string} leadId
 * @returns {Promise<object|null>}
 */
export async function fetchLead(leadId) {
  if (!env.TIKTOK_ACCESS_TOKEN) {
    logger.warn('TIKTOK_ACCESS_TOKEN is not set, cannot fetch lead details');
    return null;
  }

  const url = `${API}/${env.TIKTOK_API_VERSION}/page/lead/get/?lead_id=${encodeURIComponent(leadId)}`;

  try {
    const res = await fetch(url, { headers: { 'Access-Token': env.TIKTOK_ACCESS_TOKEN } });
    const body = await res.json();

    // TikTok answers 200 with a non-zero `code` on failure rather than an HTTP error.
    if (!res.ok || body.code !== 0) {
      logger.error(`TikTok lead fetch failed for ${leadId}: ${body.message ?? res.status}`);
      return null;
    }
    return body.data ?? null;
  } catch (err) {
    logger.error(`TikTok lead fetch threw for ${leadId}`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Turn a TikTok lead record into the draft shape the Lead model expects.
 *
 * @param {object} lead      the lead object from the webhook or the API
 * @param {object} envelope  ids carried on the webhook wrapper
 * @returns {Promise<object>} draft lead payload
 */
export async function mapLeadToDraft(lead = {}, envelope = {}) {
  // TikTok has used several names for the answer list over the years.
  const answers = lead.field_data ?? lead.form_data ?? lead.answers ?? lead.fields ?? {};
  const identity = await extractLeadIdentity(answers);

  const leadId = String(lead.lead_id ?? lead.id ?? envelope.leadId ?? '');
  const createdRaw = lead.create_time ?? lead.created_time ?? envelope.createTime;

  return {
    fullName: identity.fullName,
    phone: identity.phone,
    email: identity.email,
    courseRaw: identity.courseRaw,
    branchRaw: identity.branchRaw,
    course: identity.course,
    branch: identity.branch,
    source: LEAD_SOURCE.TIKTOK,
    meta: {
      network: AD_PLATFORM.TIKTOK,
      // Namespaced so a TikTok id can never collide with a Meta one in the
      // unique index that guards against duplicate delivery.
      leadgenId: leadId ? `tiktok:${leadId}` : undefined,
      formId: lead.page_id ?? lead.form_id ?? envelope.pageId,
      formName: lead.page_name ?? lead.form_name,
      adId: lead.ad_id ?? envelope.adId,
      adName: lead.ad_name,
      campaignId: lead.campaign_id,
      campaignName: lead.campaign_name,
      adsetId: lead.adgroup_id,
      adsetName: lead.adgroup_name,
      createdTime: createdRaw ? new Date(Number.isFinite(Number(createdRaw)) ? Number(createdRaw) * 1000 : createdRaw) : new Date(),
      rawFields: identity.flat,
    },
  };
}

/** Everything the admin settings page needs to show about this integration. */
export function integrationStatus() {
  return {
    platform: AD_PLATFORM.TIKTOK,
    appSecretConfigured: Boolean(env.TIKTOK_APP_SECRET),
    verifyTokenConfigured: Boolean(env.TIKTOK_VERIFY_TOKEN),
    accessTokenConfigured: Boolean(env.TIKTOK_ACCESS_TOKEN),
    apiVersion: env.TIKTOK_API_VERSION,
    webhookPath: '/api/tiktok/webhook',
  };
}
