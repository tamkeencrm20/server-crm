/**
 * Bulk import of an existing customer list from a spreadsheet.
 *
 * The file itself is parsed in the browser — the server receives plain rows.
 * That keeps multipart handling out of the API, lets the person map columns and
 * see a preview before anything is written, and means a malformed workbook
 * fails on their screen instead of in a request handler.
 *
 * Who ends up owning the imported leads depends on who uploaded them, which is
 * the whole point of the feature:
 *
 *   admin        -> spread across the chosen branch's team by the normal engine
 *   team_leader  -> spread across their own branch's team
 *   media_buyer  -> into their own branch, then spread the same way
 *   agent        -> kept for themselves, never handed to anyone else
 */
import mongoose from 'mongoose';
import Branch from '../models/Branch.js';
import Course from '../models/Course.js';
import User from '../models/User.js';
import Assignment from '../models/Assignment.js';
import Activity from '../models/Activity.js';
import { ROLES, LEAD_SOURCE, IMPORT_ROW_STATUS, IMPORT_MAX_ROWS, ACTIVITY_TYPE } from '../config/constants.js';
import { normalizePhone } from '../utils/phone.js';
import { FIELD_ALIASES, readField } from './leadFields.js';
import { intakeLead } from './lead.service.js';
import { badRequest, forbidden } from '../utils/errors.js';
import { notifyLeadsImported } from './notification.service.js';
import logger from '../utils/logger.js';

/** Extra columns a past-customer export tends to carry, beyond the ad-form set. */
const IMPORT_ALIASES = Object.freeze({
  ...FIELD_ALIASES,
  note: ['note', 'notes', 'comment', 'remarks', 'ملاحظة', 'ملاحظات', 'تعليق'],
  status: ['status', 'stage', 'حالة', 'الحالة', 'المرحلة'],
  dealValue: ['value', 'amount', 'price', 'paid', 'قيمة', 'المبلغ', 'السعر', 'مدفوع'],
  createdAt: ['date', 'created', 'signup', 'تاريخ', 'التاريخ', 'تاريخ التسجيل'],
});

/**
 * Normalise one spreadsheet row into the alias-matched shape the mapper reads.
 * Keys are lowercased and trimmed so "Full Name " and "full_name" agree.
 */
function normaliseRow(row) {
  const flat = {};
  for (const [k, v] of Object.entries(row ?? {})) {
    const key = String(k).toLowerCase().trim();
    if (!key) continue;
    flat[key] = v == null ? '' : String(v).trim();
  }
  return flat;
}

/**
 * Decide which branch an import lands in, and whether the leads get
 * distributed or pinned to the uploader.
 *
 * @param {object} user            the uploader
 * @param {string} requestedBranch branch id from the request, admins only
 * @returns {Promise<{branchId: mongoose.Types.ObjectId, assignTo: ?object, autoAssign: boolean}>}
 */
export async function resolveImportTarget(user, requestedBranch) {
  // An agent's import is their own book of business; it never enters the pool.
  if (user.role === ROLES.AGENT) {
    const own = user.branch?._id ?? user.branch;
    if (!own) throw forbidden('Your account is not attached to a branch, ask your team leader');
    return { branchId: own, assignTo: user._id, autoAssign: false };
  }

  if (user.role === ROLES.ADMIN) {
    if (!requestedBranch) throw badRequest('Choose the branch these leads belong to');
    if (!mongoose.isValidObjectId(requestedBranch)) throw badRequest('That branch id is not valid');

    const branch = await Branch.findById(requestedBranch).select('_id isActive');
    if (!branch) throw badRequest('That branch does not exist');
    if (!branch.isActive) throw badRequest('That branch is deactivated');

    return { branchId: branch._id, assignTo: null, autoAssign: true };
  }

  // Team leader and media buyer: their own branch, no choice offered.
  const own = user.branch?._id ?? user.branch;
  if (!own) throw forbidden('Your account is not attached to a branch');
  if (requestedBranch && String(requestedBranch) !== String(own)) {
    throw forbidden('You can only import into your own branch');
  }
  return { branchId: own, assignTo: null, autoAssign: true };
}

