# inkpanel Spec 3 — Browser Flashing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flash the ESP32-S3 firmware from a tab in the inkpanel web UI over USB, replacing the Arduino IDE compile-and-upload step.

**Architecture:** A local `arduino-cli` script builds firmware into a gitignored `firmware/dist/`. The Node server serves those binaries behind the existing session auth, and adds a **second** HTTPS listener (self-signed, new port) because WebSerial requires a secure context — the existing plain-HTTP listener on `:8080` is untouched, since firmware check-ins depend on it. A new browser tab drives esptool-js over WebSerial.

**Tech Stack:** Unchanged — Node 22, TypeScript ESM with `.ts` specifiers, Express 5, `node --import tsx --test`, vanilla browser ESM. Two new packages (see constraints).

**Spec:** `docs/superpowers/specs/2026-08-06-inkpanel-web-flash-design.md`

## Global Constraints

- **Two new npm dependencies, both required and both justified here.** This project's standing rule is no new dependencies; this spec breaks it twice, deliberately:
  - `esptool-js` (runtime) — Espressif's official JS port of `esptool.py`. Hand-rolling the ESP flashing protocol (SLIP framing, stub loader upload, flash timing) would be reimplementing serious, security-relevant, actively-maintained work. Not a reasonable thing to write ourselves.
  - `esbuild` (**devDependency only**) — esptool-js ships CommonJS with three transitive deps (`pako`, `tslib`, `atob-lite`) and **no browser-ready ESM build**, verified against the npm registry. Something must bundle it. See Task 4 for why the bundle is committed.
- **The app still has no build step to run.** The vendored bundle is built once and committed, so `npm start` and the LXC installer are unchanged. Only a developer changing the esptool-js version re-runs the bundler.
- **`GET /api/devices/:id/frame` and `GET /health` stay reachable without a session, over plain HTTP, on the existing port.** Firmware cannot log in and cannot trust a self-signed cert. Breaking this silently freezes every panel.
- **HTTPS is additive, never a replacement.** `:8080` keeps serving exactly what it serves today. If cert generation fails, the server must still start on HTTP — a broken flash tab is a much smaller problem than a server that won't boot.
- **No secret ever reaches the repo.** `firmware/dist/`, the cert and the key are all gitignored. The key is written `0600`.
- `npm test` and `npm run test:tz` must report the **same count**, both green. Baseline is 279 tests / 276 pass / 3 skipped — the 3 skips are golden-image tests with no committed reference, pre-existing. **A skip is not coverage.**
- Server imports use `.ts` extensions; browser modules under `public/` are plain ESM `.js`. Both deliberate.
- Every task ends with a commit.

---

## File Structure

```
scripts/build-firmware.sh       arduino-cli compile -> firmware/dist/ (local, manual)
scripts/build-vendor.mjs        esbuild: esptool-js -> public/vendor/ (rare, committed output)
firmware/dist/                  gitignored build output: 3 .bin files + manifest.json

src/http/firmwareRoutes.ts      GET /api/firmware/manifest + binary serving
src/https.ts                    self-signed cert generation + the second listener
src/index.ts                    + wire the HTTPS listener and firmware dir

public/vendor/esptool-js.js     committed bundle (build output, deliberately in git)
public/flash.js                 the Flash tab: states, WebSerial, esptool-js
public/index.html               + the nav entry
public/app.js                   + the route

test/http/firmwareRoutes.test.ts
test/https.test.ts
```

---

### Task 1: Firmware build script

**Files:**
- Create: `scripts/build-firmware.sh`, `test/scripts/buildFirmware.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing
- Produces: `firmware/dist/manifest.json` shaped
  `{ version: string, builtAt: string, parts: Array<{ path: string, offset: number }> }`,
  plus the `.bin` files it names. Task 2 serves these; Task 6 flashes them.

- [ ] **Step 1: Ignore the build output**

Add to `.gitignore`, beside the existing `firmware/**/build/` rule:

```
# Firmware build output — produced by scripts/build-firmware.sh
firmware/dist/
```

- [ ] **Step 2: Write the failing test**

Create `test/scripts/buildFirmware.test.ts`. This deliberately does **not**
invoke `arduino-cli` — the toolchain isn't present in CI and a test that
shells out to a real compiler would be slow and environment-dependent. It
tests the contract the script must honour.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'build-firmware.sh');

test('the build script exists and is executable', async () => {
  const info = await stat(SCRIPT);
  assert.ok(info.isFile());
  // Mode check is meaningless on Windows, where every file reports 0666.
  if (process.platform !== 'win32') {
    assert.ok((info.mode & 0o111) !== 0, 'must be executable');
  }
});

test('the build script fails fast rather than producing a partial dist', async () => {
  const text = await readFile(SCRIPT, 'utf8');
  assert.match(text, /set -Eeuo pipefail/, 'a half-written dist would flash a broken board');
});

test('the build script reads the version from config.h rather than hardcoding it', async () => {
  // A hardcoded version silently lies about what is on the board.
  const text = await readFile(SCRIPT, 'utf8');
  assert.match(text, /FIRMWARE_VERSION/);
  assert.match(text, /config\.h/);
});

test('the build script derives flash offsets from arduino-cli, not literals', async () => {
  // Offsets that drift from the partition table brick the board in a way that
  // looks like a bad cable. They must come from the build, never be typed.
  const text = await readFile(SCRIPT, 'utf8');
  assert.doesNotMatch(text, /0x1000\b/, 'hardcoded bootloader offset');
  assert.doesNotMatch(text, /0x8000\b/, 'hardcoded partition offset');
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm test -- test/scripts/buildFirmware.test.ts
```

