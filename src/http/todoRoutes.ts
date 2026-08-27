import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { DeviceStore } from '../devices/store.ts';
import {
  TodoStore,
  TodoStoreError,
  todoItemIdSchema,
  todoListIdSchema,
  todoListNameSchema,
  todoTaskTextSchema,
} from '../todo/store.ts';

const nameBodySchema = z.strictObject({ name: todoListNameSchema });
const taskBodySchema = z.strictObject({ text: todoTaskTextSchema });
const taskPatchSchema = z.strictObject({
  text: todoTaskTextSchema.optional(),
  completed: z.boolean().optional(),
}).refine((value) => value.text !== undefined || value.completed !== undefined, 'no task changes supplied');
const orderBodySchema = z.strictObject({ itemIds: z.array(todoItemIdSchema).max(500) });

function invalid(res: Response, parsed: z.ZodSafeParseError<unknown>): void {
  res.status(400).json({ error: 'invalid To Do request', issues: parsed.error.issues });
}

/** Authenticated CRUD for InkPanel-owned shared To Do lists. */
export function todoRoutes(devices: DeviceStore, todos: TodoStore): Router {
  const router = Router();

  router.get('/todo-lists', async (_req, res) => {
    res.set('cache-control', 'no-store');
    res.json({ lists: await todos.list() });
  });

  router.post('/todo-lists', async (req, res) => {
    const parsed = nameBodySchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed);
    res.status(201).json(await todos.create(parsed.data.name));
  });

  router.put('/todo-lists/:listId', async (req, res) => {
    const id = todoListIdSchema.safeParse(req.params.listId);
    const body = nameBodySchema.safeParse(req.body);
    if (!id.success) return invalid(res, id);
    if (!body.success) return invalid(res, body);
    res.json(await todos.rename(id.data, body.data.name));
  });

  router.delete('/todo-lists/:listId', async (req, res) => {
    const id = todoListIdSchema.safeParse(req.params.listId);
    if (!id.success) return invalid(res, id);
    const referencedBy = (await devices.list())
      .filter((device) => device.dashboardSections.some(
        (widget) => widget.type === 'todo' && 'listId' in widget.config && widget.config.listId === id.data,
      ))
      .map((device) => ({ id: device.id, name: device.name }));
    if (referencedBy.length > 0) {
      res.status(409).json({ error: 'To Do list is currently used by one or more panels', referencedBy });
      return;
    }
    await todos.delete(id.data);
    res.status(204).end();
  });

  router.post('/todo-lists/:listId/items', async (req, res) => {
    const id = todoListIdSchema.safeParse(req.params.listId);
    const body = taskBodySchema.safeParse(req.body);
    if (!id.success) return invalid(res, id);
    if (!body.success) return invalid(res, body);
    res.status(201).json(await todos.addItem(id.data, body.data.text));
  });

  router.put('/todo-lists/:listId/items/order', async (req, res) => {
    const id = todoListIdSchema.safeParse(req.params.listId);
    const body = orderBodySchema.safeParse(req.body);
    if (!id.success) return invalid(res, id);
    if (!body.success) return invalid(res, body);
    res.json(await todos.reorderItems(id.data, body.data.itemIds));
  });

  router.put('/todo-lists/:listId/items/:itemId', async (req, res) => {
    const listId = todoListIdSchema.safeParse(req.params.listId);
    const itemId = todoItemIdSchema.safeParse(req.params.itemId);
    const body = taskPatchSchema.safeParse(req.body);
    if (!listId.success) return invalid(res, listId);
    if (!itemId.success) return invalid(res, itemId);
    if (!body.success) return invalid(res, body);
    res.json(await todos.updateItem(listId.data, itemId.data, body.data));
  });

  router.delete('/todo-lists/:listId/items/:itemId', async (req, res) => {
    const listId = todoListIdSchema.safeParse(req.params.listId);
    const itemId = todoItemIdSchema.safeParse(req.params.itemId);
    if (!listId.success) return invalid(res, listId);
    if (!itemId.success) return invalid(res, itemId);
    await todos.deleteItem(listId.data, itemId.data);
    res.status(204).end();
  });

  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (!(err instanceof TodoStoreError)) return next(err);
    const status = err.code === 'todo_not_found' ? 404
      : err.code === 'todo_conflict' ? 409
        : err.code === 'todo_invalid' ? 400
          : 503;
    res.status(status).json({ error: err.message, code: err.code, backup: err.backupPath ? err.backupPath.split(/[\\/]/).pop() : null });
  });

  return router;
}
