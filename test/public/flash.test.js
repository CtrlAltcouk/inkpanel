import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  serialSupported,
  httpsUrl,
  unsupportedNotice,
  noBuildNotice,
  readyPanel,
  renderFlash,
  isEsp32S3,
  shouldErase,
  buildFlashParts,
  fetchBinary,
  explainFailure,
} from '../../public/flash.js';

const FLASH_JS_PATH = fileURLToPath(new URL('../../public/flash.js', import.meta.url));

// navigator exists as a Node global (with only a getter, no setter), so it
// must be overridden with defineProperty rather than plain assignment, and
// restored the same way afterwards.
async function withNavigator(value, fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
}

// window has no Node global at all, so plain assignment/deletion is enough.
async function withWindow(value, fn) {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const original = globalThis.window;
  globalThis.window = value;
  try {
    return await fn();
  } finally {
    if (hadWindow) globalThis.window = original;
    else delete globalThis.window;
  }
}

async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// A minimal DOM stand-in for the one selector set renderFlash's click
// handler actually queries. Not a general DOM shim — just enough to drive
// the button's click listener and observe the log element, so the wiring
// around navigator.serial (cancel handling, error classification, idle
// return) can be exercised without a browser. Real hardware I/O inside the
// handler (Transport/ESPLoader) is untouched by this and stays unverified
// without a board.
function fakeRoot() {
  let html = '';
  const listeners = {};
  const button = {
    disabled: false,
    addEventListener(event, handler) { listeners[event] = handler; },
    async click() {
      if (listeners.click) await listeners.click();
    },
  };
  const log = { hidden: true, textContent: '', scrollTop: 0 };
  let modeValue = 'preserve';
  return {
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; },
    querySelector(selector) {
      if (selector === '[data-connect]') return button;
      if (selector === '.flash-log') return log;
      if (selector === 'input[name=mode]:checked') return { value: modeValue };
      return null;
    },
    button,
    log,
    setMode(value) { modeValue = value; },
  };
}

function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// Real user-agent strings, trimmed to the parts the regex cares about.
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0';

test('serialSupported reads navigator.serial, not just truthiness of navigator', async () => {
  await withNavigator({ serial: {} }, () => {
    assert.equal(serialSupported(), true);
  });
  await withNavigator({}, () => {
    assert.equal(serialSupported(), false);
  });
});

test('httpsUrl swaps to https and port 8443 but keeps host, path and hash', async () => {
  await withWindow({ location: { href: 'http://192.168.1.50:8080/#flash' } }, () => {
    assert.equal(httpsUrl(), 'https://192.168.1.50:8443/#flash');
  });
});

test('httpsUrl works from localhost too, for the case the link is copy-pasted', async () => {
  await withWindow({ location: { href: 'http://localhost:8080/#flash' } }, () => {
    assert.equal(httpsUrl(), 'https://localhost:8443/#flash');
  });
});

// This is the distinction the whole task exists to get right: an insecure
// HTTP context and a browser that lacks WebSerial both leave
// navigator.serial undefined, but only the first is fixed by an HTTPS link —
// and only for a browser that would support WebSerial given a secure
// context (Chrome/Edge/Chromium). This test pins the "Chrome + HTTP" quadrant.
test('an insecure HTTP context on a Chromium browser gets the HTTPS-redirect notice, never the unsupported-browser notice', async () => {
  await withNavigator({ userAgent: CHROME_UA }, () =>
    withWindow({ isSecureContext: false, location: { href: 'http://192.168.1.50:8080/#flash' } }, () => {
      const html = unsupportedNotice();
      assert.equal(occurrences(html, '<h3>Flashing needs a secure connection</h3>'), 1);
      assert.equal(occurrences(html, '<a href="https://192.168.1.50:8443/#flash">Open inkpanel over HTTPS</a>'), 1);
      assert.equal(occurrences(html, 'This browser cannot flash boards'), 0);
    }),
  );
});

