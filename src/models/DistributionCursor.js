import mongoose from 'mongoose';

/**
 * The rotating pointer behind round-robin distribution.
 *
 * One document per scope (a branch, optionally narrowed to a course). The
 * engine atomically increments `seq` with findOneAndUpdate and takes
 * `agents[seq % agents.length]`, so two leads arriving in the same
 * millisecond can never land on the same agent.
 */
const distributionCursorSchema = new mongoose.Schema(
  {
    // e.g. "branch:65f0...ab" or "branch:65f0...ab|course:65f1...cd"
    key: { type: String, required: true, unique: true },
    seq: { type: Number, default: 0 },
    lastAssignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lastAssignedAt: { type: Date },
  },
  { timestamps: true },
);

/** Build the scope key for a branch, optionally narrowed by course. */
export function cursorKey(branchId, courseId) {
  const base = `branch:${branchId ?? 'none'}`;
  return courseId ? `${base}|course:${courseId}` : base;
}

export default mongoose.model('DistributionCursor', distributionCursorSchema);
