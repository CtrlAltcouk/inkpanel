import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { firmwareRoutes } from '../../src/http/firmwareRoutes.ts';

test('firmware manifest API forwards the compiled provisioning partition unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-fw-api-'));
  const app = express();
  app.use('/api', firmwareRoutes(dir, 'http://192.168.1.50:8080'));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;

  try {
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({
      version: '0.1.2',
      builtAt: '2026-08-08T21:00:00.000Z',
      parts: [{ path: 'merged.bin', offset: 0 }],
      updateParts: [{ path: 'app.bin', offset: 0x10000 }],
      provisioning: { offset: 0xFF0000, size: 0x1000, format: 1 },
    }));

    const response = await fetch(`http://127.0.0.1:${port}/api/firmware/manifest`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.provisioning, { offset: 0xFF0000, size: 0x1000, format: 1 });
    assert.equal(body.serverUrl, 'http://192.168.1.50:8080');
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
