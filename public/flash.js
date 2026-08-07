// Flash tab: writes firmware to a board over USB using WebSerial.
//
// WebSerial only exists in a *secure context* — HTTPS or localhost. inkpanel
// normally runs on plain HTTP over the LAN, where `navigator.serial` is
// simply undefined. That is not a browser-support problem and must not be
// reported as one: it has a different cause and a different fix, so the two
// cases are distinguished below.
import { getJson } from './api.js';
import { esc } from './components.js';

const HTTPS_PORT = 8443;

/** Chromium exposes WebSerial; Firefox and Safari have declined to implement it. */
export function serialSupported() {
  return 'serial' in navigator;
}

export function httpsUrl() {
  const url = new URL(window.location.href);
  url.protocol = 'https:';
  url.port = String(HTTPS_PORT);
  return url.toString();
}

/**
 * UA sniffing is normally the wrong tool for the job — feature detection is
 * almost always better. It does not work here: `navigator.serial` is
 * undefined in *both* of the situations this module needs to tell apart (an
 * unsupported browser, and an unsupported context on a browser that would
 * otherwise support WebSerial), so there is no feature left to detect. The
 * origin's secure-context state alone cannot separate them — only the
 * browser family can, which is the one thing left to check.
 */
function looksLikeChromiumFamily() {
  const ua = navigator.userAgent || '';
  return /Chrome\/|Chromium\/|Edg\//.test(ua) && !/Firefox\//.test(ua);
}

export function unsupportedNotice() {
  // An insecure context and an unsupported browser both leave navigator.serial
  // undefined, but only one of them is fixable by changing the URL — and that
  // is only true for a browser that would support WebSerial given a secure
  // context. A Firefox/Safari user on plain HTTP needs a different browser,
  // not a different URL, so the HTTPS-redirect branch is gated on the browser
  // family too.
  if (window.isSecureContext === false && looksLikeChromiumFamily()) {
    const target = httpsUrl();
    return `<div class="card">
      <h3>Flashing needs a secure connection</h3>
      <p>Browsers only allow USB access over HTTPS. This page is on plain HTTP,
         so the flashing tools are unavailable here.</p>
      <p><a href="${esc(target)}">Open inkpanel over HTTPS</a> and come back to this tab.</p>
      <p class="meta">The certificate is self-signed, so your browser will warn you once.
         That is expected on a local network.</p>
    </div>`;
  }

  return `<div class="card">
    <h3>This browser cannot flash boards</h3>
    <p>Flashing uses WebSerial, which is available in Chrome, Edge, Brave and Opera.
       Firefox and Safari do not support it.</p>
  </div>`;
}

export function noBuildNotice() {
  return `<div class="card">
    <h3>No firmware has been built</h3>
    <p>Run the build script on the machine holding the repository, then reload:</p>
    <pre><code>./scripts/build-firmware.sh</code></pre>
    <p class="meta">The server never compiles firmware itself — it only serves what that script produced.</p>
  </div>`;
}

export function readyPanel(manifest) {
  return `<div class="card">
    <h3>Flash a panel</h3>
    <p class="meta">Firmware ${esc(manifest.version)} &middot; built ${esc(manifest.builtAt)}</p>

    <fieldset class="flash-mode">
      <legend>What to write</legend>
      <label>
        <input type="radio" name="mode" value="preserve" checked>
        <span>Update firmware only <em>&mdash; keeps the board's Wi-Fi settings</em></span>
      </label>
      <label>
        <input type="radio" name="mode" value="erase">
        <span>Erase everything <em>&mdash; the board will ask for Wi-Fi again on next boot</em></span>
      </label>
    </fieldset>

    <p class="meta">Close the Arduino IDE serial monitor first if it is open &mdash;
       only one program can use the port at a time.</p>

    <button type="button" data-connect>Connect a board</button>
    <div class="flash-log" hidden></div>
  </div>`;
}

export async function renderFlash(root) {
  if (!serialSupported()) {
    root.innerHTML = unsupportedNotice();
    return;
  }

  const manifest = await getJson('/api/firmware/manifest');
  if (!manifest.available) {
    root.innerHTML = noBuildNotice();
    return;
  }

  root.innerHTML = readyPanel(manifest);
  // Task 6 wires the Connect button. Until then it is deliberately inert
  // rather than half-working.
}