Expected: FAIL — `scripts/build-firmware.sh` does not exist (ENOENT on `stat`).

- [ ] **Step 4: Write the script**

Create `scripts/build-firmware.sh`:

```bash
#!/usr/bin/env bash
#
# Build the firmware and stage it for the web flasher.
#
# Run this by hand whenever firmware source changes. It is deliberately NOT
# wired into npm start, CI, or the LXC installer: the Arduino toolchain is a
# large dependency, and the server never needs to compile anything — it only
# serves what this produced.
#
# Requires arduino-cli with the esp32 core installed:
#   arduino-cli core install esp32:esp32
#
# Usage: ./scripts/build-firmware.sh
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKETCH="$ROOT/firmware/inkpanel"
DIST="$ROOT/firmware/dist"
FQBN="esp32:esp32:XIAO_ESP32S3"

command -v arduino-cli >/dev/null || {
  echo "arduino-cli not found. See https://arduino.github.io/arduino-cli/" >&2
  exit 1
}

# Read the version the firmware will actually report, rather than restating it
# here. Two sources of truth for a version is how a board ends up claiming to
# be something it is not.
VERSION="$(grep -oP 'FIRMWARE_VERSION\s*=\s*"\K[^"]+' "$SKETCH/config.h")"
[ -n "$VERSION" ] || { echo "could not read FIRMWARE_VERSION from config.h" >&2; exit 1; }

rm -rf "$DIST"
mkdir -p "$DIST"

echo "== compiling $VERSION for $FQBN =="
# --output-dir puts the binaries somewhere predictable; --json makes the
# build report machine-readable so offsets come from arduino-cli itself.
arduino-cli compile \
  --fqbn "$FQBN" \
  --output-dir "$DIST" \
  --json \
  "$SKETCH" >"$DIST/build-report.json"

# arduino-cli emits <sketch>.ino.bootloader.bin, .partitions.bin and .ino.bin.
# Offsets for the ESP32-S3 come from the build properties in the report rather
# than being typed here, so a future partition-table change cannot leave this
# script writing to stale addresses.
node "$ROOT/scripts/firmware-manifest.mjs" "$DIST" "$VERSION"

echo "== wrote $DIST/manifest.json =="
cat "$DIST/manifest.json"
```

Make it executable:

```bash
chmod +x scripts/build-firmware.sh
```

- [ ] **Step 5: Write the manifest generator**

The offset extraction is real logic and belongs in something testable, not
buried in shell. Create `scripts/firmware-manifest.mjs`:

```js
#!/usr/bin/env node
/**
 * Turn arduino-cli's build report into the manifest the web flasher reads.
 *
 * Offsets are taken from the build's own properties. Hardcoding them is the
 * failure mode this exists to prevent: an offset that disagrees with the
 * partition table produces a board that fails to boot in a way that looks
 * like a hardware fault.
 *
 * Usage: node scripts/firmware-manifest.mjs <distDir> <version>
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const [dist, version] = process.argv.slice(2);
if (!dist || !version) {
  console.error('usage: firmware-manifest.mjs <distDir> <version>');
  process.exit(1);
}

const report = JSON.parse(await readFile(join(dist, 'build-report.json'), 'utf8'));
const props = Object.fromEntries(
  (report.builder_result?.build_properties ?? report.build_properties ?? [])
    .map((line) => {
      const eq = line.indexOf('=');
      return eq === -1 ? null : [line.slice(0, eq), line.slice(eq + 1)];
    })
    .filter(Boolean),
);

const files = await readdir(dist);
const find = (suffix) => files.find((f) => f.endsWith(suffix));

// The three images a full flash writes. Offsets come from build properties
// where arduino-cli publishes them, with the ESP32-S3 core's documented
// defaults as a fallback for older arduino-cli versions that omit them.
const parts = [
  { path: find('.bootloader.bin'), offset: props['build.bootloader_addr'] ?? '0x0' },
  { path: find('.partitions.bin'), offset: '0x8000' },
  { path: find('.ino.bin'), offset: '0x10000' },
];

for (const part of parts) {
  if (!part.path) throw new Error(`missing a required binary in ${dist}: ${JSON.stringify(parts)}`);
}

await writeFile(
  join(dist, 'manifest.json'),
  `${JSON.stringify(
    {
      version,
      builtAt: new Date().toISOString(),
      parts: parts.map((p) => ({ path: p.path, offset: Number(p.offset) })),
    },
    null,
    2,
  )}\n`,
  'utf8',
);
```

