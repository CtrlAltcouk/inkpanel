import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function sketchSource(): Promise<string> {
  return readFile(join(process.cwd(), 'firmware', 'inkpanel', 'inkpanel.ino'), 'utf8');
}

test('network success alone does not clear the failure streak before a changed frame is drawn', async () => {
  const source = await sketchSource();

  assert.doesNotMatch(
    source,
    /if \(outcome\.result == FetchResult::Failed\)[\s\S]*?sleepFor\(backoffSeconds\(\)\);\n  \}\n\n  consecutiveFailures = 0;/,
  );
});

test('a failed display refresh increments the persisted failure streak and uses exponential backoff', async () => {
  const source = await sketchSource();
  const failedDisplay = source.indexOf('if (!display.begin() || !display.display(display.framebuffer()))');
  const failureIncrement = source.indexOf('consecutiveFailures++;', failedDisplay);
  const backoffSleep = source.indexOf('sleepFor(backoffSeconds());', failedDisplay);
  const etagWrite = source.indexOf('snprintf(storedEtag', failedDisplay);

  assert.ok(failedDisplay >= 0, 'changed-frame display failure branch exists');
  assert.ok(failureIncrement > failedDisplay, 'display failure increments the RTC-persisted streak');
  assert.ok(backoffSleep > failureIncrement, 'display failure sleeps using exponential backoff');
  assert.ok(etagWrite > backoffSleep, 'failed display path cannot commit the new ETag');
});

test('304 is a healthy cycle that resets failures without powering the display', async () => {
  const source = await sketchSource();
  assert.match(
    source,
    /if \(outcome\.result == FetchResult::NotModified\) \{[\s\S]*?consecutiveFailures = 0;[\s\S]*?\[epd\] unchanged, no refresh[\s\S]*?sleepFor\(outcome\.nextWakeSeconds\);/,
  );
});

test('a successful physical refresh stores the new ETag and clears failures', async () => {
  const source = await sketchSource();
  const displayGuard = source.indexOf('if (!display.begin() || !display.display(display.framebuffer()))');
  const etagWrite = source.indexOf('snprintf(storedEtag', displayGuard);
  const reset = source.indexOf('consecutiveFailures = 0;', etagWrite);
  const normalSleep = source.indexOf('sleepFor(outcome.nextWakeSeconds);', reset);

  assert.ok(etagWrite > displayGuard, 'new ETag is committed only after the display failure guard');
  assert.ok(reset > etagWrite, 'success clears the failure streak after committing the drawn frame');
  assert.ok(normalSleep > reset, 'successful refresh returns to the server-directed cadence');
});

test('deep-sleep cleanup always cuts the e-paper power rail', async () => {
  const source = await sketchSource();
  assert.match(
    source,
    /static void sleepFor\(uint32_t seconds\)[\s\S]*?digitalWrite\(Hardware::EPD_ENABLE, LOW\)/,
  );
});

test('firmware version records the display-backoff behaviour change', async () => {
  const config = await readFile(join(process.cwd(), 'firmware', 'inkpanel', 'config.h'), 'utf8');
  assert.match(config, /FIRMWARE_VERSION = "0\.1\.4"/);
});
