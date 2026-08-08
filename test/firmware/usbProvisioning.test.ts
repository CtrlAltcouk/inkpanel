import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const PROVISIONING = join(process.cwd(), 'firmware', 'inkpanel', 'Provisioning.cpp');
const SKETCH = join(process.cwd(), 'firmware', 'inkpanel', 'inkpanel.ino');

test('firmware and browser protocol has explicit ready, command, saved and error markers', async () => {
  const source = await readFile(PROVISIONING, 'utf8');
  assert.match(source, /INKPANEL_READY_V1/);
  assert.match(source, /INKPANEL_PROVISION_V1\|/);
  assert.match(source, /INKPANEL_SAVED_V1/);
  assert.match(source, /INKPANEL_ERROR_V1\|/);
  assert.match(source, /mbedtls_base64_decode/,
    'credentials should be encoded so delimiters and non-ASCII SSIDs survive the serial protocol');
});

test('USB and captive-portal setup share the same credential persistence function', async () => {
  const source = await readFile(PROVISIONING, 'utf8');
  const calls = source.match(/saveCredentials\(/g) ?? [];
  assert.ok(calls.length >= 3,
    'expected definition plus calls from USB provisioning and captive portal');
  assert.match(source, /prefs\.putString\("ssid"/);
  assert.match(source, /prefs\.putString\("pass"/);
  assert.match(source, /prefs\.putString\("url"/);
});

test('fresh firmware offers USB provisioning before falling back to the recovery portal', async () => {
  const source = await readFile(SKETCH, 'utf8');
  const usb = source.indexOf('waitForUsbProvisioning(30000)');
  const portal = source.indexOf('no USB credentials received — starting portal fallback');
  assert.ok(usb > -1, 'fresh boards must wait for the browser provisioning channel');
  assert.ok(portal > usb, 'captive portal must be the fallback after USB provisioning, not the primary path');
});

test('USB provisioning remains live while the 192.168.4.1 recovery portal is running', async () => {
  const source = await readFile(PROVISIONING, 'utf8');
  const portal = source.indexOf('void runProvisioningPortal()');
  assert.ok(portal > -1);
  const portalBody = source.slice(portal);
  assert.match(portalBody, /emitUsbReadyIfDue\(\)/,
    'recovery mode must continue advertising the USB setup protocol');
  assert.match(portalBody, /serviceUsbProvisioning\(\)/,
    'recovery mode must keep accepting USB provisioning commands');
  assert.match(portalBody, /USB credentials saved in recovery mode/,
    'a successful late USB configuration should restart into normal operation');
});
