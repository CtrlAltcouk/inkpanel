import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('new-board mode embeds settings before writeFlash and never depends on post-reset USB provisioning', async () => {
  const source = await readFile(join(process.cwd(), 'public', 'flash.js'), 'utf8');
  const add = source.indexOf('parts = addFlashProvisioning(parts, newConfig, manifest.provisioning)');
  const write = source.indexOf('await loader.writeFlash');
  const after = source.indexOf('await loader.after()');
  const newResult = source.indexOf("if (mode === 'new')", after);
  const eraseBranch = source.indexOf("else if (mode === 'erase')", newResult);

  assert.ok(add > -1 && write > add,
    'one-time credentials must be embedded before any flash write begins');
  assert.ok(after > write && newResult > after && eraseBranch > newResult);

  const postFlashNewBoardBlock = source.slice(newResult, eraseBranch);
  assert.doesNotMatch(postFlashNewBoardBlock, /provisionNewBoard\(/,
    'normal new-board setup must not rely on Chrome reopening USB after the ESP32 resets');
  assert.match(postFlashNewBoardBlock, /Firmware and board settings were written in one pass/);
});
