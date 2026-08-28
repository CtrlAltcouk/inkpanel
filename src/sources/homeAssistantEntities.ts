import type { HomeAssistantClient } from '../homeAssistant/client.ts';
import { sensorFallbackName, type HomeAssistantSensorState } from '../homeAssistant/sensorSchemas.ts';
import type { EntitiesData } from '../model/dashboard.ts';
import { runLiveSource, type RunOutcome, type RunSourceOptions } from './runner.ts';
import type { Source } from './types.ts';

/** Live-only current state, never persisted/replayed from SourceCache. */
export async function runHomeAssistantEntities(
  entityIds: string[], client: HomeAssistantClient | undefined, options: RunSourceOptions,
): Promise<RunOutcome<EntitiesData>> {
  const source: Source<string, HomeAssistantSensorState> = {
    id: 'home-assistant-sensors',
    async fetch(id, signal) {
      try {
        const result = await client?.getSensorState(id, signal);
        return result?.available
          ? { status: 'ok', data: result.data, fetchedAt: new Date().toISOString() }
          : { status: 'error', error: result?.error ?? 'Home Assistant sensors are unavailable' };
      } catch {
        return { status: 'error', error: 'Home Assistant sensors are unavailable' };
      }
    },
  };
  const results = await Promise.all(entityIds.map((id) => runLiveSource(source, id, options)));
  const anyResponse = results.some((result) => result.data !== null);
  const allAvailable = results.every((result) => result.data?.available);
  return {
    data: anyResponse ? { items: results.map(({ data }, index) => ({
      name: data?.name ?? sensorFallbackName(entityIds[index]!),
      value: data?.available ? data.state : '',
      unit: data?.available ? data.unit : null,
      available: data?.available ?? false,
    })) } : null,
    health: { id: source.id, status: allAvailable ? 'ok' : 'error',
      fetchedAt: anyResponse ? new Date().toISOString() : null,
      error: allAvailable ? null : 'One or more Home Assistant sensors are unavailable' },
  };
}
