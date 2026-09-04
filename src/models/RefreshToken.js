import mongoose from 'mongoose';
import crypto from 'node:crypto';

/**
 * Server-side record of issued refresh tokens, so a session can actually be
 * revoked. Only a SHA-256 digest is stored — a database dump does not hand an
 * attacker usable sessions.
 */
const refreshTokenSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
    userAgent: { type: String },
    ip: { type: String },
  },
  { timestamps: true },
);

// Mongo drops the document once it expires; revocation still works before then.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export default mongoose.model('RefreshToken', refreshTokenSchema);
