import crypto from 'node:crypto';
import env from '../config/env.js';
import logger from '../utils/logger.js';
import Branch from '../models/Branch.js';
import Course from '../models/Course.js';
import { AD_PLATFORM, LEAD_SOURCE } from '../config/constants.js';

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
export async function fetchLeadFromGraph(leadgenId) {
  if (!env.META_PAGE_ACCESS_TOKEN) {
    logger.warn('META_PAGE_ACCESS_TOKEN is not set, cannot fetch lead details');
    return null;
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
    env.META_PAGE_ACCESS_TOKEN,
  )}`;

  try {
    const res = await fetch(url);
    const json = await res.json();
    if (!res.ok) {
      logger.error(`Graph API rejected lead ${leadgenId}:`, json?.error ?? json);
      return null;
    }
    return json;
  } catch (err) {
    logger.error(`Graph API request failed for lead ${leadgenId}`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

/**
 * Meta form field names vary per campaign and per language. These lists let
 * the same code read forms written in Arabic or English without a per-form
 * configuration step. Matching is substring-based and case-insensitive.
 */
const FIELD_ALIASES = {
  fullName: ['full_name', 'name', 'الاسم', 'اسم', 'first_name'],
  email: ['email', 'بريد', 'ايميل', 'الايميل'],
  phone: ['phone_number', 'phone', 'mobile', 'whatsapp', 'هاتف', 'جوال', 'رقم', 'موبايل'],
  course: ['course', 'program', 'training', 'دورة', 'الدورة', 'برنامج', 'تدريب', 'التخصص'],
  branch: ['branch', 'city', 'location', 'emirate', 'فرع', 'الفرع', 'مدينة', 'المدينة', 'امارة'],
  company: ['company', 'organization', 'جهة', 'شركة'],
};

/** Turn Meta's field_data array into a flat { key: value } map. */
export function flattenFieldData(fieldData = []) {
  const flat = {};
  for (const field of fieldData) {
    const key = String(field.name ?? '').toLowerCase();
    const value = Array.isArray(field.values) ? field.values.join(', ') : String(field.values ?? '');
    if (key) flat[key] = value;
  }
  return flat;
}

/** Read one logical field out of the flat map using the alias list. */
function readField(flat, aliases) {
  for (const alias of aliases) {
    // Exact match first, so "name" does not lose to "company_name".
    if (flat[alias]) return flat[alias];
  }
  for (const alias of aliases) {
    const hit = Object.keys(flat).find((k) => k.includes(alias));
    if (hit && flat[hit]) return flat[hit];
  }
  return '';
}

/**
 * Best-effort match of a free-text branch answer to a Branch document.
 * Falls back to null, which parks the lead in the unassigned queue rather than
 * guessing wrong and sending it to the wrong city.
 */
export async function resolveBranch(rawBranch) {
  if (!rawBranch) return null;
  const needle = String(rawBranch).trim().toLowerCase();
  if (!needle) return null;

  const branches = await Branch.find({ isActive: true }).select('code name city').lean();
  return (
    branches.find((b) =>
      [b.code, b.name?.ar, b.name?.en, b.city?.ar, b.city?.en]
        .filter(Boolean)
        .some((label) => {
          const l = String(label).toLowerCase();
          return needle.includes(l) || l.includes(needle);
        }),
    ) ?? null
  );
}

/** Same idea for the requested course. */
export async function resolveCourse(rawCourse) {
  if (!rawCourse) return null;
  const needle = String(rawCourse).trim().toLowerCase();
  if (!needle) return null;

  const courses = await Course.find({ isActive: true }).select('code name').lean();
  return (
    courses.find((c) =>
      [c.code, c.name?.ar, c.name?.en].filter(Boolean).some((label) => {
        const l = String(label).toLowerCase();
        return needle.includes(l) || l.includes(needle);
      }),
    ) ?? null
  );
}

/**
 * Turn a Graph lead record plus its webhook envelope into the shape the Lead
 * model expects. Does not touch the database beyond the two lookups.
 *
 * @param {object} graphLead   response from fetchLeadFromGraph
 * @param {object} [envelope]  { pageId, formId, adId, ... } from the webhook
 * @returns {Promise<object>} draft lead payload
 */
export async function mapGraphLeadToDraft(graphLead, envelope = {}) {
  const flat = flattenFieldData(graphLead.field_data);

  const fullName = readField(flat, FIELD_ALIASES.fullName) || 'Unnamed lead';
  const phone = readField(flat, FIELD_ALIASES.phone);
  const email = readField(flat, FIELD_ALIASES.email);
  const courseRaw = readField(flat, FIELD_ALIASES.course);
  const branchRaw = readField(flat, FIELD_ALIASES.branch);

  const [branch, course] = await Promise.all([resolveBranch(branchRaw), resolveCourse(courseRaw)]);

  const platform = (graphLead.platform ?? envelope.platform ?? '').toLowerCase();
  const source = platform.startsWith('ig') ? LEAD_SOURCE.META_INSTAGRAM : LEAD_SOURCE.META_FACEBOOK;

  return {
    fullName,
    phone,
    email: email || undefined,
    courseRaw: courseRaw || undefined,
    branchRaw: branchRaw || undefined,
    course: course?._id,
    branch: branch?._id,
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
      rawFields: flat,
    },
  };
}

export const _testing = { readField, FIELD_ALIASES };