/**
 * Validate and import a batch of rows.
 *
 * Rows are processed one at a time rather than in a bulk write: each one goes
 * through the same intake path as a lead arriving from an ad, so duplicate
 * detection, the assignment audit row, and the activity timeline all behave
 * identically no matter where a lead came from.
 *
 * @param {object[]} rows
 * @param {object}   options
 * @param {object}   options.user      the uploader
 * @param {string}   [options.branch]  branch id, admins only
 * @param {boolean}  [options.dryRun]  validate and report without writing
 * @returns {Promise<object>} per-row outcomes plus a summary
 */
export async function importLeads(rows, { user, branch: requestedBranch, dryRun = false } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) throw badRequest('The sheet has no rows');
  if (rows.length > IMPORT_MAX_ROWS) {
    throw badRequest(`That sheet has ${rows.length} rows; split it into files of ${IMPORT_MAX_ROWS} or fewer`);
  }

  const target = await resolveImportTarget(user, requestedBranch);
  const courses = await Course.find({ isActive: true }).select('code name').lean();

  // Phone numbers repeated inside the same file, so a sheet that lists someone
  // twice reports the second one rather than racing itself through intake.
  const seen = new Set();
  const results = [];
  const summary = { total: rows.length, created: 0, duplicate: 0, invalid: 0 };

  // Tallied as we go so the counters move in one write per agent rather than
  // one per row, and so each agent gets a single summary notification.
  const assignedCounts = new Map();
  const selfAssigned = [];

  for (let i = 0; i < rows.length; i += 1) {
    // Row 1 is the header in every spreadsheet tool, so data starts at 2.
    const rowNumber = i + 2;
    const flat = normaliseRow(rows[i]);

    const fullName = readField(flat, IMPORT_ALIASES.fullName);
    const rawPhone = readField(flat, IMPORT_ALIASES.phone);
    const phone = normalizePhone(rawPhone);

    if (!fullName || fullName.length < 2) {
      results.push({ row: rowNumber, status: IMPORT_ROW_STATUS.INVALID, reason: 'Missing a name' });
      summary.invalid += 1;
      continue;
    }
    if (!phone || phone.length < 8) {
      results.push({ row: rowNumber, status: IMPORT_ROW_STATUS.INVALID, reason: 'Missing or unreadable phone number', name: fullName });
      summary.invalid += 1;
      continue;
    }
    if (seen.has(phone)) {
      results.push({ row: rowNumber, status: IMPORT_ROW_STATUS.DUPLICATE, reason: 'Repeated earlier in this same file', name: fullName });
      summary.duplicate += 1;
      continue;
    }
    seen.add(phone);

    const courseRaw = readField(flat, IMPORT_ALIASES.course);
    const course = courseRaw ? matchCourse(courses, courseRaw) : null;
    const email = readField(flat, IMPORT_ALIASES.email);
    const note = readField(flat, IMPORT_ALIASES.note);

    if (dryRun) {
      results.push({ row: rowNumber, status: IMPORT_ROW_STATUS.CREATED, name: fullName, phone });
      summary.created += 1;
      continue;
    }

    try {
      const { lead, duplicate, assignment } = await intakeLead(
        {
          fullName,
          phone,
          email: email || undefined,
          courseRaw: courseRaw || undefined,
          course: course?._id,
          branch: target.branchId,
          source: LEAD_SOURCE.IMPORT,
          // An agent's own upload is stamped with their ownership here rather
          // than run through the distribution engine, so it never enters the
          // rotation and never lands on a colleague.
          ...(target.assignTo ? { assignedTo: target.assignTo, assignedAt: new Date() } : {}),
        },
        {
          autoAssign: target.autoAssign,
          createdBy: user._id,
          // One summary per agent goes out at the end instead.
          notify: false,
        },
      );

      if (duplicate) {
        results.push({ row: rowNumber, status: IMPORT_ROW_STATUS.DUPLICATE, reason: 'Already in the CRM', name: fullName, leadId: lead._id });
        summary.duplicate += 1;
      } else {
        // The note column becomes a real timeline entry; Lead has no note field.
        if (note) {
          await Activity.log({
            lead: lead._id,
            branch: lead.branch,
            actor: user._id,
            type: ACTIVITY_TYPE.NOTE,
            note,
          });
        }

        const ownerId = assignment?.agent?._id ?? target.assignTo ?? null;
        if (ownerId) {
          const key = String(ownerId);
          assignedCounts.set(key, (assignedCounts.get(key) ?? 0) + 1);
          // The distribution engine writes its own audit row; a self-import has
          // none, so record one here to keep every lead's ownership traceable.
          if (!assignment?.assigned) {
            selfAssigned.push({
              lead: lead._id,
              branch: lead.branch,
              course: lead.course,
              assignedTo: ownerId,
              assignedBy: user._id,
              strategy: 'manual',
              eligibleCount: 1,
              reason: `Imported from a spreadsheet by ${user.name}`,
              succeeded: true,
            });
          }
        }

        results.push({
          row: rowNumber,
          status: IMPORT_ROW_STATUS.CREATED,
          name: fullName,
          leadId: lead._id,
          assignedTo: assignment?.agent?.name ?? (target.assignTo ? user.name : null),
        });
        summary.created += 1;
      }
    } catch (err) {
      logger.error(`Import row ${rowNumber} failed`, err);
      results.push({ row: rowNumber, status: IMPORT_ROW_STATUS.INVALID, reason: err.message ?? 'Could not be saved', name: fullName });
      summary.invalid += 1;
    }
  }

  if (!dryRun) await settleOwnership({ assignedCounts, selfAssigned, uploader: user });

  logger.info(
    `Import by ${user.email}: ${summary.created} created, ${summary.duplicate} duplicate, ${summary.invalid} invalid` +
      (dryRun ? ' (dry run)' : ''),
  );

  return { summary, results, dryRun, branch: target.branchId, keptByUploader: !target.autoAssign };
}

