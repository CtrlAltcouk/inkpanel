// Pure route-resolution logic, kept free of DOM access so it stays testable
// under node:test. app.js is the DOM-facing shell that calls this.

// Resolves a location.hash value to a known route name, falling back to
// `fallbackName` for an empty hash or one that names no route. Callers must
// use the *resolved* name (not the raw hash) for anything user-visible —
// e.g. highlighting the active tab — otherwise an unrecognised hash like
// "#foo" resolves its content to the fallback but leaves the highlight
// pointing at a route that was never rendered.
export function resolveRouteName(hash, routes, fallbackName) {
  const requested = (hash || '').replace(/^#/, '') || fallbackName;
  return Object.prototype.hasOwnProperty.call(routes, requested) ? requested : fallbackName;
}