// The "Firefox + HTTP" quadrant: this is the blind spot that shipped broken.
// isSecureContext is false here too, but Firefox would not gain WebSerial
// from an HTTPS link, so it must get the unsupported-browser message instead
// of being sent on a pointless trip to accept a self-signed cert warning.
test('an insecure HTTP context on Firefox gets the unsupported-browser notice, never the HTTPS-redirect notice', async () => {
  await withNavigator({ userAgent: FIREFOX_UA }, () =>
    withWindow({ isSecureContext: false, location: { href: 'http://192.168.1.50:8080/#flash' } }, () => {
      const html = unsupportedNotice();
      assert.equal(occurrences(html, '<h3>This browser cannot flash boards</h3>'), 1);
      assert.equal(occurrences(html, 'Flashing needs a secure connection'), 0);
      assert.equal(occurrences(html, '<a href'), 0);
    }),
  );
});

test('a secure context with no WebSerial support gets the unsupported-browser notice, never the HTTPS notice', async () => {
  await withWindow({ isSecureContext: true }, () => {
    const html = unsupportedNotice();
    assert.equal(occurrences(html, '<h3>This browser cannot flash boards</h3>'), 1);
    assert.equal(occurrences(html, 'Flashing needs a secure connection'), 0);
    // No link at all on this branch — there is no URL that fixes it.
    assert.equal(occurrences(html, '<a href'), 0);
  });
});

test('the HTTPS notice link target is escaped rather than interpolated raw', async () => {
  // The URL API itself percent-encodes `<`, `>` and `"` in a fragment, so a
  // hash built from those alone would look "safe" even with esc() missing —
  // that would make this test pass against broken code. An ampersand is not
  // percent-encoded by URL, so it is the character that actually
  // distinguishes an escaped link from a raw one here.
  await withNavigator({ userAgent: CHROME_UA }, () =>
    withWindow(
      { isSecureContext: false, location: { href: 'http://192.168.1.50:8080/#flash&reload=1' } },
      () => {
        const html = unsupportedNotice();
        assert.equal(occurrences(html, 'href="https://192.168.1.50:8443/#flash&amp;reload=1"'), 1);
        assert.equal(html.includes('href="https://192.168.1.50:8443/#flash&reload=1"'), false);
      },
    ),
  );
});

test('noBuildNotice names the exact build script and does not claim the server builds firmware', () => {
  const html = noBuildNotice();
  assert.equal(occurrences(html, '<h3>No firmware has been built</h3>'), 1);
  assert.equal(occurrences(html, '<code>./scripts/build-firmware.sh</code>'), 1);
});

test('readyPanel reports the manifest version and build time, and defaults to preserve mode', () => {
  const html = readyPanel({ version: '1.2.3', builtAt: '2026-08-06T10:00:00.000Z' });
  assert.equal(occurrences(html, 'Firmware 1.2.3 &middot; built 2026-08-06T10:00:00.000Z'), 1);

  // Exactly one radio is checked, and it is "preserve" — the erase option
  // must never be the accidental default.
  const checked = [...html.matchAll(/<input[^>]*\bchecked\b[^>]*>/g)];
  assert.equal(checked.length, 1);
  assert.match(checked[0][0], /value="preserve"/);

  assert.equal(occurrences(html, '<button type="button" data-connect>Connect a board</button>'), 1);
  assert.equal(occurrences(html, '<div class="flash-log" hidden></div>'), 1);
});

test('readyPanel escapes manifest fields rather than interpolating them raw', () => {
  const html = readyPanel({ version: '<script>alert(1)</script>', builtAt: '2026-08-06T10:00:00.000Z' });
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.equal(occurrences(html, '&lt;script&gt;alert(1)&lt;/script&gt;'), 1);
});

// "Firefox + HTTPS" quadrant: secure context, but the browser itself lacks
// WebSerial, so no URL change can help.
test('renderFlash shows the unsupported-browser notice and never calls the manifest API when WebSerial is simply absent', async () => {
  let fetchCalled = false;
  await withNavigator({ userAgent: FIREFOX_UA }, () =>
    withWindow({ isSecureContext: true }, () =>
      withFetch(
        async () => {
          fetchCalled = true;
          throw new Error('renderFlash must not fetch the manifest when WebSerial is unavailable');
        },
        async () => {
          const root = { innerHTML: '' };
          await renderFlash(root);
          assert.equal(occurrences(root.innerHTML, 'This browser cannot flash boards'), 1);
          assert.equal(fetchCalled, false);
        },
      ),
    ),
  );
});

