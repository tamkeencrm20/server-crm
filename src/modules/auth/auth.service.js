import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import env from '../../config/env.js';
import User from '../../models/User.js';
import RefreshToken, { hashToken } from '../../models/RefreshToken.js';
import { unauthorized, forbidden } from '../../utils/errors.js';

/** Turn "30d" / "15m" / "45s" into milliseconds. */
function ttlToMs(ttl) {
  const m = String(ttl).match(/^(\d+)\s*([smhd])$/);
  if (!m) return Number(ttl) || 0;
  const n = Number(m[1]);
  return n * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
}

function signAccessToken(user) {
  return jwt.sign(
    { sub: String(user._id), role: user.role, branch: user.branch ? String(user.branch._id ?? user.branch) : null },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_TTL },
  );
}

/**
 * Refresh tokens are opaque random strings, not JWTs — they exist only as a
 * hashed row in the database, so revoking a session actually works.
 */
async function issueRefreshToken(user, { userAgent, ip } = {}) {
  const token = crypto.randomBytes(48).toString('hex');
  await RefreshToken.create({
    user: user._id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ttlToMs(env.JWT_REFRESH_TTL)),
    userAgent,
    ip,
  });
  return token;
}

/**
 * Verify credentials and start a session.
 * @throws {AppError} 401 on bad credentials, 403 on a disabled account
 */
export async function login(email, password, context = {}) {
  const user = await User.findOne({ email: String(email).toLowerCase().trim() })
    .select('+passwordHash')
    .populate('branch', 'code name');

  // Same message either way, so the endpoint cannot be used to enumerate emails.
  if (!user) throw unauthorized('Incorrect email or password', { code: 'BAD_CREDENTIALS' });

  const ok = await user.verifyPassword(password);
  if (!ok) throw unauthorized('Incorrect email or password', { code: 'BAD_CREDENTIALS' });

  if (!user.isActive) throw forbidden('This account has been deactivated', { code: 'ACCOUNT_DISABLED' });

  user.lastLoginAt = new Date();
  await user.save();

  return {
    user: user.toJSON(),
    accessToken: signAccessToken(user),
    refreshToken: await issueRefreshToken(user, context),
  };
}

/** Exchange a refresh token for a new pair, rotating the refresh token. */
export async function refresh(rawToken, context = {}) {
  if (!rawToken) throw unauthorized('Missing refresh token');

  const record = await RefreshToken.findOne({ tokenHash: hashToken(rawToken) });
  if (!record || record.revokedAt || record.expiresAt < new Date()) {
    throw unauthorized('Refresh token is invalid or expired', { code: 'REFRESH_INVALID' });
  }

  const user = await User.findById(record.user).populate('branch', 'code name');
  if (!user || !user.isActive) throw forbidden('This account has been deactivated', { code: 'ACCOUNT_DISABLED' });

  // Rotation: the presented token dies the moment it is used.
  record.revokedAt = new Date();
  await record.save();

  return {
    user: user.toJSON(),
    accessToken: signAccessToken(user),
    refreshToken: await issueRefreshToken(user, context),
  };
}

/** Revoke a single session. */
export async function logout(rawToken) {
  if (!rawToken) return;
  await RefreshToken.updateOne(
    { tokenHash: hashToken(rawToken), revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

/** Revoke every session for a user — used on password change and deactivation. */
export async function revokeAllSessions(userId) {
  await RefreshToken.updateMany({ user: userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

export async function changePassword(user, currentPassword, newPassword) {
  const withHash = await User.findById(user._id).select('+passwordHash');
  const ok = await withHash.verifyPassword(currentPassword);
  if (!ok) throw unauthorized('Current password is incorrect', { code: 'BAD_CREDENTIALS' });

  await withHash.setPassword(newPassword);
  await withHash.save();
  await revokeAllSessions(user._id);
}

export const _internals = { ttlToMs, signAccessToken };
