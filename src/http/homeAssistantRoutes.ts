import { Router } from 'express';
import type { HomeAssistantClient } from '../homeAssistant/client.ts';
import { homeAssistantUserIdSchema } from '../homeAssistant/ingressUser.ts';
import { todoAssignmentsSchema, type HomeAssistantUserStore } from '../homeAssistant/userStore.ts';
import { z } from 'zod';

export function homeAssistantRoutes(client: HomeAssistantClient, users: HomeAssistantUserStore): Router {
  const router = Router();
  const personalPaths = ['/home-assistant/current-user', '/home-assistant/my-todo-lists', '/home-assistant/users'];
  router.use(personalPaths, (_req, res, next) => {
    res.set('cache-control', 'no-store');
    if (res.locals.homeAssistantIngress && !res.locals.homeAssistantUser) {
      res.status(403).json({ error: 'Valid trusted Home Assistant user identity required' });
      return;
    }
    next();
  });
  router.get('/home-assistant/current-user', (_req, res) => {
    res.json(res.locals.homeAssistantUser
      ? { available: true, user: res.locals.homeAssistantUser }
      : { available: false, user: null, accessMode: 'lan' });
  });
  router.get('/home-assistant/my-todo-lists', async (_req, res) => {
    const identity = res.locals.homeAssistantUser;
    if (!identity) { res.status(403).json({ error: 'Trusted Home Assistant Ingress identity required' }); return; }
    const assigned = (await users.list()).find((user) => user.userId === identity.id)?.todoEntityIds ?? [];
    const discovery = await client.listTodoLists();
    res.json({ available: discovery.available, lists: assigned.map((entityId) =>
      discovery.lists.find((list) => list.entityId === entityId) ?? { entityId, name: `${entityId} (missing/unavailable)` }) });
  });
  // These are administrative routes: LAN auth or the admin-only Ingress sidebar.
  router.get('/home-assistant/users', async (_req, res) => { res.json({ users: await users.list() }); });
  router.put('/home-assistant/users/:id', async (req, res) => {
    const id = homeAssistantUserIdSchema.safeParse(req.params.id);
    const body = z.strictObject({ todoEntityIds: todoAssignmentsSchema }).safeParse(req.body);
    if (!id.success || !body.success) { res.status(400).json({ error: 'Invalid ownership assignment' }); return; }
    await users.assign(id.data, body.data.todoEntityIds);
    res.json({ ok: true });
  });
  router.delete('/home-assistant/users/:id', async (req, res) => {
    const id = homeAssistantUserIdSchema.safeParse(req.params.id);
    if (!id.success) { res.status(400).json({ error: 'Invalid user ID' }); return; }
    await users.remove(id.data);
    res.json({ ok: true });
  });
  router.get('/home-assistant/sensors', async (_req, res) => {
    res.set('cache-control', 'no-store');
    res.json(await client.listSensors());
  });
  router.get('/home-assistant/todo-lists', async (_req, res) => {
    res.set('cache-control', 'no-store');
    res.json(await client.listTodoLists());
  });
  router.get('/home-assistant/calendars', async (_req, res) => {
    res.set('cache-control', 'no-store');
    res.json(await client.listCalendars());
  });
  router.get('/home-assistant/status', async (_req, res) => {
    res.set('cache-control', 'no-store');
    res.json(await client.status());
  });
  return router;
}
