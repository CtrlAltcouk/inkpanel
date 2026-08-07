import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BUNDLE_PATH = join(process.cwd(), 'public', 'vendor', 'esptool-js.js');

test('esptool-js bundle exports ESPLoader', async () => {
  // Import the real bundle to test the actual export
  // eslint-disable-next-line import/no-dynamic-require
  const module = (await import(new URL(`file://${BUNDLE_PATH}`).href)) as Record<string, unknown>;
  assert.ok(module.ESPLoader, 'bundle must export ESPLoader');
  assert.strictEqual(typeof module.ESPLoader, 'function', 'ESPLoader must be a constructor');
});

test('esptool-js bundle exports Transport', async () => {
  // Import the real bundle to test the actual export
  // eslint-disable-next-line import/no-dynamic-require
  const module = (await import(new URL(`file://${BUNDLE_PATH}`).href)) as Record<string, unknown>;
  assert.ok(module.Transport, 'bundle must export Transport');
  assert.strictEqual(typeof module.Transport, 'function', 'Transport must be a constructor');
});

test('esptool-js bundle contains no leaked require() outside __commonJS shims', async () => {
  const content = await readFile(BUNDLE_PATH, 'utf8');

  // Pattern: Match any require( that is NOT inside a __commonJS shim.
  // __commonJS shims are the internal esbuild helpers at the top like:
  // var __commonJS = (cb, mod) => function __require() {
  //   return ... mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), ...
  // These are expected and OK. We want to catch accidentally-leaked Node require() calls.

  // Split on __commonJS to find sections, then check if any non-shim section has require(
  const lines = content.split('\n');
  let inShim = false;
  let shimDepth = 0;
  let problemFound = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // Detect __commonJS shim start
    if (line.includes('var __commonJS = (') || line.includes('function __require()')) {
      inShim = true;
      shimDepth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
      continue;
    }

    // Track depth if we're in a shim
    if (inShim) {
      shimDepth += (line.match(/{/g) || []).length;
      shimDepth -= (line.match(/}/g) || []).length;
      if (shimDepth <= 0) {
        inShim = false;
      }
      continue;
    }

    // If we find require( outside a shim, flag it
    if (!inShim && /\brequire\s*\(/.test(line)) {
      // Double-check it's not in a string comment or esbuild internals marker
      if (!line.includes('__require') && !line.includes('// ')) {
        problemFound = true;
        break;
      }
    }
  }

  assert.ok(!problemFound, 'bundle must not contain leaked require() calls outside __commonJS shims');
});

test('esptool-js bundle contains no leaked process. references outside __commonJS shims', async () => {
  const content = await readFile(BUNDLE_PATH, 'utf8');

  // Similar check but for process. — we want to catch accidentally-leaked Node process references
  // Exclude process.env when it appears in shims (it won't, but be defensive)
  const lines = content.split('\n');
  let inShim = false;
  let shimDepth = 0;
  let problemFound = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (line.includes('var __commonJS = (') || line.includes('function __require()')) {
      inShim = true;
      shimDepth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
      continue;
    }

    if (inShim) {
      shimDepth += (line.match(/{/g) || []).length;
      shimDepth -= (line.match(/}/g) || []).length;
      if (shimDepth <= 0) {
        inShim = false;
      }
      continue;
    }

    if (!inShim && /\bprocess\./.test(line)) {
      // Exclude comment lines and esbuild markers
      if (!line.includes('//')) {
        problemFound = true;
        break;
      }
    }
  }

  assert.ok(!problemFound, 'bundle must not contain leaked process. references outside __commonJS shims');
});

test('esptool-js bundle contains Apache-2.0 license banner', async () => {
  const content = await readFile(BUNDLE_PATH, 'utf8');
  assert.match(content, /Apache-2\.0/, 'bundle must reference Apache-2.0 license');
  assert.match(
    content,
    /esptool-js.*Apache-2\.0/,
    'bundle banner must credit esptool-js with Apache-2.0 license',
  );
});

test('esptool-js bundle is non-trivial in size', async () => {
  const content = await readFile(BUNDLE_PATH, 'utf8');
  // The bundle should be at least 50KB to ensure it's not truncated or empty
  assert.ok(content.length > 50000, `bundle must be at least 50KB, got ${content.length} bytes`);
});
