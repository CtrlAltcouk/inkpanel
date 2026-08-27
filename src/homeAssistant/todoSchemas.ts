import { z } from 'zod';

export const todoEntityIdSchema = z.string().max(255).regex(/^todo\.[a-z0-9_]+$/, 'invalid Home Assistant To Do entity ID');

/** Validate the states envelope, then project only To Do identities and names. */
export const homeAssistantTodoListsSchema = z.array(z.object({
  entity_id: z.string().min(1), attributes: z.unknown().optional(),
})).transform((states, ctx) => {
  const lists: Array<{ entityId: string; name: string }> = [];
  for (const state of states.filter((entry) => entry.entity_id.startsWith('todo.'))) {
    const id = todoEntityIdSchema.safeParse(state.entity_id);
    if (!id.success) {
      ctx.addIssue({ code: 'custom', message: 'invalid To Do entity ID' });
      return z.NEVER;
    }
    const attributes = z.object({ friendly_name: z.unknown().optional() }).safeParse(state.attributes);
    const name = z.string().trim().min(1).max(255).safeParse(attributes.success ? attributes.data.friendly_name : undefined);
    lists.push({ entityId: id.data, name: name.success ? name.data : id.data.slice(5).replaceAll('_', ' ') });
  }
  return [...new Map(lists.map((list) => [list.entityId, list])).values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.entityId.localeCompare(b.entityId));
});

const itemSchema = z.object({
  summary: z.string().trim().min(1).max(4096),
  status: z.enum(['needs_action', 'completed']),
});

export function homeAssistantTodoResponseSchema(entityId: string) {
  return z.object({
    changed_states: z.array(z.unknown()),
    service_response: z.object({ [entityId]: z.object({ items: z.array(itemSchema) }) }),
  }).transform((response) => ({
    items: response.service_response[entityId]!.items
      .filter((item) => item.status === 'needs_action').slice(0, 5).map((item) => item.summary),
  }));
}
