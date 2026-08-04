export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatRelative(iso, now = new Date()) {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';

  const seconds = Math.round((now.getTime() - then) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';

  const label = relativeBucket(abs);
  // A future timestamp means the reporting device's clock is ahead of the
  // server's — plausible for battery firmware with no RTC sync. Trivial
  // skew still reads as "just now" (handled above), but anything past that
  // is shown as "in Xm/h/d" rather than being folded into "just now",
  // which would make an hour of skew indistinguishable from a fresh check-in.
  return seconds < 0 ? `in ${label}` : `${label} ago`;
}

// Picks the unit/value pair for a non-negative second count, rounding to the
// nearest whole unit. Rounding alone can push a value to the top of its
// bucket (3599s -> 60m, 86399s -> 24h); when that happens, bump to the next
// unit instead of displaying "60m" or "24h".
function relativeBucket(abs) {
  const minutes = Math.round(abs / 60);
  if (abs < 3600 && minutes < 60) return `${minutes}m`;

  const hours = Math.round(abs / 3600);
  if (abs < 86400 && hours < 24) return `${hours}h`;

  return `${Math.round(abs / 86400)}d`;
}

export function formatVolts(volts) {
  return typeof volts === 'number' ? `${volts.toFixed(2)} V` : 'unknown';
}

export function field(id, name, label, value, type = 'text') {
  const step = type === 'number' ? ' step="any"' : '';
  return `<label for="${esc(id)}-${name}">${esc(label)}</label>
    <input id="${esc(id)}-${name}" name="${name}" type="${type}"${step} value="${esc(value)}">`;
}

export function pill(text, modifier = '') {
  return `<span class="status ${modifier}">${esc(text)}</span>`;
}
