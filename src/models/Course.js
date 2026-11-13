import mongoose from 'mongoose';
import { DEFAULT_CURRENCY } from '../config/constants.js';

/**
 * A training programme a lead can ask about. Price is carried here so the
 * dashboard can attribute revenue to enrolled leads without a separate
 * finance module.
 */
const courseSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: {
      ar: { type: String, required: true, trim: true },
      en: { type: String, required: true, trim: true },
    },
    category: {
      ar: { type: String, trim: true },
      en: { type: String, trim: true },
    },
    description: {
      ar: { type: String, trim: true },
      en: { type: String, trim: true },
    },

    price: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: DEFAULT_CURRENCY },
    durationHours: { type: Number, min: 0 },

    // Restrict to specific branches; empty means "offered everywhere".
    branches: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }],

    // Agents flagged here get priority when this course's leads are routed.
    // Empty means any agent in the branch may receive them.
    specialistAgents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

courseSchema.index({ isActive: 1 });
courseSchema.index({ 'name.ar': 'text', 'name.en': 'text' });

export default mongoose.model('Course', courseSchema);
