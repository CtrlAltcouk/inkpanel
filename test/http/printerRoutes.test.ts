import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/http/app.ts';
import { DeviceStore } from '../../src/devices/store.ts';
import type { FrameService } from '../../src/render/frameService.ts';
import { MoonrakerClient } from '../../src/printers/moonraker.ts';
import { PrinterConnectionStore } from '../../src/printers/store.ts';

const frames = { warmUp: async () => {}, sourceIssues: () => [], renderedDeviceCount: () => 0 } as unknown as FrameService;

async function withServer(fn: (base: string, cookie: string, devices: DeviceStore, printers: PrinterConnectionStore) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-printer-http-'));
  const devices = new DeviceStore(join(dir, 'config.json'));
  const printers = new PrinterConnectionStore(join(dir, '.printer-connections.json'));
  const moonraker = new MoonrakerClient(async () => Response.json({ result: { status: {
    webhooks: { state: 'ready' }, print_stats: { state: 'idle' },
  } } }));
  const server = createApp({
    store: devices, frames, printerStore: printers, moonrakerClient: moonraker,
    publicBaseUrl: 'http://test.local:8080', runtimeState: { httpsPort: null }, dataDir: dir, firmwareDir: dir,
    auth: { password: 'hunter2', secret: randomBytes(32) },
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'hunter2' }) });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    await fn(base, cookie, devices, printers);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function request(base: string, cookie: string, method: string, path: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('printer CRUD is authenticated and API keys stay write-only with preserve/clear semantics', async () => {
  await withServer(async (base, cookie, _devices, store) => {
    assert.equal((await fetch(`${base}/api/printers`)).status, 401);
    const createdResponse = await request(base, cookie, 'POST', '/api/printers', { name: 'Voron', baseUrl: 'http://voron.local/', apiKey: 'super-secret' });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { id: string; apiKeyConfigured: boolean; apiKey?: string };
    assert.equal(created.apiKeyConfigured, true);
    assert.equal(created.apiKey, undefined);

    const listed = await (await request(base, cookie, 'GET', '/api/printers')).json() as { printers: Array<Record<string, unknown>> };
    assert.equal(listed.printers[0]?.apiKeyConfigured, true);
    assert.equal('apiKey' in listed.printers[0]!, false);
    assert.doesNotMatch(JSON.stringify(listed), /super-secret/);

    assert.equal((await request(base, cookie, 'PUT', `/api/printers/${created.id}`, { name: 'Voron 2.4', apiKey: '' })).status, 200);
    assert.equal((await store.get(created.id))?.apiKey, 'super-secret', 'blank update preserves the stored key');
    assert.equal((await request(base, cookie, 'PUT', `/api/printers/${created.id}`, { clearApiKey: true })).status, 200);
    assert.equal((await store.get(created.id))?.apiKey, null);

    const tested = await request(base, cookie, 'POST', `/api/printers/${created.id}/test`);
    assert.equal(tested.status, 200);
    const testBody = await tested.json() as { ok: boolean; status: { state: string } };
    assert.deepEqual(testBody, { ok: true, printer: { id: created.id, name: 'Voron 2.4', baseUrl: 'http://voron.local', apiKeyConfigured: false }, status: { state: 'idle', message: null } });

    assert.equal((await request(base, cookie, 'DELETE', `/api/printers/${created.id}`)).status, 204);
  });
});

test('malformed printer input fails and deleting a referenced connection returns conflict', async () => {
  await withServer(async (base, cookie, devices, printers) => {
    assert.equal((await request(base, cookie, 'POST', '/api/printers', { name: 'Bad', baseUrl: 'file:///etc/passwd' })).status, 400);
    assert.equal((await request(base, cookie, 'POST', '/api/printers', { name: 'Bad', baseUrl: 'http://user:pass@printer.local' })).status, 400);
    const printer = await printers.create({ name: 'Prusa', baseUrl: 'http://prusa.local' });
    const device = await devices.getOrCreate('esp32-printer');
    await devices.update(device.id, { dashboardSections: [
      { type: 'printers', version: 1, config: { printerIds: [printer.id] } },
      ...device.dashboardSections.slice(1),
    ] });
    const conflict = await request(base, cookie, 'DELETE', `/api/printers/${printer.id}`);
    assert.equal(conflict.status, 409);
    assert.deepEqual((await conflict.json() as { referencedBy: Array<{ id: string }> }).referencedBy.map((entry) => entry.id), [device.id]);
    assert.ok(await printers.get(printer.id));
  });
});

test('panel saves enforce known IDs, full-size maximum, and Mini single-printer rule', async () => {
  await withServer(async (base, cookie, devices, printers) => {
    const connections = await Promise.all(['One', 'Two', 'Three', 'Four'].map((name) => printers.create({ name, baseUrl: `http://${name.toLowerCase()}.local` })));
    const large = await devices.getOrCreate('esp32-large');
    const largeSections = [{ type: 'printers', version: 1, config: { printerIds: connections.map((printer) => printer.id) } }, ...large.dashboardSections.slice(1)];
    assert.equal((await request(base, cookie, 'PUT', `/api/devices/${large.id}`, { dashboardSections: largeSections })).status, 200);

    const unknownSections = structuredClone(largeSections);
    (unknownSections[0] as { config: { printerIds: string[] } }).config.printerIds = ['99999999-9999-4999-8999-999999999999'];
    assert.equal((await request(base, cookie, 'PUT', `/api/devices/${large.id}`, { dashboardSections: unknownSections })).status, 400);

    const mini = await devices.getOrCreate('esp32-mini-printer', 'ssd1681-200x200-mono');
    assert.equal((await request(base, cookie, 'PUT', `/api/devices/${mini.id}`, { dashboardSections: [{ type: 'printers', version: 1, config: { printerIds: [connections[0]!.id] } }] })).status, 200);
    assert.equal((await request(base, cookie, 'PUT', `/api/devices/${mini.id}`, { dashboardSections: [{ type: 'printers', version: 1, config: { printerIds: [connections[0]!.id, connections[1]!.id] } }] })).status, 400);
  });
});
