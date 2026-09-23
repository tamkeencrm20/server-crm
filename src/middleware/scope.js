import mongoose from 'mongoose';
import { ROLES, BRANCH_WIDE_ROLES } from '../config/constants.js';
import { forbidden } from '../utils/errors.js';

/** True for roles whose visibility is their whole branch. */
const isBranchWide = (role) => BRANCH_WIDE_ROLES.includes(role);

/**
 * Data visibility rules, in one place:
 *
 *   admin        -> every branch, every lead
 *   team_leader  -> their own branch only
 *   media_buyer  -> their own branch only, read-only
 *   agent        -> only leads assigned to them
 *
 * Every list endpoint merges `leadScopeFilter(user)` into its query, so a
 * missing permission check cannot leak another branch's pipeline.
 */
export function leadScopeFilter(user) {
  if (user.role === ROLES.ADMIN) return {};
  if (isBranchWide(user.role)) return { branch: user.branch?._id ?? user.branch };
  return { assignedTo: user._id };
}

/** Same idea for the user directory. */
export function userScopeFilter(user) {
  if (user.role === ROLES.ADMIN) return {};
  if (isBranchWide(user.role)) return { branch: user.branch?._id ?? user.branch };
  return { _id: user._id };
}

const idOf = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);

/** True when `user` is allowed to open this particular lead. */
export function canAccessLead(user, lead) {
  if (user.role === ROLES.ADMIN) return true;
  if (isBranchWide(user.role)) return idOf(lead.branch) === idOf(user.branch);
  return idOf(lead.assignedTo) === String(user._id);
}

/**
 * True when `user` may change this lead (status, notes, follow-up dates).
 *
 * Reading and writing part ways here: a media buyer sees every lead in the
 * branch so they can judge campaign quality, but the pipeline is the sales
 * team's record of its own work — letting the person who bought the traffic
 * also mark it "enrolled" would make the conversion numbers self-reported.
 */
export function canModifyLead(user, lead) {
  if (user.role === ROLES.MEDIA_BUYER) return false;
  return canAccessLead(user, lead);
}

/** Admins may reassign anywhere; leaders only inside their own branch. */
export function assertCanAssignWithin(user, branchId) {
  if (user.role === ROLES.ADMIN) return;
  if (user.role !== ROLES.TEAM_LEADER) throw forbidden('Only team leaders and admins can reassign leads');
  if (idOf(user.branch) !== idOf(branchId)) throw forbidden('You can only reassign leads inside your own branch');
}

/**
 * Narrows a caller-supplied `?branch=` filter to what the caller may see.
 * Returns the branch filter to apply, or throws if they asked for a branch
 * they have no business reading.
 */
export function resolveBranchFilter(user, requestedBranchId) {
  if (user.role === ROLES.ADMIN) {
    if (!requestedBranchId) return {};
    if (!mongoose.isValidObjectId(requestedBranchId)) return {};
    return { branch: requestedBranchId };
  }

  const own = idOf(user.branch);
  if (requestedBranchId && idOf(requestedBranchId) !== own) {
    throw forbidden('You can only view your own branch');
  }
  return own ? { branch: own } : { _id: null }; // no branch assigned = sees nothing
}
