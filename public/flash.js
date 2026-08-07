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

/**
 * Fetch a firmware image as the binary string esptool-js expects.
 *
 * Not TextDecoder: this is binary, and any decoding would corrupt bytes above
 * 0x7F. Chunked because a naive String.fromCharCode(...bytes) on a megabyte
 * image overflows the call stack.
 */
export async function fetchBinary(name) {
  const res = await fetch(`/api/firmware/bin/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`could not download ${name} (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return out;
}

/**
 * True only for a genuine ESP32-S3 chip-identification string. Anything else
 * (a different chip family, or no chip yet) must stop the flow before any
 * write is attempted — a mismatched write is exactly the kind of mistake
 * that leaves a board needing manual recovery.
 */
export function isEsp32S3(chip) {
  return /ESP32-S3/i.test(String(chip));
}

/**
 * The 'erase' radio value is the only input that erases the board. Every
 * other value — including "preserve", a missing selection, or anything
 * unrecognised — must preserve the NVS partition (the board's Wi-Fi
 * credentials). Getting this backwards would silently wipe Wi-Fi setup on a
 * routine firmware update, so this stays a single, explicit equality check
 * rather than a "not preserve" negation.
 */
export function shouldErase(modeValue) {
  return modeValue === 'erase';
}

/**
 * Turn the manifest's parts into the {address, data} pairs esptool-js's
 * writeFlash wants. Addresses always come from manifest.offset — set at
 * build time — and never from a constant in this file, so the two cannot
 * silently drift apart.
 */
export async function buildFlashParts(parts, fetchBinaryFn = fetchBinary) {
  return Promise.all(
    parts.map(async (part) => ({
      address: part.offset,
      data: await fetchBinaryFn(part.path),
    })),
  );
}

/**
 * Every one of these is a case a person will actually hit. A raw exception
 * string here reads as "the tool is broken" when the real answer is usually
 * one sentence long.
 */
export function explainFailure(err) {
  const message = String(err?.message ?? err);

  // Cancelling the port picker is a normal thing to do, not a failure.
  if (err?.name === 'NotFoundError' || /No port selected/i.test(message)) {
    return 'Cancelled — no board selected.';
  }
  if (/already open|in use|Failed to open serial port/i.test(message)) {
    return 'That port is already in use. Close the Arduino IDE serial monitor ' +
           '(or any other serial tool) and try again — only one program can hold a port.';
  }
  if (/Failed to connect|Timed out waiting for packet|invalid head of packet/i.test(message)) {
    return 'Could not put the board into flashing mode. Hold the BOOT button, ' +
           'tap RESET, release BOOT, then try again.';
  }
  if (/only flashes ESP32-S3/i.test(message)) {
    return message;
  }
  // A failed write is recoverable and saying so matters: the instinct is to
  // assume a half-written board is bricked. The ROM bootloader lives in mask
  // ROM and no flash write can damage it.
  return `${message}\n\nThe board is not damaged — the bootloader it starts from ` +
         'cannot be overwritten. Hold BOOT, tap RESET, and flash again.';
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

  const button = root.querySelector('[data-connect]');
  const log = root.querySelector('.flash-log');

  const write = (line) => {
    log.hidden = false;
    log.textContent += `${line}\n`;
    log.scrollTop = log.scrollHeight;
  };

  button.addEventListener('click', async () => {
    button.disabled = true;
    log.hidden = false;
    log.textContent = '';

    let transport = null;
    try {
      // The browser's own port picker. This dialog is the real consent step:
      // a page cannot reach a serial port without the user choosing it here.
      const port = await navigator.serial.requestPort();

      // esptool-js is ~380KB. Importing it here — only once a user has
      // actually picked a port — keeps it out of the page for every visitor
      // to this tab who never clicks Connect, instead of a top-level import
      // that would load it for everyone.
      const { ESPLoader, Transport } = await import('./vendor/esptool-js.js');
      transport = new Transport(port, true);

      const loader = new ESPLoader({
        transport,
        baudrate: 921600,
        romBaudrate: 115200,
        terminal: { clean: () => {}, writeLine: write, write: () => {} },
      });

      const chip = await loader.main();
      write(`Detected ${chip}`);
      if (!isEsp32S3(chip)) {
        throw new Error(`This tool only flashes ESP32-S3 boards, but found ${chip}.`);
      }

      const erase = shouldErase(root.querySelector('input[name=mode]:checked').value);
      if (erase) {
        // The one explicit extra step. A normal write leaves the NVS partition
        // alone, which is why "preserve" needs no special handling at all.
        write('Erasing flash — this takes a moment...');
        await loader.eraseFlash();
      }

      const parts = await buildFlashParts(manifest.parts);

      write(`Writing ${parts.length} images...`);
      await loader.writeFlash({
        fileArray: parts,
        flashSize: 'keep',
        eraseAll: false,
        compress: true,
        reportProgress: (index, written, total) => {
          write(`  image ${index + 1}: ${Math.round((written / total) * 100)}%`);
        },
      });

      await loader.after();
      write(erase
        ? 'Done. The board will restart and ask for Wi-Fi again.'
        : 'Done. The board will restart and reconnect on its own.');
    } catch (err) {
      write(`\n${explainFailure(err)}`);
    } finally {
      // Always release the port: leaving it held means the next attempt fails
      // with "port already in use" caused by this page itself.
      try { await transport?.disconnect(); } catch { /* already gone */ }
      button.disabled = false;
    }
  });
}
