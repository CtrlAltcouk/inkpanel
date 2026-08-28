import { appPath } from './paths.js';
const form = document.getElementById('form');
const error = document.getElementById('error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.hidden = true;

  const res = await fetch(appPath('/api/auth/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('password').value }),
  });

  if (res.ok) {
    location.href = appPath('/');
    return;
  }
  const body = await res.json().catch(() => ({ error: res.statusText }));
  error.textContent = body.error ?? 'Sign in failed';
  error.hidden = false;
});
