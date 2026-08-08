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
const USB_BAUD = 115200;
const PROVISION_READY = 'INKPANEL_READY_V1';
const PROVISION_SAVED = 'INKPANEL_SAVED_V1';
const PROVISION_ERROR = 'INKPANEL_ERROR_V1|';
const PROVISION_PREFIX = 'INKPANEL_PROVISION_V1|';

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
 * Fetch a firmware image as a byte-preserving binary string.
 *
 * The historical tests and manifest helper use this representation, so it is
 * kept at the HTTP boundary. prepareFlashParts() converts it to Uint8Array
 * immediately before esptool-js sees it; passing the string directly to the
 * compressor would UTF-8-expand bytes above 0x7F.
 */
export async function fetchBinary(name) {
  const res = await fetch(`/api/firmware/bin/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`could not download ${name} (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  // esptool-js silently continues past zero-length images. Refuse them here
  // rather than reporting a successful flash that cannot boot.
  if (bytes.length === 0) {
    throw new Error(
      `${name} is empty. Rebuild the firmware — flashing this would silently skip it and leave the board unbootable.`,
    );
  }

  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return out;
}

/** True only for a genuine ESP32-S3 chip-identification string. */
export function isEsp32S3(chip) {
  return /ESP32-S3/i.test(String(chip));
}

/**
 * Kept deliberately narrow for backwards compatibility: this helper answers
 * only whether the explicit factory-reset radio value was chosen. New-board
 * setup also performs a full erase, but that is a separate product mode and
 * is handled explicitly in renderFlash().
 */
export function shouldErase(modeValue) {
  return modeValue === 'erase';
}

/**
 * Select the image set appropriate to the requested operation.
 *
 * `parts` is the full install/recovery set (normally merged.bin). A routine
 * update MUST use updateParts, which contains only bootloader/partition/app
 * regions and therefore cannot erase the NVS credentials partition.
 */
export function selectFlashManifestParts(manifest, modeValue) {
  if (modeValue === 'preserve') {
    if (!Array.isArray(manifest.updateParts) || manifest.updateParts.length === 0) {
      throw new Error(
        'This firmware build does not contain the safe update image set. Rebuild firmware on the server before updating. Refusing to use the full image because it would erase Wi-Fi settings.',
      );
    }
    return manifest.updateParts;
  }

  if (!Array.isArray(manifest.parts) || manifest.parts.length === 0) {
    throw new Error('This firmware build contains no install images. Rebuild firmware on the server.');
  }
  return manifest.parts;
}

/** Turn manifest entries into the {address, data} pairs esptool-js wants. */
export async function buildFlashParts(parts, fetchBinaryFn = fetchBinary) {
  return Promise.all(
    parts.map(async (part) => ({
      address: part.offset,
      data: await fetchBinaryFn(part.path),
    })),
  );
}

/**
 * Convert downloaded firmware into the exact byte arrays esptool-js 0.6.x
 * expects, and sanity-check the image that will live at flash address 0.
 *
 * The downloader historically returns a "binary string" (one JS character
 * per byte). That is reversible while every character is <= 0xFF, but passing
 * the string directly to writeFlash is not safe: pako treats it as text and
 * UTF-8 encodes bytes above 0x7F. The first ESP image byte 0xE9 therefore
 * becomes 0xC3 0xA9 — exactly the corruption that produces
 * "invalid header: 0x0203a9c3" on boot.
 */
export function prepareFlashParts(parts) {
  const prepared = parts.map((part, index) => {
    let data;

    if (part.data instanceof Uint8Array) {
      data = part.data;
    } else if (typeof part.data === 'string') {
      data = new Uint8Array(part.data.length);
      for (let i = 0; i < part.data.length; i += 1) {
        const value = part.data.charCodeAt(i);
        if (value > 0xff) {
          throw new Error(
            `firmware image ${index + 1} contains a non-binary character at byte ${i}; refusing to flash`,
          );
        }
        data[i] = value;
      }
    } else {
      throw new Error(`firmware image ${index + 1} is not binary data; refusing to flash`);
    }

    return { address: part.address, data };
  });

  const bootImage = prepared.find((part) => Number(part.address) === 0);
  if (bootImage) {
    const magic = bootImage.data[0];
    if (magic !== 0xe9) {
      const first = Array.from(bootImage.data.slice(0, 4))
        .map((value) => value.toString(16).padStart(2, '0'))
        .join(' ')
        .toUpperCase();
      throw new Error(
        `firmware image at 0x0 has invalid ESP header ${first || '(empty)'}; expected E9 as the first byte. Refusing to flash.`,
      );
    }
  }

  return prepared;
}

function utf8Length(value) {
  return new TextEncoder().encode(value).length;
}

/** Validate and normalise the values that will be written into panel NVS. */
export function validateNewBoardConfig(config) {
  const ssid = String(config?.ssid ?? '');
  const password = String(config?.password ?? '');
  const serverUrl = String(config?.serverUrl ?? '').trim().replace(/\/+$/, '');

  if (!ssid) throw new Error('Enter the Wi-Fi network name (SSID).');
  if (utf8Length(ssid) > 32) throw new Error('Wi-Fi network name is longer than the ESP32 32-byte limit.');
  if (utf8Length(password) > 64) throw new Error('Wi-Fi password is longer than the ESP32 64-byte limit.');
  if (!serverUrl) throw new Error('InkPanel server address is missing.');
  if (utf8Length(serverUrl) > 127) throw new Error('InkPanel server address is too long for the panel.');

  let parsed;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new Error('InkPanel server address is not a valid URL.');
  }
  if (parsed.protocol !== 'http:') {
    throw new Error('Panel server address must begin with http://. HTTPS is only for the browser Flash page.');
  }
  if (!parsed.hostname) throw new Error('InkPanel server address must include a host or IPv4 address.');

  return { ssid, password, serverUrl };
}

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x4000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x4000));
  }
  return btoa(binary);
}

