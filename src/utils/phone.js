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
export function normalizePhone(input) {
  if (!input) return '';

  let digits = String(input).replace(/\D/g, '');
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
