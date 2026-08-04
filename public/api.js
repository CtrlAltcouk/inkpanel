export class ApiError extends Error {
  constructor(message, status, issues) {
    super(message);
    this.status = status;
    this.issues = issues ?? [];
  }
}

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  // A 401 means the password was set, or the session expired. Either way the
  // only useful action is to send the user to sign in.
  if (res.status === 401) {
    location.href = '/login.html';
    throw new ApiError('authentication required', 401);
  }

  if (!res.ok) {
    const problem = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(problem.error ?? res.statusText, res.status, problem.issues);
  }

  return res.status === 204 ? null : res.json();
}

export const getJson = (path) => request('GET', path);
export const sendJson = (method, path, body) => request(method, path, body);
