/**
 * Small, dependency-free sanitizers shared by the dashboard.
 *
 * They are exported as pure functions so they can be unit tested from the
 * backend test suite (see backend/tests/frontend-sanitize.test.ts).
 */

const HTML_ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
};

/**
 * Escapes a value for safe interpolation into HTML text *and* quoted
 * attribute values.
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]);
}

/**
 * Only absolute https URLs are allowed to become clickable links.
 * Returns an empty string for anything else (javascript:, data:, http:, ...).
 */
export function sanitizeUrl(value) {
  if (value === null || value === undefined) return '';
  const raw = String(value).trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return '';
    if (!url.hostname) return '';
    return url.href;
  } catch {
    return '';
  }
}

/** True when a value can safely be rendered as an href. */
export function isSafeUrl(value) {
  return sanitizeUrl(value).length > 0;
}
