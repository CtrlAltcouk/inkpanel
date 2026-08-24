/** Browser base path for standalone `/` or a Home Assistant Ingress prefix. */
function currentPathname() {
  return globalThis.location?.pathname ?? globalThis.window?.location?.pathname ?? '/';
}

export function browserBasePath(pathname = currentPathname()) {
  if (!pathname.startsWith('/')) return '/';
  if (pathname.endsWith('/')) return pathname;
  const slash = pathname.lastIndexOf('/');
  return `${pathname.slice(0, slash + 1)}`;
}

/** Resolve an application-root path without escaping an Ingress prefix. */
export function appPath(path, pathname = currentPathname()) {
  const relative = String(path).replace(/^\/+/, '');
  return `${browserBasePath(pathname)}${relative}`;
}
