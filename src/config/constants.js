/**
 * Domain constants shared across the CRM.
 * Values are stable identifiers — never translate them here.
 * Human labels (ar/en) live in the frontend locale files.
 */

export const ROLES = Object.freeze({
  ADMIN: 'admin',           // الإدارة العليا — full access, all branches
  TEAM_LEADER: 'team_leader', // قائد الفريق — own branch only
  AGENT: 'agent',           // موظف مبيعات — own leads only
});

export const ROLE_VALUES = Object.values(ROLES);

/** Rank used for "can this user manage that user" checks. Higher = more power. */
export const ROLE_RANK = Object.freeze({
  [ROLES.AGENT]: 1,
  [ROLES.TEAM_LEADER]: 2,
  [ROLES.ADMIN]: 3,
});

/** Lead pipeline — دورة حياة العميل */
export const LEAD_STATUS = Object.freeze({
  NEW: 'new',                     // جديد
  CONTACTED: 'contacted',         // تم التواصل
  INTERESTED: 'interested',       // مهتم
  FOLLOW_UP: 'follow_up',         // متابعة لاحقة
  ENROLLED: 'enrolled',           // تم التسجيل
  NOT_INTERESTED: 'not_interested', // غير مهتم
  NO_RESPONSE: 'no_response',     // لا يرد
  CLOSED: 'closed',               // مغلق
});

export const LEAD_STATUS_VALUES = Object.values(LEAD_STATUS);

/** Statuses that end the sales opportunity — no further follow-up expected. */
export const TERMINAL_STATUSES = Object.freeze([
  LEAD_STATUS.ENROLLED,
  LEAD_STATUS.NOT_INTERESTED,
  LEAD_STATUS.CLOSED,
]);

/** Statuses that count as a won deal. */
export const WON_STATUSES = Object.freeze([LEAD_STATUS.ENROLLED]);

/**
 * Allowed pipeline transitions. A lead may always stay where it is.
 * Kept deliberately permissive for sales reality (a "not interested" lead
 * can call back), but blocks nonsense like new -> enrolled without contact.
 */
export const STATUS_TRANSITIONS = Object.freeze({
  [LEAD_STATUS.NEW]: [LEAD_STATUS.CONTACTED, LEAD_STATUS.NO_RESPONSE, LEAD_STATUS.NOT_INTERESTED, LEAD_STATUS.CLOSED],
  [LEAD_STATUS.CONTACTED]: [LEAD_STATUS.INTERESTED, LEAD_STATUS.FOLLOW_UP, LEAD_STATUS.NOT_INTERESTED, LEAD_STATUS.NO_RESPONSE, LEAD_STATUS.ENROLLED, LEAD_STATUS.CLOSED],
  [LEAD_STATUS.INTERESTED]: [LEAD_STATUS.FOLLOW_UP, LEAD_STATUS.ENROLLED, LEAD_STATUS.NOT_INTERESTED, LEAD_STATUS.NO_RESPONSE, LEAD_STATUS.CLOSED],
  [LEAD_STATUS.FOLLOW_UP]: [LEAD_STATUS.CONTACTED, LEAD_STATUS.INTERESTED, LEAD_STATUS.ENROLLED, LEAD_STATUS.NOT_INTERESTED, LEAD_STATUS.NO_RESPONSE, LEAD_STATUS.CLOSED],
  [LEAD_STATUS.NO_RESPONSE]: [LEAD_STATUS.CONTACTED, LEAD_STATUS.FOLLOW_UP, LEAD_STATUS.NOT_INTERESTED, LEAD_STATUS.CLOSED],
  [LEAD_STATUS.NOT_INTERESTED]: [LEAD_STATUS.CONTACTED, LEAD_STATUS.FOLLOW_UP, LEAD_STATUS.CLOSED],
  [LEAD_STATUS.ENROLLED]: [LEAD_STATUS.CLOSED],
  [LEAD_STATUS.CLOSED]: [LEAD_STATUS.CONTACTED, LEAD_STATUS.FOLLOW_UP],
});

/** Where a lead came from. */
export const LEAD_SOURCE = Object.freeze({
  META_FACEBOOK: 'meta_facebook',
  META_INSTAGRAM: 'meta_instagram',
  WEBSITE: 'website',
  WALK_IN: 'walk_in',
  PHONE: 'phone',
  REFERRAL: 'referral',
  IMPORT: 'import',
  MANUAL: 'manual',
});

export const LEAD_SOURCE_VALUES = Object.values(LEAD_SOURCE);

/** Follow-up activity types recorded against a lead. */
export const ACTIVITY_TYPE = Object.freeze({
  CALL: 'call',
  WHATSAPP: 'whatsapp',
  EMAIL: 'email',
  MEETING: 'meeting',
  NOTE: 'note',
  STATUS_CHANGE: 'status_change',
  ASSIGNMENT: 'assignment',
  SYSTEM: 'system',
});

export const ACTIVITY_TYPE_VALUES = Object.values(ACTIVITY_TYPE);

/** Outcome of a contact attempt. */
export const CALL_OUTCOME = Object.freeze({
  ANSWERED: 'answered',
  NO_ANSWER: 'no_answer',
  BUSY: 'busy',
  WRONG_NUMBER: 'wrong_number',
  SWITCHED_OFF: 'switched_off',
});

export const CALL_OUTCOME_VALUES = Object.values(CALL_OUTCOME);

/** How leads get spread over the sales team. */
export const DISTRIBUTION_STRATEGY = Object.freeze({
  ROUND_ROBIN: 'round_robin',   // strict rotation via an atomic cursor
  LEAST_LOADED: 'least_loaded', // whoever holds the fewest open leads
  MANUAL: 'manual',             // park in the unassigned queue
});

export const DISTRIBUTION_STRATEGY_VALUES = Object.values(DISTRIBUTION_STRATEGY);

export const NOTIFICATION_TYPE = Object.freeze({
  LEAD_ASSIGNED: 'lead_assigned',
  FOLLOW_UP_DUE: 'follow_up_due',
  LEAD_STALE: 'lead_stale',
  LEAD_ENROLLED: 'lead_enrolled',
  MENTION: 'mention',
  SYSTEM: 'system',
});

export const NOTIFICATION_TYPE_VALUES = Object.values(NOTIFICATION_TYPE);

/** UAE-facing defaults. */
export const DEFAULT_COUNTRY_CODE = '971';
export const DEFAULT_TIMEZONE = 'Asia/Dubai';
export const DEFAULT_CURRENCY = 'AED';
