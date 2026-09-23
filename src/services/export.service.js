/**
 * Flattening leads for a spreadsheet export.
 *
 * The server produces rows, not a file: the workbook is written in the browser
 * by the same library that reads one on import. That keeps a binary encoder out
 * of the API, lets the download start without a round trip through a temp file,
 * and means the exported column headings are the same translated strings the
 * person is already looking at on screen.
 *
 * What comes back is decided entirely by `leadScopeFilter`, so an agent's export
 * contains their own leads and nothing else — the same rule the list screen uses.
 */
import Lead from '../models/Lead.js';
import { leadScopeFilter } from '../middleware/scope.js';
import { formatPhone } from '../utils/phone.js';

/** Hard ceiling, so one click cannot try to serialise the whole database. */
export const EXPORT_MAX_ROWS = 10_000;

/**
 * Build the export rows for a caller, honouring the same filters the leads
 * screen was showing when they pressed the button.
 *
 * @param {object} user     the caller
 * @param {object} [filter] extra Lead filter already narrowed by the route
 * @returns {Promise<object[]>} plain rows, ready to become a sheet
 */
export async function buildLeadExport(user, filter = {}) {
  const leads = await Lead.find({ ...filter, ...leadScopeFilter(user) })
    .populate('assignedTo', 'name email')
    .populate('branch', 'code name')
    .populate('course', 'code name')
    .sort({ createdAt: -1 })
    .limit(EXPORT_MAX_ROWS)
    .lean();

  return leads.map((l) => ({
    fullName: l.fullName ?? '',
    // Exported in the readable form rather than the stored digits, because the
    // usual destination is a phone dialler or a mail merge, not this system.
    phone: formatPhone(l.phone),
    email: l.email ?? '',
    status: l.status ?? '',
    source: l.source ?? '',
    network: l.meta?.network ?? '',
    campaign: l.meta?.campaignName ?? '',
    course: l.course?.name?.ar || l.course?.name?.en || l.courseRaw || '',
    branch: l.branch?.name?.ar || l.branch?.name?.en || l.branchRaw || '',
    assignedTo: l.assignedTo?.name ?? '',
    contactAttempts: l.contactAttempts ?? 0,
    createdAt: l.createdAt ?? null,
    firstContactedAt: l.firstContactedAt ?? null,
    nextFollowUpAt: l.nextFollowUpAt ?? null,
    enrolledAt: l.enrolledAt ?? null,
    dealValue: l.dealValue ?? null,
    lostReason: l.lostReason ?? '',
    tags: (l.tags ?? []).join(', '),
  }));
}

/** Column order for the sheet. The client supplies the translated headings. */
export const EXPORT_COLUMNS = Object.freeze([
  'fullName',
  'phone',
  'email',
  'status',
  'source',
  'network',
  'campaign',
  'course',
  'branch',
  'assignedTo',
  'contactAttempts',
  'createdAt',
  'firstContactedAt',
  'nextFollowUpAt',
  'enrolledAt',
  'dealValue',
  'lostReason',
  'tags',
]);