/** Build the one-line protocol record understood by Provisioning.cpp. */
export function buildProvisionCommand(config) {
  const checked = validateNewBoardConfig(config);
  return `${PROVISION_PREFIX}${base64Utf8(checked.ssid)}|${base64Utf8(checked.password)}|${base64Utf8(checked.serverUrl)}\n`;
}

function portInfo(port) {
  try { return port?.getInfo?.() ?? {}; } catch { return {}; }
}

function sameUsbIdentity(a, b) {
  const left = portInfo(a);
  const right = portInfo(b);
  if (a === b) return true;
  return left.usbVendorId !== undefined && left.usbProductId !== undefined &&
    left.usbVendorId === right.usbVendorId && left.usbProductId === right.usbProductId;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Native USB briefly disappears while the freshly-flashed ESP32-S3 resets.
 * Re-open the port the user already granted rather than asking for another
 * picker gesture. If Chromium re-created the SerialPort object during USB
 * re-enumeration, use the one authorised matching device from getPorts().
 */
export async function reopenProvisioningPort(originalPort, timeoutMs = 18000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    const granted = typeof navigator.serial.getPorts === 'function'
      ? await navigator.serial.getPorts()
      : [];
    const matching = granted.filter((candidate) => sameUsbIdentity(candidate, originalPort));
    const candidates = [originalPort, ...matching.filter((candidate) => candidate !== originalPort)];

    // If there are multiple identical authorised boards, the original object
    // remains first. We deliberately do not pick an unrelated board merely
    // because it has the same USB VID/PID.
    for (const candidate of candidates) {
      try {
        await candidate.open({ baudRate: USB_BAUD });
        return candidate;
      } catch (err) {
        lastError = err;
      }
    }
    await sleep(400);
  }

  throw new Error(
    `The firmware was flashed, but the board did not reappear for USB setup${lastError ? ` (${lastError.message ?? lastError})` : ''}. Unplug and reconnect it, then use Set up a new board again.`,
  );
}

/**
 * Wait for the new firmware's USB setup window, send credentials, and wait for
 * an explicit NVS-save acknowledgement. The password is never written to the
 * InkPanel log or server; it travels directly from this browser to the board.
 */
