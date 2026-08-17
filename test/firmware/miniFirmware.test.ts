import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const repo = process.cwd();
const read = (path: string) => readFile(join(repo, path), 'utf8');

test('Mini firmware advertises the 200x200 profile and keeps the large default', async () => {
  const config = await read('firmware/inkpanel/config.h');

  assert.match(config, /#ifndef INKPANEL_MINI/);
  assert.match(config, /PANEL_PROFILE_ID = nullptr/);
  assert.match(config, /PANEL_PROFILE_ID = "ssd1681-200x200-mono"/);
  assert.match(config, /FIRMWARE_VERSION = "0\.1\.4"/);
  assert.match(config, /FIRMWARE_VERSION = "0\.2\.0-mini\.1"/);
});

test('Mini display buffer is exactly 200x200 at one bit per pixel', async () => {
  const header = await read('firmware/inkpanel/MiniEPD.h');

  assert.match(header, /WIDTH = 200/);
  assert.match(header, /HEIGHT = 200/);
  assert.match(header, /BUFFER_SIZE = static_cast<size_t>\(WIDTH\) \* HEIGHT \/ 8/);
});

test('SSD1681 driver owns polarity conversion and active-high BUSY handling', async () => {
  const source = await read('firmware/inkpanel/MiniEPD.cpp');

  assert.match(source, /chunk\[i\] = static_cast<uint8_t>\(~values\[sent \+ i\]\)/);
  assert.match(source, /digitalRead\(Hardware::EPD_BUSY\) == HIGH/);
  assert.match(source, /command\(0x26\)[\s\S]*command\(0x24\)/);
  assert.match(source, /command\(0x22\)[\s\S]*data\(0xF7\)[\s\S]*command\(0x20\)/);
});

test('Mini frame requests send a profile header but omit unknown battery telemetry', async () => {
  const frameClient = await read('firmware/inkpanel/FrameClient.cpp');
  const sketch = await read('firmware/inkpanel/inkpanel.ino');

  assert.match(frameClient, /http\.addHeader\("X-InkPanel-Profile", panelProfileId\)/);
  assert.match(frameClient, /if \(isfinite\(batteryVolts\) && batteryVolts > 0\.0f\)/);
  assert.match(sketch, /#ifdef INKPANEL_MINI[\s\S]*return NAN;/);
  assert.match(sketch, /ActiveEPD::BUFFER_SIZE/);
});

test('Mini compile uses the standard XIAO ESP32-S3 and its own 8 MB partition map', async () => {
  const script = await read('scripts/compile-mini-firmware.sh');
  const partitions = await read('firmware/inkpanel/partitions-mini.csv');

  assert.match(script, /esp32:esp32:XIAO_ESP32S3/);
  assert.doesNotMatch(script, /MINI_FQBN:-esp32:esp32:XIAO_ESP32S3_Plus/);
  assert.match(script, /compiler\.cpp\.extra_flags=-DINKPANEL_MINI=1/);
  assert.match(partitions, /provision,\s+data,\s+0x40,\s+0x7FF000,\s+0x1000/);
});
