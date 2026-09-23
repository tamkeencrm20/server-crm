/**
 * Turning an ad platform's answer list into a Tamkeen lead.
 *
 * Meta, TikTok and Snapchat all deliver the same shape underneath: a list of
 * question/answer pairs whose keys are whatever the marketer typed into the
 * form builder. Rather than a per-platform mapping table that has to be
 * maintained every time someone edits a campaign, the keys are matched against
 * an alias list in both Arabic and English. One form asking `الدورة` and
 * another asking `course` both land in the same field with no configuration.
 */
import Branch from '../models/Branch.js';
import Course from '../models/Course.js';

/**
 * Substring-matched, case-insensitive. Order matters: earlier aliases win, so
 * put the exact platform field names first and the loose human phrasings last.
 */
export const FIELD_ALIASES = Object.freeze({
  fullName: ['full_name', 'name', 'الاسم', 'اسم', 'first_name'],
  email: ['email', 'بريد', 'ايميل', 'الايميل'],
  phone: ['phone_number', 'phone', 'mobile', 'whatsapp', 'tel', 'هاتف', 'جوال', 'رقم', 'موبايل'],
  course: ['course', 'program', 'training', 'دورة', 'الدورة', 'برنامج', 'تدريب', 'التخصص'],
  branch: ['branch', 'city', 'location', 'emirate', 'فرع', 'الفرع', 'مدينة', 'المدينة', 'امارة'],
  company: ['company', 'organization', 'جهة', 'شركة'],
});

/**
 * Normalise any platform's answer list into a flat { key: value } map.
 *
 * Accepts the three shapes actually seen in the wild:
 *   Meta      [{ name, values: [...] }]
 *   TikTok    [{ field_name, field_value }] or a plain object
 *   Snapchat  a plain { question: answer } object
 */
export function flattenAnswers(answers) {
  const flat = {};
  if (!answers) return flat;

  if (Array.isArray(answers)) {
    for (const item of answers) {
      if (!item || typeof item !== 'object') continue;
      const key = String(item.name ?? item.field_name ?? item.question ?? item.key ?? '').toLowerCase().trim();
      if (!key) continue;
      const raw = item.values ?? item.field_value ?? item.answer ?? item.value ?? '';
      flat[key] = Array.isArray(raw) ? raw.join(', ') : String(raw ?? '');
    }
    return flat;
  }

  if (typeof answers === 'object') {
    for (const [k, v] of Object.entries(answers)) {
      const key = String(k).toLowerCase().trim();
      if (!key) continue;
      flat[key] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
    }
  }

  return flat;
}

/** Read one logical field out of the flat map using its alias list. */
export function readField(flat, aliases) {
  for (const alias of aliases) {
    // Exact match first, so "name" does not lose to "company_name".
    if (flat[alias]) return flat[alias];
  }
  for (const alias of aliases) {
    const hit = Object.keys(flat).find((k) => k.includes(alias));
    if (hit && flat[hit]) return flat[hit];
  }
  return '';
}

/**
 * Best-effort match of a free-text branch answer to a Branch document.
 * Falls back to null, which parks the lead in the unassigned queue rather than
 * guessing wrong and sending it to the wrong city.
 */
export async function resolveBranch(rawBranch) {
  if (!rawBranch) return null;
  const needle = String(rawBranch).trim().toLowerCase();
  if (!needle) return null;

  const branches = await Branch.find({ isActive: true }).select('code name city').lean();
  return (
    branches.find((b) =>
      [b.code, b.name?.ar, b.name?.en, b.city?.ar, b.city?.en]
        .filter(Boolean)
        .some((label) => {
          const l = String(label).toLowerCase();
          return needle.includes(l) || l.includes(needle);
        }),
    ) ?? null
  );
}

/** Same idea for the requested course. */
export async function resolveCourse(rawCourse) {
  if (!rawCourse) return null;
  const needle = String(rawCourse).trim().toLowerCase();
  if (!needle) return null;

  const courses = await Course.find({ isActive: true }).select('code name').lean();
  return (
    courses.find((c) =>
      [c.code, c.name?.ar, c.name?.en].filter(Boolean).some((label) => {
        const l = String(label).toLowerCase();
        return needle.includes(l) || l.includes(needle);
      }),
    ) ?? null
  );
}

/**
 * Read the five fields Tamkeen cares about out of a platform answer list, and
 * resolve the branch and course references.
 *
 * @param {any} answers  platform answer list in any of the supported shapes
 * @returns {Promise<{fullName,phone,email,courseRaw,branchRaw,course,branch,flat}>}
 */
export async function extractLeadIdentity(answers) {
  const flat = flattenAnswers(answers);

  const fullName = readField(flat, FIELD_ALIASES.fullName) || 'Unnamed lead';
  const phone = readField(flat, FIELD_ALIASES.phone);
  const email = readField(flat, FIELD_ALIASES.email);
  const courseRaw = readField(flat, FIELD_ALIASES.course);
  const branchRaw = readField(flat, FIELD_ALIASES.branch);

  const [branch, course] = await Promise.all([resolveBranch(branchRaw), resolveCourse(courseRaw)]);

  return {
    fullName,
    phone,
    email: email || undefined,
    courseRaw: courseRaw || undefined,
    branchRaw: branchRaw || undefined,
    course: course?._id,
    branch: branch?._id,
    flat,
  };
}
