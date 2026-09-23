/**
 * Wiring for the two networks that share the generic router. Meta keeps its own
 * module because its webhook never carries answers — it always needs the Graph
 * pull, and its handshake uses hub.mode as well as hub.verify_token.
 */
import { AD_PLATFORM } from '../../config/constants.js';
import * as tiktokService from '../../services/tiktok.service.js';
import * as snapchatService from '../../services/snapchat.service.js';
import { createPlatformRouter } from './platform.routes.js';

/**
 * TikTok posts either a single event or a batch. Both shapes appear depending
 * on the app's delivery settings, so handle them the same way.
 */
function extractTikTokDeliveries(body) {
  const events = Array.isArray(body) ? body : body.data ?? body.events ?? [body];

  return events
    .filter((e) => e && typeof e === 'object')
    .filter((e) => !e.event || String(e.event).includes('lead'))
    .map((e) => {
      const lead = e.data ?? e.lead ?? e;
      return {
        leadId: String(lead.lead_id ?? lead.id ?? ''),
        inlineLead: lead,
        envelope: {
          pageId: lead.page_id,
          adId: lead.ad_id,
          createTime: lead.create_time ?? lead.created_time,
        },
      };
    })
    .filter((d) => d.leadId || d.inlineLead);
}

/** Snapchat batches submissions under `leads` or `data`. */
function extractSnapchatDeliveries(body) {
  const items = Array.isArray(body) ? body : body.leads ?? body.data ?? [body];

  return items
    .filter((i) => i && typeof i === 'object')
    .map((i) => {
      const lead = i.lead ?? i.data ?? i;
      return {
        leadId: String(lead.id ?? lead.lead_id ?? ''),
        inlineLead: lead,
        envelope: {
          formId: lead.lead_form_id,
          adId: lead.ad_id,
          createdAt: lead.created_at,
        },
      };
    })
    .filter((d) => d.leadId || d.inlineLead);
}

export const tiktokRouter = createPlatformRouter({
  platform: AD_PLATFORM.TIKTOK,
  signatureHeader: 'x-tt-signature',
  service: tiktokService,
  extractDeliveries: extractTikTokDeliveries,
});

export const snapchatRouter = createPlatformRouter({
  platform: AD_PLATFORM.SNAPCHAT,
  signatureHeader: 'x-snap-signature',
  service: snapchatService,
  extractDeliveries: extractSnapchatDeliveries,
});

export { extractTikTokDeliveries, extractSnapchatDeliveries };
