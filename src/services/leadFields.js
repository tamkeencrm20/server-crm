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
import { toWesternDigits } from '../utils/phone.js';

/**
 * Field names reach us in whatever shape the marketer typed into the form
 * builder, and the platforms slugify them differently: Meta turns the question
 * "رقم الهاتف" into the field name `رقم_الهاتف`, and "اي برنامج ترغب في
 * الاستفسار عنه؟" keeps its question mark. normalizeKey flattens all of that
 * so one alias list covers every form, in either language, on all three
 * networks — rather than a per-campaign mapping table that goes stale the
 * first time someone edits an ad.
 *
 * @param {string} name
 * @returns {string}
 */
export function normalizeKey(name) {
  return String(name ?? '')
    .toLowerCase()
    // Separators the platforms use between words.
    .replace(/[_\-/\\.]+/g, ' ')
    // Punctuation that carries no meaning here, Arabic question mark included.
    .replace(/[?؟!:;,()[\]{}"'`*#]+/g, ' ')
    // Arabic diacritics and the tatweel stretching character.
    .replace(/[ً-ْـ]/g, '')
    // Spelling variants of the same letter, so "الأسم" matches "الاسم".
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Order matters: earlier aliases win, so the exact field names the platforms
 * generate come first and the loose human phrasings last.
 *
 * A purely ASCII alias is matched on word boundaries, never as a bare
 * substring — otherwise `tel` claims "hotel management course" as a phone
 * number. Arabic aliases fall back to substring matching, which is what they
 * need: `رقم` has to find `رقم الهاتف`.
 */
export const FIELD_ALIASES = Object.freeze({
  fullName: [
    'full name', 'name', 'first name', 'last name',
    'الاسم بالكامل', 'الاسم الكامل', 'الاسم', 'اسم',
  ],
  email: ['email', 'e mail', 'البريد الالكتروني', 'بريد', 'ايميل'],
  phone: [
    'phone number', 'phone', 'mobile number', 'mobile', 'whatsapp', 'tel',
    'رقم الهاتف', 'رقم الجوال', 'رقم الموبايل', 'رقم التواصل', 'هاتف', 'جوال',
    'موبايل', 'واتساب', 'رقم',
  ],
  course: [
    'course', 'program', 'programme', 'training', 'specialization',
    'الدورة', 'دورة', 'البرنامج', 'برنامج', 'تدريب', 'التخصص', 'تخصص',
  ],
  branch: [
    'branch', 'city', 'emirate', 'location',
    'الفرع', 'فرع', 'المدينة', 'مدينة', 'الامارة', 'امارة',
  ],
  company: ['company', 'organization', 'employer', 'جهة العمل', 'جهة', 'شركة'],
  /**
   * Read only so that it never reaches the branch field. The new Ajman form
   * asks "من اي دولة انت/انتِ", and a country is not a branch: answering
   * "السعودية" must not route the lead to a UAE city by accident. It is kept
   * with the raw answers for the agent to read.
   */
  country: ['country', 'nationality', 'الدولة', 'دولة', 'البلد', 'بلد', 'الجنسية'],
});

const ASCII_ONLY = /^[\x20-\x7e]+$/;

/** Pre-compiled matchers, built once rather than per lead. */
const ALIAS_MATCHERS = Object.freeze(
  Object.fromEntries(
    Object.entries(FIELD_ALIASES).map(([field, aliases]) => [
      field,
      aliases.map((raw) => {
        const alias = normalizeKey(raw);
        return {
          alias,
          test: ASCII_ONLY.test(alias)
            ? (key) => new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(key)
            : (key) => key.includes(alias),
        };
      }),
    ]),
  ),
);

/**
 * The Lead Ads Testing Tool fills every answer with a placeholder rather than
 * real data — "<test lead: dummy data for phone_number>". Those leads must
 * still be stored, so the media buyer can see the plumbing works end to end,
 * but they must never reach an agent's call list.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isTestValue(value) {
  const v = String(value ?? '').trim();
  if (!v) return false;
  return /^<.*>$/.test(v) && /test\s*lead|dummy\s*data/i.test(v);
}

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
      const key = normalizeKey(item.name ?? item.field_name ?? item.question ?? item.key ?? '');
      if (!key) continue;
      const raw = item.values ?? item.field_value ?? item.answer ?? item.value ?? '';
      flat[key] = (Array.isArray(raw) ? raw.join(', ') : String(raw ?? '')).trim();
    }
    return flat;
  }

  if (typeof answers === 'object') {
    for (const [k, v] of Object.entries(answers)) {
      const key = normalizeKey(k);
      if (!key) continue;
      flat[key] = (Array.isArray(v) ? v.join(', ') : String(v ?? '')).trim();
    }
  }

  return flat;
}

/**
 * Read one logical field out of the flat map.
 *
 * Every alias is tried as an exact key before any is tried as a partial one,
 * so an exactly-named `name` field always beats a `company_name` that merely
 * contains it. A key that is present but empty is skipped rather than
 * returned, which is what lets a form carrying both `phone_number` (blank)
 * and `رقم_الهاتف` (filled) still produce a phone number.
 *
 * @param {Record<string,string>} flat
 * @param {string} field  a key of FIELD_ALIASES
 * @returns {string}
 */
export function readField(flat, field) {
  const matchers = ALIAS_MATCHERS[field];
  if (!matchers) throw new Error(`Unknown lead field: ${field}`);

  for (const { alias } of matchers) {
    if (flat[alias]) return flat[alias];
  }
  for (const { test } of matchers) {
    for (const key of Object.keys(flat)) {
      if (flat[key] && test(key)) return flat[key];
    }
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

  // A test delivery has placeholders in place of answers. Spotting it here,
  // before anything is validated, is what keeps it from being thrown away as
  // a malformed lead.
  const isTest = Object.values(flat).some(isTestValue);
  const real = (value) => (isTestValue(value) ? '' : value);

  const fullName = real(readField(flat, 'fullName'));
  const phone = real(readField(flat, 'phone'));
  const email = real(readField(flat, 'email'));
  const courseRaw = real(readField(flat, 'course'));
  const branchRaw = real(readField(flat, 'branch'));
  const countryRaw = real(readField(flat, 'country'));

  const [branch, course] = await Promise.all([resolveBranch(branchRaw), resolveCourse(courseRaw)]);

  return {
    fullName: fullName || (isTest ? 'Test lead' : 'Unnamed lead'),
    // Arabic-Indic digits are rewritten here as well as in the model's setter:
    // the raw value is compared and logged before it ever reaches the setter.
    phone: toWesternDigits(phone),
    email: email || undefined,
    courseRaw: courseRaw || undefined,
    branchRaw: branchRaw || undefined,
    countryRaw: countryRaw || undefined,
    course: course?._id,
    branch: branch?._id,
    isTest,
    flat,
  };
}
