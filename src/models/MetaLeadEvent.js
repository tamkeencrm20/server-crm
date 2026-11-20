import mongoose from 'mongoose';
import {
  WEBHOOK_EVENT_STATUS,
  WEBHOOK_EVENT_STATUS_VALUES,
  AD_PLATFORM,
  AD_PLATFORM_VALUES,
} from '../config/constants.js';

/**
 * One inbound lead notification from an ad network, recorded the moment it
 * arrives and before anything can go wrong with it.
 *
 * The webhook has to answer 200 within seconds or the network retries, so the
 * server replies first and fetches the lead afterwards. That ordering means a
 * failure after the reply — an expired token, a Graph outage, a validation
 * error — is final: the network considers the lead delivered and will never
 * send it again. Without this collection those leads were written to the log
 * and lost, which is a real customer nobody calls.
 *
 * So the id is written down first, then marked processed or failed. A failed
 * row keeps the error and the original payload, and the retry job and the
 * admin endpoint both work from it. Recovery needs no cooperation from the
 * network, because everything required to try again is already here.
 */
const metaLeadEventSchema = new mongoose.Schema(
  {
    network: {
      type: String,
      enum: AD_PLATFORM_VALUES,
      default: AD_PLATFORM.META,
      index: true,
    },

    /**
     * The network's own lead id. Unique, so a retried delivery updates the
     * existing row instead of adding a second one — the same guarantee the
     * Lead collection gets from meta.leadgenId.
     */
    leadgenId: { type: String, required: true, unique: true, index: true },

    pageId: { type: String, index: true },
    formId: String,
    adId: String,

    status: {
      type: String,
      enum: WEBHOOK_EVENT_STATUS_VALUES,
      default: WEBHOOK_EVENT_STATUS.RECEIVED,
      index: true,
    },

    attempts: { type: Number, default: 0, min: 0 },
    lastAttemptAt: { type: Date },
    processedAt: { type: Date },

    /** Human-readable reason the last attempt failed. */
    lastError: { type: String, trim: true },
    /** Graph API error code, so an expired token (190) can be singled out. */
    lastErrorCode: { type: Number },

    /** The lead this event finally produced, once one exists. */
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },

    /**
     * The webhook's own payload, verbatim. It is only an envelope — the
     * answers live behind the Graph call — but it carries the page, form and
     * ad ids a retry needs, and it is the only record of what arrived if the
     * fetch never succeeds.
     */
    payload: { type: mongoose.Schema.Types.Mixed },

    /** The answers, once fetched. Kept for manual recovery of a broken lead. */
    fieldData: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true },
);

// The retry sweep: oldest failures first, so nobody waits behind a newer one.
metaLeadEventSchema.index({ status: 1, attempts: 1, createdAt: 1 });

export default mongoose.model('MetaLeadEvent', metaLeadEventSchema);