export async function provisionNewBoard(originalPort, config, write = () => {}, timeoutMs = 30000) {
  const checked = validateNewBoardConfig(config);
  const command = buildProvisionCommand(checked);
  const port = await reopenProvisioningPort(originalPort, Math.min(timeoutMs, 18000));

  const reader = port.readable.getReader();
  const writer = port.writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let commandSent = false;
  let timer;

  const exchange = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('USB setup channel closed before the board confirmed its settings.');
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);

        if (line === PROVISION_READY && !commandSent) {
          write('Board firmware is ready — sending Wi-Fi and server settings...');
          await writer.write(encoder.encode(command));
          commandSent = true;
        } else if (line === PROVISION_SAVED) {
          write('Board saved its settings.');
          return;
        } else if (line.startsWith(PROVISION_ERROR)) {
          throw new Error(`Board rejected setup settings: ${line.slice(PROVISION_ERROR.length)}`);
        }
      }
    }
  })();

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { reader.cancel(); } catch { /* best effort */ }
      reject(new Error('USB provisioning timed out before the board confirmed its settings.'));
    }, timeoutMs);
  });

  try {
    await Promise.race([exchange, timeout]);
  } finally {
    clearTimeout(timer);
    try { await reader.cancel(); } catch { /* already closed */ }
    reader.releaseLock();
    writer.releaseLock();
    try { await port.close(); } catch { /* board may already be moving on */ }
  }
}

/** User-facing classification for common WebSerial/esptool failures. */
export function explainFailure(err) {
  const message = String(err?.message ?? err);

  if (err?.name === 'NotFoundError' || /No port selected/i.test(message)) {
    return 'Cancelled — no board selected.';
  }
  if (/already open|in use|Failed to open serial port/i.test(message)) {
    return 'That port is already in use. Close the Arduino IDE serial monitor ' +
           '(or any other serial tool) and try again — only one program can hold a port.';
  }
  if (/Failed to connect|Timed out waiting for packet|invalid head of packet/i.test(message)) {
    return 'Could not put the board into flashing mode automatically. Unplug and reconnect the board and try again. ' +
           'BOOT/RESET is only a recovery fallback if automatic flashing repeatedly fails.';
  }
  if (/Failed to write.*data to flash after seq \d+ failed with status/i.test(message)) {
    return `${message}\n\nThe board is not damaged — this is the connection dropping ` +
           'a beat partway through writing, not a bootloader problem. Plug directly into ' +
           "the computer's own USB port rather than a hub or extension cable, keep this " +
           'tab in the foreground and the computer awake while it writes, then try again.';
  }
  if (/only flashes ESP32-S3/i.test(message)) return message;
  if (/USB provisioning|USB setup channel|did not reappear/i.test(message)) {
    return `${message}\n\nThe firmware flash itself completed. Reconnect the same board and run Set up a new board again.`;
  }

  return `${message}\n\nThe board is not damaged — the bootloader it starts from ` +
         'cannot be overwritten. It is safe to try again.';
}

export function readyPanel(manifest) {
  const serverUrl = esc(String(manifest.serverUrl ?? ''));
  return `<div class="card">
    <h3>Flash a panel</h3>
    <p class="meta">Firmware ${esc(manifest.version)} &middot; built ${esc(manifest.builtAt)}</p>

    <fieldset class="flash-mode">
      <legend>What do you want to do?</legend>
      <label>
        <input type="radio" name="mode" value="preserve" checked>
        <span><strong>Update existing board</strong> <em>&mdash; keeps Wi-Fi and server settings</em></span>
      </label>
      <label>
        <input type="radio" name="mode" value="new">
        <span><strong>Set up a new board</strong> <em>&mdash; erase, flash and configure it over USB</em></span>
      </label>
      <label>
        <input type="radio" name="mode" value="erase">
        <span><strong>Factory reset / recover</strong> <em>&mdash; erase everything and return to setup mode</em></span>
      </label>
    </fieldset>

    <div class="new-board-setup" data-new-board-fields hidden>
      <h3>New board settings</h3>
      <p class="notice">These details go directly from this browser to the ESP32 over USB. The Wi-Fi password is not sent to the InkPanel server.</p>
      <label>Wi-Fi network name (SSID)</label>
      <input type="text" data-new-ssid autocomplete="off" spellcheck="false" placeholder="Your Wi-Fi name">
      <label>Wi-Fi password</label>
      <input type="password" data-new-password autocomplete="new-password" placeholder="Leave blank for an open network">
      <label>InkPanel server</label>
      <input type="text" data-new-server value="${serverUrl}" autocapitalize="off" autocorrect="off" spellcheck="false">
      <p class="meta">Filled automatically from this InkPanel installation. Panels use the HTTP address, even though this Flash page uses HTTPS.</p>
    </div>

    <p class="meta">Close the Arduino IDE serial monitor first if it is open &mdash;
       only one program can use the port at a time.</p>

    <button type="button" data-connect>Connect a board</button>
    <div class="flash-log" hidden></div>
  </div>`;
}