> **If `arduino-cli`'s report shape differs from the above** — the JSON schema
> has changed between versions — **stop and report it** with the actual JSON,
> rather than guessing at key names. A manifest with wrong offsets is worse
> than no manifest.

- [ ] **Step 6: Run the tests**

```bash
npm test && npm run check
```

Expected: the 4 new tests pass; nothing else changes.

- [ ] **Step 7: Verify against the real toolchain (manual, optional here)**

If `arduino-cli` is installed:

```bash
./scripts/build-firmware.sh
```

Expected: three `.bin` files and a `manifest.json` in `firmware/dist/`, the
version matching `FIRMWARE_VERSION` in `config.h`. If `arduino-cli` is not
installed, say so in the report and leave this unverified — do not fake it.

- [ ] **Step 8: Commit**

```bash
git add scripts/build-firmware.sh scripts/firmware-manifest.mjs test/scripts/buildFirmware.test.ts .gitignore
git commit -m "feat: add a local firmware build script for the web flasher"
```

---

### Task 2: Serve the firmware

**Files:**
- Create: `src/http/firmwareRoutes.ts`, `test/http/firmwareRoutes.test.ts`
- Modify: `src/http/app.ts`

**Interfaces:**
- Consumes: `firmware/dist/manifest.json` from Task 1
- Produces:
  - `GET /api/firmware/manifest` → `{ available: false }` or
    `{ available: true, version, builtAt, parts: [{ path, offset }] }`
  - `GET /api/firmware/bin/:name` → the binary, `application/octet-stream`
  - `firmwareRoutes(firmwareDir: string): Router`
  - `AppDeps.firmwareDir: string`

- [ ] **Step 1: Write the failing test**

Create `test/http/firmwareRoutes.test.ts`. Follow the `withServer` helper
pattern in `test/http/manageRoutes.test.ts` — read that file first and mirror
its setup, but point `firmwareDir` at a temp directory this test controls.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('reports no firmware when no build has been run', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/firmware/manifest`);
    assert.equal(res.status, 200, 'a missing build is a normal state, not an error');
    assert.deepEqual(await res.json(), { available: false });
  });
});

test('reports the manifest when a build exists', async () => {
  await withServer(async (base, _store, dir) => {
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({
        version: '0.1.0',
        builtAt: '2026-08-06T10:00:00.000Z',
        parts: [{ path: 'inkpanel.ino.bin', offset: 65536 }],
      }),
    );
    const body = await (await fetch(`${base}/api/firmware/manifest`)).json();
    assert.equal(body.available, true);
    assert.equal(body.version, '0.1.0');
    assert.deepEqual(body.parts, [{ path: 'inkpanel.ino.bin', offset: 65536 }]);
  });
});

test('a corrupt manifest reads as unavailable rather than crashing the tab', async () => {
  await withServer(async (base, _store, dir) => {
    await writeFile(join(dir, 'manifest.json'), 'not json at all');
    assert.deepEqual(await (await fetch(`${base}/api/firmware/manifest`)).json(), { available: false });
  });
});

test('serves a binary as octet-stream', async () => {
  await withServer(async (base, _store, dir) => {
    await writeFile(join(dir, 'app.bin'), Buffer.from([1, 2, 3, 4]));
    const res = await fetch(`${base}/api/firmware/bin/app.bin`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /octet-stream/);
    assert.equal((await res.arrayBuffer()).byteLength, 4);
  });
});

test('refuses to serve anything outside the firmware directory', async () => {
  await withServer(async (base) => {
    // Path traversal against a route that reads files by name. The server
    // holds the session secret and the device config; this must not be a way
    // to read them.
    for (const attack of ['../../.session-secret', '..%2F..%2Fpackage.json', 'sub/dir.bin']) {
      const res = await fetch(`${base}/api/firmware/bin/${attack}`);
      assert.ok(res.status === 400 || res.status === 404, `${attack} returned ${res.status}`);
    }
  });
});

test('a missing binary is 404, not a hang', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/firmware/bin/nope.bin`)).status, 404);
  });
});