// "Chrome + HTTP" quadrant: the browser would support WebSerial, but the
// origin is not a secure context, so the fix is the HTTPS link.
test('renderFlash shows the HTTPS-redirect notice when a Chromium browser lacks serial because the page is on plain HTTP', async () => {
  await withNavigator({ userAgent: CHROME_UA }, () =>
    withWindow({ isSecureContext: false, location: { href: 'http://192.168.1.50:8080/#flash' } }, async () => {
      const root = { innerHTML: '' };
      await renderFlash(root);
      assert.equal(occurrences(root.innerHTML, 'Flashing needs a secure connection'), 1);
      assert.equal(occurrences(root.innerHTML, 'https://192.168.1.50:8443/#flash'), 1);
      assert.equal(occurrences(root.innerHTML, 'This browser cannot flash boards'), 0);
    }),
  );
});

// "Firefox + HTTP" quadrant: this is the defect. Both isSecureContext is
// false and the browser lacks WebSerial, but only the unsupported-browser
// notice is correct — an HTTPS link would not give Firefox WebSerial.
test('renderFlash shows the unsupported-browser notice, not the HTTPS-redirect notice, for Firefox on plain HTTP', async () => {
  let fetchCalled = false;
  await withNavigator({ userAgent: FIREFOX_UA }, () =>
    withWindow({ isSecureContext: false, location: { href: 'http://192.168.1.50:8080/#flash' } }, () =>
      withFetch(
        async () => {
          fetchCalled = true;
          throw new Error('renderFlash must not fetch the manifest when WebSerial is unavailable');
        },
        async () => {
          const root = { innerHTML: '' };
          await renderFlash(root);
          assert.equal(occurrences(root.innerHTML, 'This browser cannot flash boards'), 1);
          assert.equal(occurrences(root.innerHTML, 'Flashing needs a secure connection'), 0);
          assert.equal(fetchCalled, false);
        },
      ),
    ),
  );
});

test('renderFlash shows the no-firmware notice when the manifest reports unavailable', async () => {
  await withNavigator({ serial: {} }, () =>
    withFetch(
      async () => ({ status: 200, ok: true, json: async () => ({ available: false }) }),
      async () => {
        const root = { innerHTML: '' };
        await renderFlash(root);
        assert.equal(occurrences(root.innerHTML, 'No firmware has been built'), 1);
      },
    ),
  );
});

test('renderFlash shows the ready panel with the manifest data when a build exists', async () => {
  await withNavigator({ serial: {} }, () =>
    withFetch(
      async () => ({
        status: 200,
        ok: true,
        json: async () => ({
          available: true,
          version: '1.0.0',
          builtAt: '2026-08-06T10:00:00.000Z',
          parts: [{ path: 'inkpanel.ino.bin', offset: 65536 }],
        }),
      }),
      async () => {
        const root = fakeRoot();
        await renderFlash(root);
        assert.equal(occurrences(root.innerHTML, '<h3>Flash a panel</h3>'), 1);
        assert.equal(occurrences(root.innerHTML, 'Firmware 1.0.0 &middot; built 2026-08-06T10:00:00.000Z'), 1);
      },
    ),
  );
});

// The one full-wiring path testable without a board: the port picker being
// cancelled happens entirely before any esptool-js/hardware call, so it can
// be driven end-to-end through the real click handler. Everything past
// requestPort() succeeding (Transport, ESPLoader, chip detection, erase,
// write) needs real WebSerial and is NOT covered here — see Task 7.
test('clicking Connect with a cancelled port picker returns to idle silently and touches nothing else', async () => {
  let binFetches = 0;
  await withNavigator(
    { serial: { requestPort: async () => { throw Object.assign(new Error('cancelled'), { name: 'NotFoundError' }); } } },
    () =>
      withFetch(
        async (url) => {
          if (String(url).includes('/api/firmware/bin/')) binFetches += 1;
          return {
            status: 200,
            ok: true,
            json: async () => ({
              available: true,
              version: '1.0.0',
              builtAt: '2026-08-06T10:00:00.000Z',
              parts: [{ path: 'inkpanel.ino.bin', offset: 65536 }],
            }),
          };
        },
        async () => {
          const root = fakeRoot();
          await renderFlash(root);
          await root.button.click();

          assert.equal(root.log.textContent.trim(), 'Cancelled — no board selected.');
          assert.equal(root.log.hidden, false);
          assert.equal(root.button.disabled, false); // re-enabled, not stuck
          assert.equal(binFetches, 0); // never got far enough to download a firmware image
        },
      ),
  );
});

