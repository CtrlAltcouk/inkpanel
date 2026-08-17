import { basename } from 'node:path';
import { z } from 'zod';
import type { PrinterConnection } from './store.ts';

export const MOONRAKER_OBJECT_QUERY = {
  objects: {
    webhooks: ['state', 'state_message'],
    print_stats: ['filename', 'total_duration', 'print_duration', 'state', 'message', 'info'],
    virtual_sdcard: ['progress', 'is_active', 'file_path'],
    display_status: ['progress'],
    extruder: ['temperature', 'target'],
    heater_bed: ['temperature', 'target'],
  },
} as const;

export type PrinterDisplayState = 'printing' | 'paused' | 'complete' | 'cancelled' | 'error' | 'idle' | 'offline';
export interface PrinterTemperature { current: number; target: number; }
export interface PrinterStatus {
  name: string;
  state: PrinterDisplayState;
  filename: string | null;
  progressPercent: number | null;
  elapsedSeconds: number | null;
  remainingSeconds: number | null;
  currentLayer: number | null;
  totalLayers: number | null;
  nozzle: PrinterTemperature | null;
  bed: PrinterTemperature | null;
  message: string | null;
}

const queryResponseSchema = z.object({
  result: z.object({ status: z.record(z.string(), z.unknown()) }).optional(),
  status: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function finite(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function nonNegative(value: unknown): number | null { const n = finite(value); return n !== null && n >= 0 ? n : null; }
function rounded(value: unknown): number | null { const n = finite(value); return n === null ? null : Math.round(n); }
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : null; }
function temperature(value: unknown): PrinterTemperature | null {
  const data = object(value);
  const current = rounded(data.temperature);
  const target = rounded(data.target);
  return current === null || target === null ? null : { current, target };
}
function state(value: unknown, webhooks: Record<string, unknown>): PrinterDisplayState {
  const webhookState = text(webhooks.state)?.toLowerCase();
  if (webhookState && webhookState !== 'ready') return 'error';
  switch (text(value)?.toLowerCase()) {
    case 'printing': return 'printing';
    case 'paused': return 'paused';
    case 'complete': return 'complete';
    case 'cancelled': return 'cancelled';
    case 'error': return 'error';
    default: return 'idle';
  }
}

function endpoint(baseUrl: string, path: string): URL {
  return new URL(path.replace(/^\//, ''), `${baseUrl}/`);
}

async function checkedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Moonraker request failed (${response.status})`);
  try { return await response.json(); } catch { throw new Error('Moonraker returned invalid JSON'); }
}

export class MoonrakerClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 5000) {}

  private headers(connection: PrinterConnection, json = false): HeadersInit {
    return {
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(connection.apiKey ? { 'X-Api-Key': connection.apiKey } : {}),
    };
  }

  private signal(external?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return external ? AbortSignal.any([external, timeout]) : timeout;
  }

  async query(connection: PrinterConnection, externalSignal?: AbortSignal): Promise<PrinterStatus> {
    const signal = this.signal(externalSignal);
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint(connection.baseUrl, '/printer/objects/query'), {
        method: 'POST', headers: this.headers(connection, true), body: JSON.stringify(MOONRAKER_OBJECT_QUERY), signal,
      });
    } catch {
      throw new Error('Moonraker unavailable');
    }
    const parsed = queryResponseSchema.safeParse(await checkedJson(response));
    if (!parsed.success) throw new Error('Moonraker returned an invalid printer response');
    const status = parsed.data.result?.status ?? parsed.data.status;
    if (!status || Object.keys(status).length === 0) throw new Error('Moonraker returned no printer status');
    const webhooks = object(status.webhooks);
    const stats = object(status.print_stats);
    const virtualSd = object(status.virtual_sdcard);
    const display = object(status.display_status);
    const info = object(stats.info);
    const rawProgress = finite(display.progress) ?? finite(virtualSd.progress);
    const filename = text(stats.filename);
    const printState = state(stats.state, webhooks);
    const printDuration = nonNegative(stats.print_duration);
    let remainingSeconds: number | null = null;

    if (filename && (printState === 'printing' || printState === 'paused')) {
      try {
        const metadataUrl = endpoint(connection.baseUrl, '/server/files/metadata');
        metadataUrl.searchParams.set('filename', filename);
        const metadata = object(await checkedJson(await this.fetchImpl(metadataUrl, {
          headers: this.headers(connection), signal,
        })));
        const result = object(metadata.result);
        const estimate = nonNegative(result.estimated_time);
        if (estimate !== null && printDuration !== null) remainingSeconds = Math.max(0, Math.round(estimate - printDuration));
      } catch {
        // Metadata is an optional enhancement. Live object status remains useful.
      }
    }

    const currentLayer = nonNegative(info.current_layer);
    const totalLayers = nonNegative(info.total_layer);
    return {
      name: connection.name,
      state: printState,
      filename: filename ? basename(filename.replaceAll('\\', '/')) : null,
      progressPercent: rawProgress === null ? null : Math.round(Math.min(1, Math.max(0, rawProgress)) * 100),
      elapsedSeconds: printDuration === null ? null : Math.round(printDuration),
      remainingSeconds,
      currentLayer: currentLayer && currentLayer > 0 ? Math.round(currentLayer) : null,
      totalLayers: totalLayers && totalLayers > 0 ? Math.round(totalLayers) : null,
      nozzle: temperature(status.extruder),
      bed: temperature(status.heater_bed),
      message: text(stats.message) ?? (printState === 'error' ? text(webhooks.state_message) : null),
    };
  }
}

export function offlinePrinter(name: string): PrinterStatus {
  return {
    name, state: 'offline', filename: null, progressPercent: null,
    elapsedSeconds: null, remainingSeconds: null, currentLayer: null, totalLayers: null,
    nozzle: null, bed: null, message: 'Moonraker unavailable',
  };
}
