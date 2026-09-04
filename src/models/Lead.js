import mongoose from 'mongoose';
import {
  LEAD_STATUS,
  LEAD_STATUS_VALUES,
  LEAD_SOURCE,
  LEAD_SOURCE_VALUES,
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
    // Stored normalised (971501234567) so duplicates actually collide.
    phone: { type: String, required: true, trim: true, set: normalizePhone, index: true },
    email: { type: String, trim: true, lowercase: true },

    // --- Interest -----------------------------------------------------
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', index: true },
    // Free text kept alongside the reference: Meta sends whatever the form
    // field said, which may not match a Course we know about yet.
    courseRaw: { type: String, trim: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    branchRaw: { type: String, trim: true },

    // --- Origin -------------------------------------------------------
    source: { type: String, enum: LEAD_SOURCE_VALUES, default: LEAD_SOURCE.MANUAL, index: true },
    meta: {
      // Meta's own lead id — the strongest duplicate guard we have.
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
      platform: String, // 'fb' | 'ig'
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