// --- Task 6: the parts that can genuinely be unit-tested -------------------
//
// esptool-js's ESPLoader.main() talks to real hardware over WebSerial, which
// does not exist in Node — that half of the flashing flow is NOT YET
// VERIFIED ON HARDWARE and is left to the Task 7 manual checklist. What
// follows is the pure logic pulled out of the click handler so it can be
// checked without a board: chip-string classification, the erase/preserve
// switch, manifest-offset handling, binary fetching, and error classification.

// The esptool-js bundle is ~380KB. Loading it for every visitor to this tab —
// including the overwhelming majority who never click Connect — would be a
// real cost paid for nothing. This is a source-level check because the
// alternative (asserting it isn't in a stack trace, etc.) can't observe
// "when" a module was loaded from outside a browser network panel.
test('flash.js does not statically import the esptool-js vendor bundle at module top level', async () => {
  const source = await readFile(FLASH_JS_PATH, 'utf8');
  const staticImportPattern = /^\s*import\s+.*from\s+['"]\.\/vendor\/esptool-js\.js['"]/m;
  assert.equal(staticImportPattern.test(source), false,
    'esptool-js must not be a static top-level import — it must be loaded lazily via dynamic import()');
});

test('flash.js loads esptool-js via a dynamic import, so it is fetched only once a user connects', async () => {
  const source = await readFile(FLASH_JS_PATH, 'utf8');
  const dynamicImportPattern = /import\(\s*['"]\.\/vendor\/esptool-js\.js['"]\s*\)/;
  assert.equal(dynamicImportPattern.test(source), true,
    'expected a dynamic import(\'./vendor/esptool-js.js\') somewhere in the connect handler');
});

// A real flash failed mid-write with the chip's own ROM loader rejecting one
// block (see the explainFailure tests above for the exact error). Compressed
// writes ask the ROM stub to inflate on the fly, and its decompression buffer
// can starve if chunks don't arrive fast enough over WebSerial — a documented
// cause of exactly this failure shape. Source-level, matching the dynamic-
// import tests above: writeFlash() talks to real hardware and cannot be
// exercised without a board, so this pins the option rather than the outcome.
// ESPLoader.main() calls changeBaud() whenever baudrate !== romBaudrate, and
// the vendored bundle guards that call with nothing — it has
// usesUsbJtagSerial()/usesUsbOtg() detection but applies it only to reset
// sequences, never to the baud change. esptool.py skips the baud change
// entirely on native-USB chips. The XIAO ESP32-S3 is native USB, where the
// baud rate is a fiction (bytes move at USB speed regardless), so a
// renegotiation to 921600 bought no throughput and destabilised the link: a
// real flash died mid-transfer at block 36. Keeping these equal is what stops
// changeBaud() being reached at all.
test('the ESPLoader baudrate matches romBaudrate, so changeBaud() is never reached on a native-USB board', async () => {
  const source = await readFile(FLASH_JS_PATH, 'utf8');
  const ctorIdx = source.indexOf('new ESPLoader({');
  assert.ok(ctorIdx > -1, 'could not find the ESPLoader constructor call');
  const ctorBody = source.slice(ctorIdx, source.indexOf('});', ctorIdx));

  const baudrate = /(?<!rom)baudrate:\s*(\d+)/i.exec(ctorBody);
  const romBaudrate = /romBaudrate:\s*(\d+)/i.exec(ctorBody);
  assert.ok(baudrate, 'no baudrate found in the ESPLoader options');
  assert.ok(romBaudrate, 'no romBaudrate found in the ESPLoader options');
  assert.equal(
    baudrate[1],
    romBaudrate[1],
    'baudrate and romBaudrate must be equal, or ESPLoader.main() calls the unguarded changeBaud()',
  );
});

test('the writeFlash call disables compression, which is a known cause of mid-write failures over WebSerial', async () => {
  const source = await readFile(FLASH_JS_PATH, 'utf8');
  const writeFlashCallIdx = source.indexOf('loader.writeFlash({');
  assert.ok(writeFlashCallIdx > -1, 'could not find the writeFlash call');
  const closingIdx = source.indexOf('});', writeFlashCallIdx);
  const callBody = source.slice(writeFlashCallIdx, closingIdx);
  assert.match(callBody, /compress:\s*false/, 'compress must be false in the writeFlash options');
});

test('isEsp32S3 accepts real chip-identification strings for an S3', () => {
  assert.equal(isEsp32S3('ESP32-S3'), true);
  assert.equal(isEsp32S3('ESP32-S3 (revision v0.2)'), true);
  assert.equal(isEsp32S3('esp32-s3'), true); // case-insensitive, esptool-js is not consistent about casing
});

test('isEsp32S3 rejects every other chip family, including near-miss S-series names', () => {
  assert.equal(isEsp32S3('ESP32'), false);
  assert.equal(isEsp32S3('ESP32-C3'), false);
  assert.equal(isEsp32S3('ESP32-S2'), false);
  assert.equal(isEsp32S3('ESP8266'), false);
  assert.equal(isEsp32S3(undefined), false);
  assert.equal(isEsp32S3(''), false);
});

test('shouldErase is true only for the literal "erase" radio value', () => {
  assert.equal(shouldErase('erase'), true);
});

test('shouldErase defaults to preserving data for the "preserve" value and anything unexpected', () => {
  // These are exactly the values that must NOT trigger an erase: the normal
  // default value, a missing selection, and a garbled one. Getting this
  // backwards silently wipes a user's Wi-Fi credentials on a routine update.
  assert.equal(shouldErase('preserve'), false);
  assert.equal(shouldErase(undefined), false);
  assert.equal(shouldErase(''), false);
  assert.equal(shouldErase('ERASE'), false); // radio values are lowercase; do not case-fold this
});

test('buildFlashParts takes the write address from manifest.offset, never a hardcoded constant', async () => {
  // Offsets deliberately do NOT match any real ESP32 bootloader/partition
  // table/app layout, so a hardcoded fallback in the implementation would
  // show up immediately as a mismatch here.
  const parts = [
    { path: 'weird-a.bin', offset: 0x2222 },
    { path: 'weird-b.bin', offset: 0x555555 },
  ];
  const fetched = [];
  const fakeFetchBinary = async (path) => {
    fetched.push(path);
    return `data-for-${path}`;
  };

  const result = await buildFlashParts(parts, fakeFetchBinary);

  assert.deepEqual(result, [
    { address: 0x2222, data: 'data-for-weird-a.bin' },
    { address: 0x555555, data: 'data-for-weird-b.bin' },
  ]);
  assert.deepEqual(fetched, ['weird-a.bin', 'weird-b.bin']);
});

test('buildFlashParts preserves numeric offsets exactly rather than stringifying them', async () => {
  const result = await buildFlashParts([{ path: 'x.bin', offset: 65536 }], async () => 'x');
  assert.equal(typeof result[0].address, 'number');
  assert.equal(result[0].address, 65536);
});

test('fetchBinary requests the escaped firmware-name path under /api/firmware/bin/', async () => {
  let requestedUrl = null;
  await withFetch(
    async (url) => {
      requestedUrl = url;
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    },
    async () => {
      await fetchBinary('weird name & stuff.bin');
    },
  );
  assert.equal(requestedUrl, '/api/firmware/bin/weird%20name%20%26%20stuff.bin');
});

test('fetchBinary converts bytes to a binary string without corrupting bytes above 0x7F', async () => {
  const bytes = new Uint8Array([0x00, 0x41, 0x7f, 0x80, 0xff]);
  const result = await withFetch(
    async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer }),
    () => fetchBinary('image.bin'),
  );
  assert.equal(result.length, 5);
  const codes = [...result].map((ch) => ch.charCodeAt(0));
  assert.deepEqual(codes, [0x00, 0x41, 0x7f, 0x80, 0xff]);
});

test('fetchBinary chunks across the 0x8000-byte boundary without dropping or duplicating bytes', async () => {
  // A naive String.fromCharCode(...bytes) on an image this size overflows the
  // call stack; chunking must not lose the byte at the seam either.
  const size = 0x8000 * 2 + 10;
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = i % 256;

  const result = await withFetch(
    async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer }),
    () => fetchBinary('big.bin'),
  );

  assert.equal(result.length, size);
  // Check the seam at the first chunk boundary and the last byte, not just the start.
  assert.equal(result.charCodeAt(0x8000 - 1), (0x8000 - 1) % 256);
  assert.equal(result.charCodeAt(0x8000), 0x8000 % 256);
  assert.equal(result.charCodeAt(size - 1), (size - 1) % 256);
});

