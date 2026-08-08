import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const PARTITIONS = join(ROOT, 'firmware', 'inkpanel', 'partitions.csv');
const IMPORTER = join(ROOT, 'firmware', 'inkpanel', 'FlashProvisioning.cpp');
const SKETCH = join(ROOT, 'firmware', 'inkpanel', 'inkpanel.ino');

type PartitionRow = [string, string, string, string, string, ...string[]];

function partitionRow(text: string, name: string): PartitionRow {
  const row = text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((line) => line.split(',').map((field) => field.trim()))
    .find((fields) => fields[0] === name);
  assert.ok(row, `missing ${name} partition`);
  assert.ok(row.length >= 5, `${name} partition row is incomplete`);
  return row as PartitionRow;
}

test('custom partition table preserves NVS/app offsets and reserves exactly the final 4 KiB sector', async () => {
  const text = await readFile(PARTITIONS, 'utf8');
  const nvs = partitionRow(text, 'nvs');
  const app0 = partitionRow(text, 'app0');
  const provision = partitionRow(text, 'provision');

  assert.equal(nvs[3].toLowerCase(), '0x9000', 'existing Preferences/NVS must not move');
  assert.equal(app0[3].toLowerCase(), '0x10000', 'safe-update application offset must remain stable');
  assert.equal(provision[1], 'data');
  assert.equal(provision[3].toLowerCase(), '0xfff000');
  assert.equal(provision[4].toLowerCase(), '0x1000');
  assert.equal(0xFFF000 + 0x1000, 0x1000000, 'provisioning sector must end exactly at 16 MB');
});

test('firmware record format matches the browser magic/version and validates CRC before NVS save', async () => {
  const source = await readFile(IMPORTER, 'utf8');
  assert.match(source, /'I', 'N', 'K', 'P', 'V', '0', '0', '1'/);
  assert.match(source, /FORMAT_VERSION = 1/);
  assert.match(source, /0xEDB88320u/);

  const crcCheck = source.indexOf('actualCrc != expectedCrc');
  const save = source.indexOf('saveCredentials(incoming)');
  assert.ok(crcCheck > -1 && save > crcCheck,
    'corrupted flash data must be rejected before any credential reaches NVS');
});

test('successful flash-time import saves first, then erases the temporary password copy', async () => {
  const source = await readFile(IMPORTER, 'utf8');
  const save = source.indexOf('saveCredentials(incoming)');
  const erase = source.indexOf('erasePartition(partition)', save);
  assert.ok(save > -1 && erase > save,
    'temporary provisioning data must only be erased after durable NVS save succeeds');
  assert.match(source, /imported flash-time Wi-Fi\/server settings and erased temporary record/);
});

test('new-board boot imports flash-time settings before attempting USB or 192.168.4.1 fallback', async () => {
  const source = await readFile(SKETCH, 'utf8');
  const flashImport = source.indexOf('importFlashProvisioning()');
  const usb = source.indexOf('waitForUsbProvisioning(30000)');
  const portal = source.indexOf('runProvisioningPortal()', usb);

  assert.ok(flashImport > -1, 'new firmware must inspect the one-time flash record');
  assert.ok(usb > flashImport, 'USB is a fallback, not the normal new-board path');
  assert.ok(portal > usb, '192.168.4.1 recovery remains the final fallback only');
});

test('KEY3 clears both NVS credentials and a pending one-time flash record', async () => {
  const source = await readFile(SKETCH, 'utf8');
  const key3 = source.indexOf('if (digitalRead(Hardware::KEY3) == LOW)');
  const block = source.slice(key3, source.indexOf('\n  }', key3) + 4);
  assert.match(block, /clearCredentials\(\)/);
  assert.match(block, /clearFlashProvisioning\(\)/);
});
