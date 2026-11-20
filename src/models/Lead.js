import mongoose from 'mongoose';
import {
  AD_PLATFORM_VALUES,
  LEAD_STATUS,
  LEAD_STATUS_VALUES,
  LEAD_SOURCE,
  LEAD_SOURCE_VALUES,
  LEAD_DATA_ISSUE_VALUES,
  TERMINAL_STATUSES,
  DEFAULT_CURRENCY,
} from '../config/constants.js';
import { normalizePhone } from '../utils/phone.js';

/**
 * A potential trainee. Created automatically from a Meta Lead Ads form, or by
 * hand for walk-ins and phone enquiries.
 *
 * Meta compliance note: this record exists solely to let Tamkeen answer the
 * enquiry the person themselves submitted. It is never exported to third
 * parties — see docs/META_COMPLIANCE.md.
 */
const leadSchema = new mongoose.Schema(
  {
    // --- Identity -----------------------------------------------------
    fullName: { type: String, required: true, trim: true },
    /**
     * Stored normalised (971501234567) so duplicates actually collide.
     *
     * Required only while the lead is not flagged with a data issue. A form
     * that reaches us without a usable number is a real person who filled in
     * a real ad, and refusing to store them lost them for good — the network
     * has already been told the delivery succeeded and never sends it again.
     * Better an incomplete record somebody can look at than none.
     */
    phone: {
      type: String,
      trim: true,
      set: normalizePhone,
      index: true,
      required: [
        function requiredUnlessFlagged() {
          return !this.dataIssue;
        },
        'A lead needs a phone number unless it is flagged with a data issue',
      ],
    },
    email: { type: String, trim: true, lowercase: true },

    /**
     * Why this lead arrived incomplete, if it did. Separate from `status`,
     * which tracks the sale: see LEAD_DATA_ISSUE for the reasoning.
     */
    dataIssue: { type: String, enum: LEAD_DATA_ISSUE_VALUES, index: true },

    /**
     * A delivery from a platform's lead-ads testing tool. Stored so the media
     * buyer can prove the integration works, excluded from distribution and
     * from the reports so it never reaches an agent or skews a number.
     */
    isTest: { type: Boolean, default: false, index: true },

    /** The country the person said they were in, when the form asked. */
    countryRaw: { type: String, trim: true },

    // --- Interest -----------------------------------------------------
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', index: true },
    // Free text kept alongside the reference: Meta sends whatever the form
    // field said, which may not match a Course we know about yet.
    courseRaw: { type: String, trim: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    branchRaw: { type: String, trim: true },

    // --- Origin -------------------------------------------------------
    source: { type: String, enum: LEAD_SOURCE_VALUES, default: LEAD_SOURCE.MANUAL, index: true },

    /**
     * Ad attribution. Named `meta` from when Meta was the only integration; it
     * now carries TikTok and Snapchat too, distinguished by `network`. The name
     * stayed so existing records and the campaign reports keep working — read
     * it as "marketing metadata", not "Meta the company".
     */
    meta: {
      // Which ad network delivered this lead.
      network: { type: String, enum: AD_PLATFORM_VALUES, index: true },
      // The platform's own lead id — the strongest duplicate guard we have.
      // Unique across all networks, which is safe because each one issues ids
      // in its own namespace and we never mint these ourselves.
      leadgenId: { type: String, index: { unique: true, sparse: true } },
      formId: String,
      formName: String,
      pageId: String,
      pageName: String,
      adId: String,
      adName: String,
      campaignId: String,
      campaignName: String,
      adsetId: String,
      adsetName: String,
      // Sub-network inside the platform: 'fb' | 'ig' for Meta, unset elsewhere.
      platform: String,
      createdTime: Date,
      // Everything Meta sent, verbatim, for audit and for fields we do not
      // model yet. Never rendered to the browser unfiltered.
      rawFields: { type: Map, of: String },
    },

    // --- Ownership ----------------------------------------------------
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    assignedAt: { type: Date },
    // Kept so a reassignment leaves a visible trail on the record itself.
    previousAssignees: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    // --- Pipeline -----------------------------------------------------
    status: { type: String, enum: LEAD_STATUS_VALUES, default: LEAD_STATUS.NEW, index: true },
    statusChangedAt: { type: Date, default: Date.now },
    lostReason: { type: String, trim: true },

    // --- Follow-up ----------------------------------------------------
    contactAttempts: { type: Number, default: 0, min: 0 },
    firstContactedAt: { type: Date },
    lastActivityAt: { type: Date, default: Date.now, index: true },
    nextFollowUpAt: { type: Date, index: true },

    // --- Outcome ------------------------------------------------------
    enrolledAt: { type: Date },
    dealValue: { type: Number, min: 0 },
    currency: { type: String, default: DEFAULT_CURRENCY },

    // --- Housekeeping -------------------------------------------------
    tags: [{ type: String, trim: true }],
    // Set when this record was recognised as a repeat of an earlier lead.
    duplicateOf: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    isDuplicate: { type: Boolean, default: false, index: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

// The three queries the app actually runs: an agent's own list, a leader's
// branch list, and the follow-up reminder sweep.
leadSchema.index({ assignedTo: 1, status: 1, lastActivityAt: -1 });
leadSchema.index({ branch: 1, status: 1, createdAt: -1 });
leadSchema.index({ nextFollowUpAt: 1, status: 1 });
leadSchema.index({ fullName: 'text', email: 'text', courseRaw: 'text' });

/** Minutes between the lead arriving and the first contact attempt. */
leadSchema.virtual('responseMinutes').get(function () {
  if (!this.firstContactedAt) return null;
  return Math.round((this.firstContactedAt - this.createdAt) / 60000);
});

leadSchema.virtual('isOpen').get(function () {
  return !TERMINAL_STATUSES.includes(this.status);
});

leadSchema.virtual('activities', {
  ref: 'Activity',
  localField: '_id',
  foreignField: 'lead',
});

export default mongoose.model('Lead', leadSchema);
