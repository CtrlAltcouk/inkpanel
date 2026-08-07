import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  serialSupported,
  httpsUrl,
  unsupportedNotice,
  noBuildNotice,
  readyPanel,
  renderFlash,
} from '../../public/flash.js';

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

function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

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
// navigator.serial undefined, but only the first is fixed by an HTTPS link.
test('an insecure HTTP context gets the HTTPS-redirect notice, never the unsupported-browser notice', async () => {
  await withWindow({ isSecureContext: false, location: { href: 'http://192.168.1.50:8080/#flash' } }, () => {
    const html = unsupportedNotice();
    assert.equal(occurrences(html, '<h3>Flashing needs a secure connection</h3>'), 1);
    assert.equal(occurrences(html, '<a href="https://192.168.1.50:8443/#flash">Open inkpanel over HTTPS</a>'), 1);
    assert.equal(occurrences(html, 'This browser cannot flash boards'), 0);
  });
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
  await withWindow(
    { isSecureContext: false, location: { href: 'http://192.168.1.50:8080/#flash&reload=1' } },
    () => {
      const html = unsupportedNotice();
      assert.equal(occurrences(html, 'href="https://192.168.1.50:8443/#flash&amp;reload=1"'), 1);
      assert.equal(html.includes('href="https://192.168.1.50:8443/#flash&reload=1"'), false);
    },
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

test('renderFlash shows the unsupported-browser notice and never calls the manifest API when WebSerial is simply absent', async () => {
  let fetchCalled = false;
  await withNavigator({}, () =>
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

test('renderFlash shows the HTTPS-redirect notice when navigator lacks serial because the page is on plain HTTP', async () => {
  await withNavigator({}, () =>
    withWindow({ isSecureContext: false, location: { href: 'http://192.168.1.50:8080/#flash' } }, async () => {
      const root = { innerHTML: '' };
      await renderFlash(root);
      assert.equal(occurrences(root.innerHTML, 'Flashing needs a secure connection'), 1);
      assert.equal(occurrences(root.innerHTML, 'https://192.168.1.50:8443/#flash'), 1);
    }),
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
        const root = { innerHTML: '' };
        await renderFlash(root);
        assert.equal(occurrences(root.innerHTML, '<h3>Flash a panel</h3>'), 1);
        assert.equal(occurrences(root.innerHTML, 'Firmware 1.0.0 &middot; built 2026-08-06T10:00:00.000Z'), 1);
      },
    ),
  );
});
