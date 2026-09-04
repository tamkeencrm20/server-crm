import mongoose from 'mongoose';
import { DISTRIBUTION_STRATEGY, DISTRIBUTION_STRATEGY_VALUES, DEFAULT_TIMEZONE } from '../config/constants.js';

/**
 * A physical training branch (Ajman, Dubai, ...). New branches can be added at
 * any time — nothing in the system hardcodes a branch list.
 */
const branchSchema = new mongoose.Schema(
  {
    // Short stable key used in URLs and Meta form mapping, e.g. "ajman".
    code: { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[a-z0-9_-]+$/ },
    name: {
      ar: { type: String, required: true, trim: true },
      en: { type: String, required: true, trim: true },
    },
    city: {
      ar: { type: String, trim: true },
      en: { type: String, trim: true },
    },
    address: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    timezone: { type: String, default: DEFAULT_TIMEZONE },

    // How incoming leads for this branch are spread over its agents.
    distributionStrategy: {
      type: String,
      enum: DISTRIBUTION_STRATEGY_VALUES,
      default: DISTRIBUTION_STRATEGY.ROUND_ROBIN,
    },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

branchSchema.index({ isActive: 1 });

export default mongoose.model('Branch', branchSchema);
