import mongoose from 'mongoose';
import { ACTIVITY_TYPE, ACTIVITY_TYPE_VALUES, CALL_OUTCOME_VALUES } from '../config/constants.js';

/**
 * One line in a lead's follow-up history: a call, a note, a status change, an
 * assignment. Append-only — entries are never edited or deleted, so the
 * timeline stays trustworthy for performance review.
 */
const activitySchema = new mongoose.Schema(
  {
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    // Null for entries written by the automation itself.
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },

    type: { type: String, enum: ACTIVITY_TYPE_VALUES, required: true, index: true },
    note: { type: String, trim: true, maxlength: 4000 },

    // Populated for type === 'call'.
    callOutcome: { type: String, enum: CALL_OUTCOME_VALUES },
    callDurationSeconds: { type: Number, min: 0 },

    // Populated for type === 'status_change'.
    fromStatus: String,
    toStatus: String,

    // Populated for type === 'assignment'.
    fromUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    toUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Follow-up date the agent set while writing this entry.
    scheduledFor: { type: Date },

    // True when the automation wrote this, not a person.
    isSystem: { type: Boolean, default: false },
  },
  { timestamps: true },
);

activitySchema.index({ lead: 1, createdAt: -1 });
activitySchema.index({ actor: 1, type: 1, createdAt: -1 });

/** Convenience factory used all over the services layer. */
activitySchema.statics.log = function log(payload) {
  return this.create({
    isSystem: !payload.actor || payload.type === ACTIVITY_TYPE.SYSTEM,
    ...payload,
  });
};

export default mongoose.model('Activity', activitySchema);
