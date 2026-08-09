import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('firmware keeps the existing final-three-MAC-byte device ID protocol', async () => {
  const source = await readFile(join(process.cwd(), 'firmware', 'inkpanel', 'FrameClient.cpp'), 'utf8');
  assert.match(source, /esp_read_mac\(mac, ESP_MAC_WIFI_STA\)/);
  assert.match(
    source,
    /snprintf\(out, len, "esp32-%02x%02x%02x", mac\[3\], mac\[4\], mac\[5\]\)/,
  );
});