function newBoardConfigFromUi(root) {
  return validateNewBoardConfig({
    ssid: root.querySelector('[data-new-ssid]')?.value ?? '',
    password: root.querySelector('[data-new-password]')?.value ?? '',
    serverUrl: root.querySelector('[data-new-server]')?.value ?? '',
  });
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
  const newFields = root.querySelector('[data-new-board-fields]');

  const write = (line) => {
    log.hidden = false;
    log.textContent += `${line}\n`;
    log.scrollTop = log.scrollHeight;
  };

  const selectedMode = () => root.querySelector('input[name=mode]:checked')?.value ?? 'preserve';
  const syncModeUi = () => {
    const mode = selectedMode();
    if (newFields) newFields.hidden = mode !== 'new';
    if (button) button.textContent = mode === 'new' ? 'Flash & configure new board' : 'Connect a board';
  };
  root.querySelectorAll?.('input[name=mode]').forEach((radio) => radio.addEventListener('change', syncModeUi));
  syncModeUi();

  button.addEventListener('click', async () => {
    button.disabled = true;
    log.hidden = false;
    log.textContent = '';

    const mode = selectedMode();
    let newConfig = null;
    if (mode === 'new') {
      try {
        newConfig = newBoardConfigFromUi(root);
      } catch (err) {
        write(explainFailure(err));
        button.disabled = false;
        return;
      }
    }

    let transport = null;
    try {
      // No BOOT-button choreography is required for the normal XIAO ESP32-S3
      // flow. esptool-js toggles the native USB reset lines automatically.
      const port = await navigator.serial.requestPort();

      // esptool-js is ~380KB. Load it only after the user has selected a port.
      const { ESPLoader, Transport } = await import('./vendor/esptool-js.js');
      transport = new Transport(port, true);

      const loader = new ESPLoader({
        transport,
        // Keep these equal on the XIAO's native USB connection. A baud change
        // adds no throughput here and previously destabilised a real flash.
        baudrate: 115200,
        romBaudrate: 115200,
        terminal: { clean: () => {}, writeLine: write, write: () => {} },
      });

      const chip = await loader.main();
      write(`Detected ${chip}`);
      if (!isEsp32S3(chip)) {
        throw new Error(`This tool only flashes ESP32-S3 boards, but found ${chip}.`);
      }

      const fullErase = mode === 'new' || shouldErase(mode);
      if (fullErase) {
        write('Erasing flash — this takes a moment...');
        await loader.eraseFlash();
      }

      const manifestParts = selectFlashManifestParts(manifest, mode);
      const parts = prepareFlashParts(await buildFlashParts(manifestParts));

      write(`Writing ${parts.length} image${parts.length === 1 ? '' : 's'}...`);
      await loader.writeFlash({
        fileArray: parts,
        flashSize: 'keep',
        eraseAll: false,
        // Full merged installs are mostly 0xFF padding; compression makes them
        // practical. updateParts also work through the same proven path.
        compress: true,
        reportProgress: (index, written, total) => {
          write(`  image ${index + 1}: ${Math.round((written / total) * 100)}%`);
        },
      });

      await loader.after();

      if (mode === 'new') {
        // esptool has finished with the port. Release it, let native USB
        // re-enumerate into the freshly flashed firmware, then open the same
        // authorised device as an ordinary 115200 CDC serial connection.
        try { await transport.disconnect(); } catch { /* reset may have closed it */ }
        transport = null;
        write('Firmware flashed successfully. Waiting for the new board to restart...');
        await provisionNewBoard(port, newConfig, write);
        write('Done. The board has its Wi-Fi and InkPanel server settings and will now join the network.');
      } else if (mode === 'erase') {
        write('Done. The board will restart in setup mode. You can flash it again with Set up a new board to configure it entirely over USB.');
      } else {
        write('Done. The board will restart and reconnect using its existing settings.');
      }
    } catch (err) {
      write(`\n${explainFailure(err)}`);
    } finally {
      try { await transport?.disconnect(); } catch { /* already gone */ }
      button.disabled = false;
    }
  });
}
