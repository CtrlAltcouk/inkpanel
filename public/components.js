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
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
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
