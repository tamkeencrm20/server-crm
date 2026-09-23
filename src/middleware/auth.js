import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import User from '../models/User.js';
import { ROLES, ROLE_RANK } from '../config/constants.js';
import { unauthorized, forbidden, asyncHandler } from '../utils/errors.js';

/**
 * Verifies the bearer access token and hangs the live User document on
 * `req.user`. Reads the user fresh on every request so a deactivated account
 * or a role change takes effect immediately rather than at token expiry.
 */
export const authenticate = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthorized('Missing access token');

  let payload;
  try {
    payload = jwt.verify(token, env.JWT_ACCESS_SECRET);
  } catch (err) {
    throw unauthorized(err.name === 'TokenExpiredError' ? 'Access token expired' : 'Invalid access token', {
      code: err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
    });
  }

  const user = await User.findById(payload.sub).populate('branch', 'code name isActive');
  if (!user) throw unauthorized('Account no longer exists');
  if (!user.isActive) throw forbidden('This account has been deactivated', { code: 'ACCOUNT_DISABLED' });

  req.user = user;
  next();
});

/**
 * Restricts a route to the given roles.
 * @param {...string} roles
 */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(forbidden(`This action requires one of: ${roles.join(', ')}`, { code: 'ROLE_REQUIRED' }));
    }
    next();
  };
}

/** Allows the request through only for a role at or above `minRole`. */
export function requireMinRole(minRole) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (ROLE_RANK[req.user.role] < ROLE_RANK[minRole]) {
      return next(forbidden('Insufficient privileges', { code: 'ROLE_REQUIRED' }));
    }
    next();
  };
}

export const requireAdmin = requireRole(ROLES.ADMIN);

/** Ownership and team management: team leaders and admins only. */
export const requireLeader = requireMinRole(ROLES.TEAM_LEADER);

/**
 * Branch-wide reporting: adds media buyers, who need the same numbers a team
 * leader sees in order to judge which campaigns are worth the spend.
 */
export const requireBranchInsight = requireMinRole(ROLES.MEDIA_BUYER);

/** Ad-platform configuration: the media buyer's own domain, plus admins. */
export const requireMediaBuyer = requireRole(ROLES.MEDIA_BUYER, ROLES.ADMIN);