test('fetchBinary throws a message naming the file and status when the download fails', async () => {
  await assert.rejects(
    withFetch(
      async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }),
      () => fetchBinary('missing.bin'),
    ),
    /could not download missing\.bin \(404\)/,
  );
});

test('explainFailure reports a cancelled port picker as non-failure, by name', () => {
  const err = Object.assign(new Error('some message'), { name: 'NotFoundError' });
  assert.equal(explainFailure(err), 'Cancelled — no board selected.');
});

test('explainFailure reports a cancelled port picker as non-failure, by message text', () => {
  // Some browsers surface this as a plain Error rather than a named
  // NotFoundError, so the message text is checked independently of name.
  const err = new Error('No port selected by the user.');
  assert.equal(explainFailure(err), 'Cancelled — no board selected.');
});

test('explainFailure names "port already in use" for a held serial port, and blames the real cause', () => {
  const err = new Error('Failed to open serial port');
  const message = explainFailure(err);
  assert.match(message, /already in use/);
  assert.match(message, /Arduino IDE serial monitor/);
});

test('explainFailure gives BOOT/RESET instructions when the board never enters flashing mode', () => {
  const err = new Error('Timed out waiting for packet header');
  const message = explainFailure(err);
  assert.match(message, /Hold the BOOT button/);
});

