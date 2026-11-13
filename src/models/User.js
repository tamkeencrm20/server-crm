import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { ROLES, ROLE_VALUES } from '../config/constants.js';
import { normalizePhone } from '../utils/phone.js';

const SALT_ROUNDS = 12;

/**
 * Every human who signs into the CRM: admin, team leader, or sales agent.
 * `branch` is required for team leaders and agents and ignored for admins,
 * who see every branch.
 */
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, trim: true, set: normalizePhone },

    passwordHash: { type: String, required: true, select: false },

    role: { type: String, enum: ROLE_VALUES, required: true, index: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },

    // --- Distribution eligibility -------------------------------------
    // isActive:    account enabled at all (disabled = cannot sign in)
    // isAvailable: on shift right now — an agent can toggle this themselves
    //              or a leader can flip it. Only active AND available agents
    //              receive automatically distributed leads.
    isActive: { type: Boolean, default: true, index: true },
    isAvailable: { type: Boolean, default: true, index: true },

    // 0 = unlimited. Guards against dumping a whole campaign on one agent.
    dailyLeadCap: { type: Number, default: 0, min: 0 },

    // --- Denormalised counters, maintained by the distribution service ---
    openLeadsCount: { type: Number, default: 0, min: 0 },
    totalLeadsCount: { type: Number, default: 0, min: 0 },
    lastAssignedAt: { type: Date },

    locale: { type: String, enum: ['ar', 'en'], default: 'ar' },
    avatarUrl: { type: String, trim: true },
    lastLoginAt: { type: Date },

    // Bumped on password change / forced logout so old refresh tokens die.
    tokenVersion: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        delete ret.passwordHash;
        delete ret.tokenVersion;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// The distribution service asks this exact question on every incoming lead.
userSchema.index({ branch: 1, role: 1, isActive: 1, isAvailable: 1 });

userSchema.virtual('isAdmin').get(function () {
  return this.role === ROLES.ADMIN;
});

/** Hash and store a plaintext password. Does not save. */
userSchema.methods.setPassword = async function setPassword(plain) {
  this.passwordHash = await bcrypt.hash(plain, SALT_ROUNDS);
  this.tokenVersion += 1;
};

userSchema.methods.verifyPassword = function verifyPassword(plain) {
  if (!this.passwordHash) return Promise.resolve(false);
  return bcrypt.compare(plain, this.passwordHash);
};

export default mongoose.model('User', userSchema);