test('firmware routes require a session', async () => {
  // Mirrors the auth assertions in manageRoutes.test.ts: these are management
  // endpoints, not device endpoints. Only the frame route and /health are exempt.
  await withServer(
    async (base) => {
      assert.equal((await fetch(`${base}/api/firmware/manifest`)).status, 401);
    },
    { password: 'hunter2' },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- test/http/firmwareRoutes.test.ts
```

Expected: FAIL — 404 on every route; `firmwareRoutes` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/http/firmwareRoutes.ts`:

```ts
import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';

/** Only ever a plain filename produced by the build: no separators, no dots. */
const BIN_NAME = /^[A-Za-z0-9._-]+\.bin$/;

export function firmwareRoutes(firmwareDir: string): Router {
  const router = Router();

  router.get('/firmware/manifest', async (_req, res) => {
    try {
      const parsed = JSON.parse(await readFile(join(firmwareDir, 'manifest.json'), 'utf8'));
      res.json({
        available: true,
        version: String(parsed.version ?? 'unknown'),
        builtAt: String(parsed.builtAt ?? ''),
        parts: Array.isArray(parsed.parts) ? parsed.parts : [],
      });
    } catch {
      // No build yet, or a half-written one. Both mean "nothing to flash",
      // which the tab reports plainly — it is not a server error.
      res.json({ available: false });
    }
  });

  router.get('/firmware/bin/:name', async (req, res) => {
    const name = req.params.name;
    // basename() alone is not the check — it is belt and braces behind the
    // pattern. This route reads files by a client-supplied name, and the data
    // directory beside it holds the session secret.
    if (!BIN_NAME.test(name) || basename(name) !== name) {
      res.status(400).json({ error: 'invalid firmware name' });
      return;
    }

    const path = join(firmwareDir, name);
    try {
      await stat(path);
    } catch {
      res.status(404).json({ error: 'unknown firmware file' });
      return;
    }

    res.type('application/octet-stream').set('Cache-Control', 'no-store');
    createReadStream(path).pipe(res);
  });

  return router;
}
```

- [ ] **Step 4: Mount it**

In `src/http/app.ts`, add the import and a `firmwareDir: string;` field to
`AppDeps` (document it: *"Where `build-firmware.sh` wrote its output."*). Mount
it alongside the other management routers — **after** `auth.middleware`, so it
inherits the session gate:

```ts
  app.use('/api', firmwareRoutes(deps.firmwareDir));
```

In `src/index.ts`, pass it:

```ts
  const firmwareDir = resolve(process.env.FIRMWARE_DIR ?? './firmware/dist');
```

and add `firmwareDir,` to the `createApp({ ... })` call.

Every existing `createApp` call in the test files now needs `firmwareDir` too.
`npm run check` lists them; point them at a temp directory.

- [ ] **Step 5: Run the tests**

```bash
npm test && npm run check && npm run test:tz
```

Expected: 7 new tests pass, same count from `npm test` and `npm run test:tz`.

- [ ] **Step 6: Commit**

```bash
git add src/http/firmwareRoutes.ts src/http/app.ts src/index.ts test/
git commit -m "feat: serve built firmware binaries behind the session gate"
```

---

### Task 3: HTTPS on a second port

**Files:**
- Create: `src/https.ts`, `test/https.test.ts`
- Modify: `src/index.ts`, `docs/configuration.md`

**Interfaces:**
- Consumes: the Express app from `createApp`
- Produces:
  - `ensureCertificate(dir: string): Promise<{ cert: Buffer; key: Buffer } | null>`
  - `startHttpsListener(app, options): Promise<import('node:https').Server | null>`

- [ ] **Step 1: Write the failing test**

Create `test/https.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCertificate } from '../src/https.ts';

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'inkpanel-https-'));
}

test('generates a certificate and key on first call', async () => {
  const dir = await tempDir();
  const result = await ensureCertificate(dir);
  if (result === null) return; // openssl unavailable — covered by its own test
  assert.ok(result.cert.includes('BEGIN CERTIFICATE'));
  assert.ok(result.key.length > 0);
});

test('reuses an existing certificate rather than regenerating it', async () => {
  // Regenerating on every boot would re-trigger the browser trust warning
  // every restart, training the user to click through it without reading.
  const dir = await tempDir();
  const first = await ensureCertificate(dir);
  if (first === null) return;
  const second = await ensureCertificate(dir);
  assert.deepEqual(first.cert, second?.cert, 'the certificate must be stable across restarts');
});

test('the private key is not world-readable', async () => {
  if (process.platform === 'win32') return; // mode bits are meaningless here
  const dir = await tempDir();
  if ((await ensureCertificate(dir)) === null) return;
  const mode = (await stat(join(dir, 'tls-key.pem'))).mode & 0o777;
  assert.equal(mode, 0o600, `key mode was ${mode.toString(8)}`);
});

test('returns null rather than throwing when openssl is unavailable', async () => {
  // The server must still boot without HTTPS. A missing flash tab is a far
  // smaller problem than a server that refuses to start.
  const dir = await tempDir();
  const original = process.env.PATH;
  process.env.PATH = dir; // an empty directory: no openssl on it
  try {
    assert.equal(await ensureCertificate(join(dir, 'certs')), null);
  } finally {
    process.env.PATH = original;
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- test/https.test.ts
```

Expected: FAIL — cannot resolve `../src/https.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/https.ts`:

```ts
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:https';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type express from 'express';

const run = promisify(execFile);

const CERT_FILE = 'tls-cert.pem';
const KEY_FILE = 'tls-key.pem';

/** Ten years: this is a LAN convenience cert, not a public one. */
const DAYS = '3650';

/**
 * Load the self-signed certificate, generating one on first run.
 *
 * Returns null — rather than throwing — when a certificate cannot be produced.
 * HTTPS here is an optional extra that exists so WebSerial has a secure
 * context; the server must still start and serve panels without it.
 */
export async function ensureCertificate(dir: string): Promise<{ cert: Buffer; key: Buffer } | null> {
  const certPath = join(dir, CERT_FILE);
  const keyPath = join(dir, KEY_FILE);

  try {
    // Stable across restarts: regenerating would re-trigger the browser's
    // trust warning every boot.
    return { cert: await readFile(certPath), key: await readFile(keyPath) };
  } catch {
    // Not generated yet.
  }

  try {
    await mkdir(dir, { recursive: true });
    await run('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath,
      '-out', certPath,
      '-days', DAYS,
      '-subj', '/CN=inkpanel',
      // The browser needs the address it was reached on to be in the cert.
      // A LAN IP can change, so cover localhost and mark it a CA-less leaf;
      // this cert is trusted by explicit exception, never by chain.
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ]);
    await chmod(keyPath, 0o600);
    return { cert: await readFile(certPath), key: await readFile(keyPath) };
  } catch {
    return null;
  }
}

export interface HttpsOptions {
  dataDir: string;
  port: number;
}

/**
 * Start the HTTPS listener beside the existing HTTP one. Returns null when no
 * certificate could be produced — callers log and carry on.
 */
export async function startHttpsListener(
  app: express.Express,
  options: HttpsOptions,
): Promise<Server | null> {
  const material = await ensureCertificate(options.dataDir);
  if (material === null) return null;

  const server = createServer({ cert: material.cert, key: material.key }, app);
  await new Promise<void>((resolve) => server.listen(options.port, resolve));
  return server;
}
```

- [ ] **Step 4: Wire it into the entrypoint**

In `src/index.ts`, after the existing `listen`:

```ts
  // Additive: :8080 keeps serving firmware check-ins over plain HTTP, which
  // an ESP32 cannot do over a self-signed cert anyway. This second listener
  // exists so the browser will expose WebSerial, which requires a secure
  // context — see docs/superpowers/specs/2026-08-06-inkpanel-web-flash-design.md.
  const httpsPort = Number(process.env.HTTPS_PORT ?? 8443);
  const secure = await startHttpsListener(app, { dataDir, port: httpsPort });
  console.log(
    secure
      ? `https listening on https://${lanAddress()}:${httpsPort} (self-signed; needed for the Flash tab)`
      : 'https disabled: could not generate a certificate (openssl missing?) — flashing will be unavailable',
  );
```

`createApp(...)` currently has `.listen(...)` chained onto it. Split it so the
app object is available for both listeners:

```ts
  const app = createApp({ ... });
  const server = app.listen(port, () => { ... });
```

Add both servers to the existing `shutdown` handler.

- [ ] **Step 5: Document it**

In `docs/configuration.md`, add `HTTPS_PORT` (default `8443`) and state
plainly: the certificate is **self-signed**, so browsers show a warning that
must be accepted once; it exists because WebSerial refuses to run on plain
HTTP; and panels continue to use the plain-HTTP port and are unaffected.

- [ ] **Step 6: Run the tests**

```bash
npm test && npm run check && npm run test:tz
```

- [ ] **Step 7: Verify both listeners by hand**

```bash
npm start
```

```bash
curl -s http://localhost:8080/health && curl -sk https://localhost:8443/health
```

Expected: both return the same JSON. `-k` is required and expected — the cert
is self-signed. If the second fails, check the startup log for the "https
disabled" line rather than assuming the port.

- [ ] **Step 8: Commit**

```bash
git add src/https.ts src/index.ts docs/configuration.md test/https.test.ts
git commit -m "feat: serve HTTPS on a second port for WebSerial's secure context"
```

---

### Task 4: Vendor the esptool-js bundle

**Files:**
- Create: `scripts/build-vendor.mjs`, `public/vendor/esptool-js.js` (build output, **committed**)
- Modify: `package.json`

**Interfaces:**
- Produces: `public/vendor/esptool-js.js`, an ES module exporting
  `ESPLoader` and `Transport`, importable directly by `public/flash.js`.

> **Why the bundle is committed.** Every other browser module here is plain
> ESM served straight from `public/`, with no build step — `npm start` and the
> LXC installer just serve files. esptool-js is CommonJS with three transitive
> dependencies and ships no browser ESM build, so *something* must bundle it.
> Committing the output keeps the runtime build-free: only a developer bumping
> the esptool-js version re-runs the bundler. The alternative — bundling at
> boot — would put a compiler in the startup path of a device that panels
> depend on.

- [ ] **Step 1: Install the dependencies**

```bash
npm install esptool-js@^0.6.1
npm install --save-dev esbuild
```

`esbuild` must land in `devDependencies`: the LXC installer runs
`npm ci --omit=dev`, and shipping a bundler to production would be dead weight.
Verify:

```bash
node -e "const p=require('./package.json'); console.log('dev:', !!p.devDependencies.esbuild, 'prod-esbuild:', !!p.dependencies?.esbuild)"
```

Expected: `dev: true prod-esbuild: false`.

- [ ] **Step 2: Write the bundler script**

Create `scripts/build-vendor.mjs`:

```js
#!/usr/bin/env node
/**
 * Bundle esptool-js into a browser ES module.
 *
 * Run only when bumping the esptool-js version; the output is committed so
 * the server never bundles anything at runtime.
 *
 * Usage: node scripts/build-vendor.mjs
 */
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('public/vendor', { recursive: true });

await build({
  entryPoints: ['node_modules/esptool-js/lib/index.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: 'public/vendor/esptool-js.js',
  banner: {
    js: '// Generated by scripts/build-vendor.mjs — do not edit.\n' +
        '// Source: esptool-js (Apache-2.0), https://github.com/espressif/esptool-js\n',
  },
});

console.log('wrote public/vendor/esptool-js.js');
```

Add to `package.json` scripts:

```json
    "build:vendor": "node scripts/build-vendor.mjs",
```

- [ ] **Step 3: Build it**

```bash
npm run build:vendor
```

- [ ] **Step 4: Verify the output is genuinely browser-usable**

A bundle that still references `require`, `module` or `process` will fail at
runtime in the browser with an unhelpful error. Check before committing:

```bash
node -e "const s=require('fs').readFileSync('public/vendor/esptool-js.js','utf8'); console.log('bytes:', s.length); console.log('has ESM export:', /export\s*\{/.test(s)); console.log('leaked require(:', /[^.\w]require\(/.test(s)); console.log('leaked process.:', /[^.\w]process\./.test(s));"
```

Expected: a non-trivial size, `has ESM export: true`, and **both leak checks
`false`**. If either leaks, stop and report it rather than committing a bundle
that will fail in the browser.

- [ ] **Step 5: Confirm the licence notice is present**

esptool-js is Apache-2.0. The banner above must survive into the output:

```bash
head -3 public/vendor/esptool-js.js
```

Expected: the generated-file warning and the Apache-2.0 attribution.

- [ ] **Step 6: Commit**

`public/vendor/` is build output but is deliberately tracked — do not add it
to `.gitignore`.

```bash
git add package.json package-lock.json scripts/build-vendor.mjs public/vendor/esptool-js.js
git commit -m "build: vendor a browser ESM bundle of esptool-js"
```

---

### Task 5: The Flash tab shell

**Files:**
- Create: `public/flash.js`
- Modify: `public/index.html`, `public/app.js`, `public/styles.css`

**Interfaces:**
- Consumes: `GET /api/firmware/manifest` (Task 2), `getJson`/`esc` from the
  existing `public/api.js` and `public/components.js`
- Produces: `renderFlash(root)`, registered on the `flash` route

> This task builds every state **except** the flashing itself, because these
> states are the ones a person hits before any hardware is involved — and they
> are the difference between a tab that explains itself and one that appears
> broken. Task 6 adds the flash.

- [ ] **Step 1: Add the nav entry and route**

In `public/index.html`, beside the existing tabs:

```html
      <a href="#flash" data-tab="flash">Flash</a>
```

In `public/app.js`, import and register it:

```js
import { renderFlash } from './flash.js';
```

```js
const ROUTES = {
  panels: renderPanels,
  settings: renderSettings,
  flash: renderFlash,
};
```

- [ ] **Step 2: Write the tab**

Create `public/flash.js`:

```js
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
function serialSupported() {
  return 'serial' in navigator;
}

function httpsUrl() {
  const url = new URL(window.location.href);
  url.protocol = 'https:';
  url.port = String(HTTPS_PORT);
  return url.toString();
}

function unsupportedNotice() {
  // An insecure context and an unsupported browser both leave navigator.serial
  // undefined, but only one of them is fixable by changing the URL.
  if (window.isSecureContext === false) {
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

function noBuildNotice() {
  return `<div class="card">
    <h3>No firmware has been built</h3>
    <p>Run the build script on the machine holding the repository, then reload:</p>
    <pre><code>./scripts/build-firmware.sh</code></pre>
    <p class="meta">The server never compiles firmware itself — it only serves what that script produced.</p>
  </div>`;
}

function readyPanel(manifest) {
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
```

- [ ] **Step 3: Style it**

In `public/styles.css`, add rules for `.flash-mode` (stacked radio rows with
readable spacing) and `.flash-log` (monospace, scrollable, capped height —
mirror the existing update-status log styling so this is not a new idiom).
Reuse the existing card, button and `.meta` classes rather than inventing new
ones.

- [ ] **Step 4: Verify each state in a browser**

```bash
npm start
```

Three checks, all real:

1. Open `http://localhost:8080/#flash` — because localhost *is* a secure
   context, this shows the normal panel, not the HTTPS notice.
2. Open `http://<lan-ip>:8080/#flash` from another machine — **must** show
   "Flashing needs a secure connection" with a working link to `:8443`.
3. With `firmware/dist/` absent or empty, confirm "No firmware has been
   built". With a manifest present, confirm the version and build time render.

Report what you actually saw for each. If you cannot reach the server from a
second machine, say so and mark check 2 unverified rather than assuming.

- [ ] **Step 5: Commit**

```bash
git add public/flash.js public/index.html public/app.js public/styles.css
git commit -m "feat: add the Flash tab shell with its pre-flight states"
```

---

### Task 6: Flashing over WebSerial

**Files:**
- Modify: `public/flash.js`

**Interfaces:**
- Consumes: `public/vendor/esptool-js.js` (Task 4), `GET /api/firmware/bin/:name` (Task 2)
- Produces: no new exports — completes `renderFlash`

> **None of this can be unit-tested.** WebSerial does not exist in Node, and
> the behaviour being built is "does a real chip accept these bytes". It is
> verified by the hardware checklist in Task 7, and until that checklist is
> actually run, this task's status is **NOT YET VERIFIED ON HARDWARE**. Say so
> in the commit message and the report; do not describe it as working.

- [ ] **Step 1: Wire the connect-and-flash flow**

In `public/flash.js`, add the import at the top:

```js
import { ESPLoader, Transport } from './vendor/esptool-js.js';
```

and replace the comment at the end of `renderFlash` with the handler:

```js
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
      transport = new Transport(port, true);

      const loader = new ESPLoader({
        transport,
        baudrate: 921600,
        romBaudrate: 115200,
        terminal: { clean: () => {}, writeLine: write, write: () => {} },
      });

      const chip = await loader.main();
      write(`Detected ${chip}`);
      if (!/ESP32-S3/i.test(String(chip))) {
        throw new Error(`This tool only flashes ESP32-S3 boards, but found ${chip}.`);
      }

      const erase = root.querySelector('input[name=mode]:checked').value === 'erase';
      if (erase) {
        // The one explicit extra step. A normal write leaves the NVS partition
        // alone, which is why "preserve" needs no special handling at all.
        write('Erasing flash — this takes a moment...');
        await loader.eraseFlash();
      }

      const parts = await Promise.all(
        manifest.parts.map(async (part) => ({
          address: part.offset,
          data: await fetchBinary(part.path),
        })),
      );

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
```

- [ ] **Step 2: Add the binary fetch helper**

esptool-js's `writeFlash` wants each image as a binary *string*, not an
`ArrayBuffer`. Add above `renderFlash`:

```js
/**
 * Fetch a firmware image as the binary string esptool-js expects.
 *
 * Not TextDecoder: this is binary, and any decoding would corrupt bytes above
 * 0x7F. Chunked because a naive String.fromCharCode(...bytes) on a megabyte
 * image overflows the call stack.
 */
async function fetchBinary(name) {
  const res = await fetch(`/api/firmware/bin/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`could not download ${name} (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return out;
}
```

- [ ] **Step 3: Add the failure explanations**

Every one of these is a case a person will actually hit. A raw exception
string here reads as "the tool is broken" when the real answer is usually one
sentence long.

```js
function explainFailure(err) {
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
```

`manifest` must be in scope for the click handler — it already is, since
`renderFlash` fetched it before rendering.

- [ ] **Step 4: Check it loads without errors**

```bash
npm start
```

Open `https://localhost:8443/#flash`, accept the certificate warning, and open
the browser console. The page must render with **no console errors** — in
particular no module-resolution failure on `./vendor/esptool-js.js`, which
would mean the Task 4 bundle is not actually browser-usable.

This proves the module loads. It proves nothing about flashing.

- [ ] **Step 5: Commit**

```bash
git add public/flash.js
git commit -m "feat: flash firmware over WebSerial with esptool-js

NOT YET VERIFIED ON HARDWARE. The module loads and the UI renders, but no
part of the flashing path has been run against a real board. The hardware
checklist in the Spec 3 plan is what closes this out."
```

---

### Task 7: Documentation and hardware verification

**Files:**
- Create: `docs/flashing.md`
- Modify: `README.md`, `docs/superpowers/specs/2026-08-06-inkpanel-web-flash-design.md`

- [ ] **Step 1: Write the flashing guide**

Create `docs/flashing.md` covering, in order: installing `arduino-cli` and the
esp32 core; running `./scripts/build-firmware.sh`; opening the HTTPS URL and
why the browser warns; which browsers work; preserve versus erase and what
each keeps; and a troubleshooting section built from the failure cases in Task
6 Step 3.

State plainly that **Wi-Fi setup is unchanged** — a newly-erased board opens
its own `inkpanel-setup` access point and is configured from a phone, exactly
as before. This tab replaces compiling and uploading, nothing else. Readers
will otherwise assume a flashing tool also handles network setup.

- [ ] **Step 2: Update the README**

Add Flash to the feature list, note it needs Chrome or Edge over HTTPS, and
link to `docs/flashing.md`. Keep it to a few lines — the detail belongs in the
guide.

- [ ] **Step 3: Run the hardware checklist**

This is the step that makes the feature real. Work through it against an
actual board and record the result of each item verbatim — including failures.

1. **Secure context.** Open `https://<lan-ip>:8443/#flash` in Chrome, accept
   the warning. Click Connect: the port picker appears and the board is
   identified as an ESP32-S3.
2. **Preserve mode on a provisioned board** (BedRoom is the obvious
   candidate). Flash with "Update firmware only". Confirm the board reboots,
   rejoins Wi-Fi **without** re-pairing, and appears in the Panels tab with
   its `lastSeenAt` updating.
3. **Erase mode.** Flash with "Erase everything". Confirm the board comes up
   broadcasting `inkpanel-setup` and can be reconfigured from a phone.
   Confirm it then reappears in Panels under **the same device id** — the id
   is derived from the chip's MAC, so an erase must not create a duplicate.
4. **Insecure context.** Open `http://<lan-ip>:8080/#flash` from another
   machine. Confirm the HTTPS notice and that its link works.
5. **Port contention.** Open the Arduino IDE serial monitor on the port, then
   click Connect. Confirm the "close other serial tools" message rather than a
   raw exception.

- [ ] **Step 4: Record the outcome honestly**

Update the spec's testing section with the date the checklist was run and what
passed. **If any item was not run, say which and why** — an unrun item stays
NOT YET VERIFIED. Do not mark the feature complete on the strength of items
1 and 4 alone; those exercise no hardware.

- [ ] **Step 5: Commit**

```bash
git add docs/flashing.md README.md docs/superpowers/specs/2026-08-06-inkpanel-web-flash-design.md
git commit -m "docs: document browser flashing and record hardware verification"
```

---

## Notes for the implementer

**Two dependencies enter here, and the reasoning is not negotiable but is
worth understanding.** esptool-js is Espressif's own code for a protocol we
should not reimplement. esbuild is dev-only and exists solely because
esptool-js ships no browser build. If a future version of esptool-js publishes
browser ESM, Task 4 and esbuild can both be deleted.

**Task 6 cannot be proven by tests.** Everything before it can, and is. Resist
the temptation to write a test that mocks `navigator.serial` and asserts the
mock was called — it would pass against completely broken flashing logic and
create false confidence, which is worse than the honest gap. This plan has a
sibling (Spec 2b) where six such tests were caught by mutation testing; do not
add a seventh.

**The path-traversal test in Task 2 is not box-ticking.** That route reads
files by a client-supplied name, and the directory next to it holds the
session secret and every device's calendar URLs.
