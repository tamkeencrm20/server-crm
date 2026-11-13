import mongoose from 'mongoose';

/**
 * Audit trail for the automatic distribution engine — required by the spec so
 * "why did this lead go to that agent" always has an answer. Separate from
 * Activity because it records the engine's reasoning, not the agent's work.
 */
const assignmentSchema = new mongoose.Schema(
  {
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course' },

    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    previousAssignee: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Null when the engine assigned it; set when a human reassigned.
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    strategy: { type: String, required: true },
    // The scope key the round-robin cursor was drawn from.
    cursorKey: { type: String },
    cursorSeq: { type: Number },

    // Snapshot of who was eligible at decision time, so a later roster change
    // does not make the audit trail unreadable.
    eligibleAgents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    eligibleCount: { type: Number },

    // Human-readable explanation, e.g. "round_robin: seq 37 % 5 agents".
    reason: { type: String, trim: true },

    succeeded: { type: Boolean, default: true },
    // Why nothing could be assigned: no active agents, all at cap, ...
    failureReason: { type: String, trim: true },
  },
  { timestamps: true },
);

assignmentSchema.index({ createdAt: -1 });
assignmentSchema.index({ assignedTo: 1, createdAt: -1 });

export default mongoose.model('Assignment', assignmentSchema);