test('explainFailure passes the chip-mismatch message through unchanged', () => {
  const err = new Error('This tool only flashes ESP32-S3 boards, but found ESP32-C3.');
  assert.equal(explainFailure(err), 'This tool only flashes ESP32-S3 boards, but found ESP32-C3.');
});

test('explainFailure falls back to a not-bricked reassurance for anything unrecognised', () => {
  const err = new Error('some completely unrelated failure');
  const message = explainFailure(err);
  assert.match(message, /some completely unrelated failure/);
  assert.match(message, /not damaged/);
});

// A real flash hit this: the board connected and entered flashing mode fine,
// then the chip's own ROM loader rejected one write block partway through
// (sequence 36 of the transfer, not the first). The message this used to
// fall through to told the user to "Hold BOOT, tap RESET" — bootloader-entry
// advice for a failure that happened well after the bootloader had already
// been entered successfully, actively pointing at the wrong fix.
test('explainFailure blames the connection, not the bootloader, for a mid-write rejection', () => {
  const err = new Error('Failed to write compressed data to flash after seq 36 failed with status 201,0');
  const message = explainFailure(err);
  assert.match(message, /not damaged/);
  assert.doesNotMatch(message, /Hold BOOT/i, 'the connection already worked once — this is not a bootloader-entry problem');
  assert.match(message, /USB port/i);
});

test('explainFailure does not misclassify a bootloader-entry failure as a mid-write one', () => {
  // Pins the boundary between the two: this shape must still get BOOT/RESET
  // instructions, not the write-failure message that immediately follows it
  // in the function.
  const err = new Error('Timed out waiting for packet header');
  const message = explainFailure(err);
  assert.match(message, /Hold the BOOT button/);
  assert.doesNotMatch(message, /USB port/i);
});

test('explainFailure does not classify an unrelated error as the port-in-use case', () => {
  // Pins the boundary of the "already in use" regex: a message that merely
  // contains the word "open" in an unrelated sense must not be misclassified.
  const err = new Error('board did not open the expected response window');
  const message = explainFailure(err);
  assert.equal(/Arduino IDE serial monitor/.test(message), false);
});
