import { parseArgs } from 'node:util';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { bufferToPng } from '../panel/quantise.ts';
import { WFT0583 } from '../panel/profile.ts';

const { values } = parseArgs({
  options: {
    server: { type: 'string', default: 'http://localhost:8080' },
    id: { type: 'string', default: 'esp32-fake01' },
    battery: { type: 'string', default: '4.02' },
    out: { type: 'string', default: 'frame.png' },
    once: { type: 'boolean', default: false },
    forget: { type: 'boolean', default: false },
  },
});

/**
 * Real firmware keeps its ETag in RTC memory across deep sleep, so a fresh
 * `--once` process must too. Without this the 304 path — the whole reason the
 * panel does not flash — cannot be exercised from the command line.
 */
const statePath = `${values.out}.etag`;

async function loadEtag(): Promise<string | null> {
  if (values.forget) {
    await rm(statePath, { force: true });
    return null;
  }
  try {
    return (await readFile(statePath, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

let etag: string | null = await loadEtag();

async function cycle(): Promise<number> {
  const headers: Record<string, string> = {
    'X-Battery-Voltage': values.battery!,
    'X-Firmware-Version': 'fake-0.1.0',
    'X-Wake-Reason': 'timer',
  };
  if (etag) headers['If-None-Match'] = etag;

  const res = await fetch(`${values.server}/api/devices/${values.id}/frame`, { headers });
  const wake = Number(res.headers.get('x-next-wake-seconds') ?? 900);

  if (res.status === 304) {
    console.log(`304 unchanged — sleeping ${wake}s (panel would NOT refresh)`);
    return wake;
  }
  if (!res.ok) {
    console.error(`${res.status} ${res.statusText} — sleeping ${wake}s, keeping last image`);
    return wake;
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length !== WFT0583.bytes) {
    throw new Error(`expected ${WFT0583.bytes} bytes, got ${buffer.length}`);
  }
  etag = res.headers.get('etag');
  await writeFile(values.out!, await bufferToPng(buffer, WFT0583));
  if (etag) await writeFile(statePath, etag, 'utf8');
  console.log(`200 ${buffer.length} bytes → ${values.out} (etag ${etag}) — sleeping ${wake}s`);
  return wake;
}

const wake = await cycle();
if (!values.once) {
  setInterval(() => {
    void cycle();
  }, wake * 1000);
}
