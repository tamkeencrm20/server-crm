import { DEFAULT_COUNTRY_CODE } from '../config/constants.js';

/**
 * Normalise a phone number to bare E.164 digits (no "+"), assuming UAE when
 * no country code is present. Meta hands numbers over in wildly inconsistent
 * shapes ("+971 50 123 4567", "0501234567", "00971501234567"), and lead
 * de-duplication is only as good as this function.
 *
 * @param {string} input
 * @returns {string} digits only, or '' when nothing usable was given
 */
/**
 * Rewrite Arabic-Indic digits as the Western ones JavaScript can read.
 *
 * A phone typed on an Arabic keyboard arrives as ٠٥٠١٢٣٤٥٦٧٨, and `\D`
 * treats every one of those as a non-digit — so the number was stripped down
 * to nothing and the lead was rejected for having no phone at all. Both the
 * Arabic-Indic block (U+0660) and the Extended Arabic-Indic block (U+06F0)
 * used by Persian and Urdu keyboards are handled.
 *
 * @param {string} input
 * @returns {string}
 */
export function toWesternDigits(input) {
  if (input === null || input === undefined) return '';
  return String(input).replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

export function normalizePhone(input) {
  if (!input) return '';

  let digits = toWesternDigits(input).replace(/\D/g, '');
  if (!digits) return '';

  // 00971... -> 971...
  if (digits.startsWith('00')) digits = digits.slice(2);

  // Already carries the UAE code.
  if (digits.startsWith(DEFAULT_COUNTRY_CODE)) return digits;

  // Local UAE shape: 0501234567 -> 971501234567
  if (digits.startsWith('0')) return DEFAULT_COUNTRY_CODE + digits.slice(1);

  // Bare UAE mobile/landline (9 digits, e.g. 501234567).
  if (digits.length === 9) return DEFAULT_COUNTRY_CODE + digits;

  // Anything else is assumed to already include its own country code.
  return digits;
}

/** Pretty form for display: 971501234567 -> +971 50 123 4567 */
export function formatPhone(normalized) {
  if (!normalized) return '';
  if (!normalized.startsWith(DEFAULT_COUNTRY_CODE)) return `+${normalized}`;
  const rest = normalized.slice(DEFAULT_COUNTRY_CODE.length);
  const m = rest.match(/^(\d{2})(\d{3})(\d{4})$/);
  return m ? `+${DEFAULT_COUNTRY_CODE} ${m[1]} ${m[2]} ${m[3]}` : `+${normalized}`;
}
