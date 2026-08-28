import type { HomeAssistantClient } from '../homeAssistant/client.ts';
import type { TodoData } from '../model/dashboard.ts';
import { runLiveSource, type RunSourceOptions } from './runner.ts';
import type { Source } from './types.ts';
import type { HomeAssistantUserStore } from '../homeAssistant/userStore.ts';
import { todoWidgetV3Schema } from '../widgets/registry.ts';

/** Task completion is live-only: never replay a stale task list from disk. */
export function runHomeAssistantTodo(entityId: string, client: HomeAssistantClient | undefined, options: RunSourceOptions,
  ownership?: { ownerUserId: string; store: HomeAssistantUserStore | undefined }) {
  const source: Source<string, TodoData> = {
    id: 'home-assistant-todo',
    async fetch(id, signal) {
      try {
        const authorized = async () => !ownership || (
          todoWidgetV3Schema.safeParse({ type: 'todo', version: 3,
            config: { provider: 'home-assistant', ownerUserId: ownership.ownerUserId, entityId: id } }).success
          && await ownership.store?.assigned(ownership.ownerUserId, id) === true);
        if (!await authorized()) return { status: 'error', error: 'Home Assistant To Do ownership is unavailable or no longer assigned' };
        const result = await client?.getTodoItems(id, signal);
        // Revocation during a live request must not display the just-fetched tasks.
        if (!await authorized()) return { status: 'error', error: 'Home Assistant To Do ownership is unavailable or no longer assigned' };
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
