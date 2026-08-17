import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../../src/devices/store.ts';
import { FrameService } from '../../src/render/frameService.ts';
import { Renderer } from '../../src/render/browser.ts';
import { SourceCache } from '../../src/sources/cache.ts';
import type { Source } from '../../src/sources/types.ts';
import type { WeatherData } from '../../src/model/dashboard.ts';
import { PrinterConnectionStore } from '../../src/printers/store.ts';
import type { MoonrakerClient, PrinterStatus } from '../../src/printers/moonraker.ts';
import { WEATHER } from '../fixtures/dashboard.ts';

const weatherSource: Source<{ latitude: number; longitude: number; timezone: string }, WeatherData> = {
  id: 'weather', async fetch() { return { status: 'ok', data: WEATHER, fetchedAt: '2026-08-03T08:00:00.000Z' }; },
};
function status(name: string, progressPercent: number): PrinterStatus {
  return { name, state: 'printing', filename: `${name}.gcode`, progressPercent, elapsedSeconds: 10, remainingSeconds: 90, currentLayer: 1, totalLayers: 10, nozzle: null, bed: null, message: null };
}

test('selected printers fetch concurrently, isolate offline failures, stay live-only, and preserve ETags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-printer-frame-'));
  const devices = new DeviceStore(join(dir, 'config.json'));
  const printers = new PrinterConnectionStore(join(dir, '.printer-connections.json'));
  const connections = await Promise.all(['Voron', 'Offline', 'Prusa'].map((name) => printers.create({ name, baseUrl: `http://${name.toLowerCase()}.local` })));
  const values = new Map([
    [connections[0]!.id, status('Voron', 68)],
    [connections[2]!.id, status('Prusa', 22)],
  ]);
  let active = 0;
  let maxActive = 0;
  const client = {
    async query(connection: { id: string; name: string }) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      const value = values.get(connection.id);
      if (!value) throw new Error('offline');
      return structuredClone(value);
    },
  } as unknown as MoonrakerClient;
  const renderer = new Renderer();
  const cacheDir = join(dir, 'cache');
  const frames = new FrameService({ renderer, cache: new SourceCache(cacheDir), weatherSource, printerStore: printers, moonrakerClient: client });
  try {
    const device = await devices.getOrCreate('esp32-printers');
    await devices.update(device.id, { claimed: true, dashboardSections: [
      { type: 'printers', version: 1, config: { printerIds: connections.map((printer) => printer.id) } },
      ...device.dashboardSections.slice(1),
    ] });
    const saved = (await devices.get(device.id))!;
    const html = await frames.previewHtml(saved);
    assert.ok(maxActive >= 3, 'all selected Moonraker connections overlap');
    assert.match(html, /Voron/);
    assert.match(html, /Prusa/);
    assert.match(html, /Offline/);
    assert.match(html, /OFFLINE/);

    const cacheFiles = await readdir(cacheDir);
    const cacheText = (await Promise.all(cacheFiles.map((file) => readFile(join(cacheDir, file), 'utf8')))).join('\n');
    assert.doesNotMatch(cacheText, /Voron|Prusa|Moonraker|gcode/, 'printer status is never persisted through SourceCache');

    const before = await frames.frameFor(saved, null);
    assert.equal((await frames.frameFor(saved, null)).etag, before.etag);
    values.set(connections[0]!.id, status('Voron', 69));
    assert.notEqual((await frames.frameFor(saved, null)).etag, before.etag);
    const visible = await frames.frameFor(saved, null);
    values.set(connections[0]!.id, { ...status('Voron', 69), elapsedSeconds: 9999 });
    assert.equal((await frames.frameFor(saved, null)).etag, visible.etag, 'hidden elapsed changes reuse the framebuffer');
  } finally {
    await renderer.close();
    await rm(dir, { recursive: true, force: true });
  }
});
