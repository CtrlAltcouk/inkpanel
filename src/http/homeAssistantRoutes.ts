import { Router } from 'express';
import type { HomeAssistantClient } from '../homeAssistant/client.ts';

export function homeAssistantRoutes(client: HomeAssistantClient): Router {
  const router = Router();
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
