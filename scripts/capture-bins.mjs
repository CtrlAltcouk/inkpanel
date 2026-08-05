#!/usr/bin/env node
/**
 * Capture a real Milton Keynes bin-collection response, to be saved as a test
 * fixture.
 *
 * This endpoint is undocumented — it is the API behind the council's own web
 * form. The `id` below is a form identifier baked into that form and can change
 * without notice. If this script starts failing, that is the first thing to
 * check.
 *
 * Run: node scripts/capture-bins.mjs <UPRN>
 */
const uprn = process.argv[2];
if (!uprn) {
  console.error('usage: node scripts/capture-bins.mjs <UPRN>');
  process.exit(1);
}

const SESSION_URL =
  'https://mycouncil.milton-keynes.gov.uk/authapi/isauthenticated' +
  '?uri=https%253A%252F%252Fmycouncil.milton-keynes.gov.uk%252Fen%252Fservice%252FWaste_Collection_Round_Checker' +
  '&hostname=mycouncil.milton-keynes.gov.uk&withCredentials=true';

const sessionRes = await fetch(SESSION_URL);
if (!sessionRes.ok) throw new Error(`session responded ${sessionRes.status}`);
// The session step sets cookies (PHPSESSID etc.) that the lookup step below
// requires. Without forwarding them, the lookup responds 403 with
// {"result":"logout"} even though `sid` itself is valid — discovered while
// capturing the fixture for this task.
const setCookies = sessionRes.headers.getSetCookie ? sessionRes.headers.getSetCookie() : [];
const cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ');
const sid = (await sessionRes.json())['auth-session'];
if (!sid) throw new Error('no auth-session in the session response');

const params = new URLSearchParams({
  id: '64d9feda3a507',
  repeat_against: '',
  noRetry: 'false',
  getOnlyTokens: 'undefined',
  log_id: '',
  app_name: 'AF-Renderer::Self',
  _: String(Date.now()),
  sid,
});

const res = await fetch(`https://mycouncil.milton-keynes.gov.uk/apibroker/runLookup?${params}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: 'https://mycouncil.milton-keynes.gov.uk/fillform/?iframe_id=fillform-frame-1&db_id=',
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  },
  body: JSON.stringify({ formValues: { 'Section 1': { uprnCore: { value: uprn } } } }),
});

if (!res.ok) throw new Error(`lookup responded ${res.status}`);
console.log(JSON.stringify(await res.json(), null, 2));
