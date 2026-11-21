import crypto from 'node:crypto';
import env from '../config/env.js';
import logger from '../utils/logger.js';
import Branch from '../models/Branch.js';
import Course from '../models/Course.js';
import { AD_PLATFORM, LEAD_SOURCE, META_AUTH_ERROR_CODE } from '../config/constants.js';
import { extractLeadIdentity, flattenAnswers, normalizeKey } from './leadFields.js';
export { resolveBranch, resolveCourse, flattenAnswers as flattenFieldData } from './leadFields.js';

/**
 * Everything that touches the Meta Lead Ads platform.
 *
 * Compliance: lead data pulled here is used only to answer the enquiry the
 * person submitted on Tamkeen's own ad. It is never forwarded to any third
 * party. See docs/META_COMPLIANCE.md.
 */

const GRAPH = 'https://graph.facebook.com';

// ---------------------------------------------------------------------------
// Webhook security
// ---------------------------------------------------------------------------

/**
 * Verifies the X-Hub-Signature-256 header Meta sends with every delivery.
 * Requires the RAW request body — see the rawBody capture in app.js.
 *
 * @param {Buffer|string} rawBody
 * @param {string} signatureHeader value of x-hub-signature-256
 * @returns {boolean}
 */
export function verifySignature(rawBody, signatureHeader) {
  if (!env.META_APP_SECRET) {
    logger.warn('META_APP_SECRET is not set, rejecting webhook delivery');
    return false;
  }
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const expected = crypto.createHmac('sha256', env.META_APP_SECRET).update(rawBody).digest('hex');
  const received = signatureHeader.slice('sha256='.length);

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  // timingSafeEqual throws on length mismatch, so guard first.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Answers Meta's GET verification handshake.
 * @returns {string|null} the challenge to echo back, or null to reject
 */
export function verifySubscription({ mode, token, challenge }) {
  if (mode === 'subscribe' && token && token === env.META_VERIFY_TOKEN) return challenge;
  return null;
}

// ---------------------------------------------------------------------------
// Graph API
// ---------------------------------------------------------------------------

/**
 * Fetch the full lead record from the Graph API. The webhook payload carries
 * only a leadgen_id; the answers themselves have to be pulled.
 *
 * @param {string} leadgenId
 * @returns {Promise<object|null>}
 */
/**
 * Raised when the Graph call does not produce a lead. It carries the reason
 * so the caller can record it and decide whether retrying could ever help —
 * the difference between "the token expired, fix it and replay" and "this id
 * does not exist, stop trying".
 */
export class GraphFetchError extends Error {
  constructor(message, { code, subcode, retryable = true } = {}) {
    super(message);
    this.name = 'GraphFetchError';
    this.code = code;
    this.subcode = subcode;
    this.retryable = retryable;
  }

  /** An expired, revoked or otherwise invalid access token. */
  get isAuthError() {
    return this.code === META_AUTH_ERROR_CODE;
  }
}

/**
 * The access token to use for a page.
 *
 * A page access token is scoped to its own page, so the Ajman token cannot
 * read a Dubai lead — it comes back as "Unsupported get request", which looks
 * like a missing lead rather than a wrong key. META_PAGE_TOKENS maps each
 * page to its own token; the single-token setting remains the fallback so
 * nothing breaks for a one-page account.
 *
 * @param {string} [pageId]
 * @returns {string|undefined}
 */
export function tokenForPage(pageId) {
  if (pageId && env.metaPageTokens[String(pageId)]) return env.metaPageTokens[String(pageId)];
  return env.META_PAGE_ACCESS_TOKEN || undefined;
}

/**
 * The branch code configured for a page, if any.
 * @param {string} [pageId]
 * @returns {string|undefined}
 */
export function branchCodeForPage(pageId) {
  if (!pageId) return undefined;
  return env.metaPageBranches[String(pageId)];
}

export async function fetchLeadFromGraph(leadgenId, { pageId } = {}) {
  const token = tokenForPage(pageId);
  if (!token) {
    throw new GraphFetchError(
      pageId
        ? `No access token configured for page ${pageId} (set META_PAGE_TOKENS or META_PAGE_ACCESS_TOKEN)`
        : 'META_PAGE_ACCESS_TOKEN is not set',
      { code: META_AUTH_ERROR_CODE },
    );
  }

  const fields = [
    'id',
    'created_time',
    'field_data',
    'form_id',
    'platform',
    'ad_id',
    'ad_name',
    'adset_id',
    'adset_name',
    'campaign_id',
    'campaign_name',
  ].join(',');

  const url = `${GRAPH}/${env.META_GRAPH_VERSION}/${leadgenId}?fields=${fields}&access_token=${encodeURIComponent(
    token,
  )}`;

  let res;
  let json;
  try {
    res = await fetch(url);
    json = await res.json();
  } catch (err) {
    // The network or Meta itself is unreachable: always worth another try.
    throw new GraphFetchError(`Graph API request failed: ${err.message}`, { retryable: true });
  }

  if (!res.ok) {
    const error = json?.error ?? {};
    logger.error(`Graph API rejected lead ${leadgenId}:`, error);
    throw new GraphFetchError(error.message ?? `Graph API returned ${res.status}`, {
      code: error.code,
      subcode: error.error_subcode,
      // 100 is "unknown path" — a lead id that does not exist for this token.
      // Retrying it forever would keep the failed queue permanently dirty.
      retryable: error.code !== 100,
    });
  }

  return json;
}

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

/**
 * Turn a Graph lead record plus its webhook envelope into the shape the Lead
 * model expects. Does not touch the database beyond the two lookups.
 *
 * @param {object} graphLead   response from fetchLeadFromGraph
 * @param {object} [envelope]  { pageId, formId, adId, ... } from the webhook
 * @returns {Promise<object>} draft lead payload
 */
export async function mapGraphLeadToDraft(graphLead, envelope = {}) {
  const identity = await extractLeadIdentity(graphLead.field_data);
  const { flat, answers, isTest, ...fields } = identity;

  const platform = (graphLead.platform ?? envelope.platform ?? '').toLowerCase();
  const source = platform.startsWith('ig') ? LEAD_SOURCE.META_INSTAGRAM : LEAD_SOURCE.META_FACEBOOK;

  return {
    ...fields,
    isTest,
    source,
    meta: {
      network: AD_PLATFORM.META,
      leadgenId: String(graphLead.id ?? envelope.leadgenId),
      formId: graphLead.form_id ?? envelope.formId,
      formName: envelope.formName,
      pageId: envelope.pageId,
      pageName: envelope.pageName,
      adId: graphLead.ad_id ?? envelope.adId,
      adName: graphLead.ad_name,
      campaignId: graphLead.campaign_id,
      campaignName: graphLead.campaign_name,
      adsetId: graphLead.adset_id,
      adsetName: graphLead.adset_name,
      platform: platform || undefined,
      createdTime: graphLead.created_time ? new Date(graphLead.created_time) : new Date(),
      rawFields: answers,
    },
  };
}

export const _testing = { normalizeKey };
