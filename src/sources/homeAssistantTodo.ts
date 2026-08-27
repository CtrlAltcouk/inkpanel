import type { HomeAssistantClient } from '../homeAssistant/client.ts';
import type { TodoData } from '../model/dashboard.ts';
import { runLiveSource, type RunSourceOptions } from './runner.ts';
import type { Source } from './types.ts';

/** Task completion is live-only: never replay a stale task list from disk. */
export function runHomeAssistantTodo(entityId: string, client: HomeAssistantClient | undefined, options: RunSourceOptions) {
  const source: Source<string, TodoData> = {
    id: 'home-assistant-todo',
    async fetch(id, signal) {
      try {
        const result = await client?.getTodoItems(id, signal);
        return result?.available
          ? { status: 'ok', data: result.data, fetchedAt: new Date().toISOString() }
          : { status: 'error', error: result?.error ?? 'Home Assistant To Do is unavailable' };
      } catch {
        return { status: 'error', error: 'Home Assistant To Do is unavailable' };
      }
    },
  };
  return runLiveSource(source, entityId, options);
}