/**
 * Close the books on an import: write the audit rows the distribution engine
 * did not, move each owner's counters once, and send one notification each.
 */
async function settleOwnership({ assignedCounts, selfAssigned, uploader }) {
  if (selfAssigned.length > 0) await Assignment.insertMany(selfAssigned, { ordered: false });

  await Promise.all(
    [...assignedCounts.entries()].map(async ([agentId, count]) => {
      // Leads auto-assigned by the engine already had their counters moved;
      // only the self-assigned ones still need it.
      const selfCount = selfAssigned.filter((a) => String(a.assignedTo) === agentId).length;
      if (selfCount > 0) {
        await User.updateOne(
          { _id: agentId },
          { $inc: { openLeadsCount: selfCount, totalLeadsCount: selfCount }, $set: { lastAssignedAt: new Date() } },
        );
      }
      // Uploaders do not need telling about the file they just uploaded.
      if (String(agentId) !== String(uploader._id)) {
        await notifyLeadsImported(agentId, count, uploader.name);
      }
    }),
  );
}

/** Loose match of a free-text course cell against the catalogue. */
function matchCourse(courses, raw) {
  const needle = String(raw).trim().toLowerCase();
  if (!needle) return null;
  return (
    courses.find((c) =>
      [c.code, c.name?.ar, c.name?.en].filter(Boolean).some((label) => {
        const l = String(label).toLowerCase();
        return needle.includes(l) || l.includes(needle);
      }),
    ) ?? null
  );
}

export const _testing = { normaliseRow, matchCourse, IMPORT_ALIASES };
