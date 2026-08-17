import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { DeviceStore } from '../devices/store.ts';
import { MoonrakerClient } from '../printers/moonraker.ts';
import {
  moonrakerUrlSchema,
  printerApiKeySchema,
  PrinterConnectionStore,
  PrinterStoreError,
  printerIdSchema,
  printerNameSchema,
  publicPrinter,
} from '../printers/store.ts';

const createSchema = z.strictObject({
  name: printerNameSchema,
  baseUrl: moonrakerUrlSchema,
  apiKey: printerApiKeySchema.optional(),
});
const updateSchema = z.strictObject({
  name: printerNameSchema.optional(),
  baseUrl: moonrakerUrlSchema.optional(),
  apiKey: printerApiKeySchema.optional(),
  clearApiKey: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, 'no printer changes supplied')
  .refine((value) => !(value.clearApiKey && value.apiKey?.trim()), 'cannot set and clear the API key together');

function invalid(res: Response, parsed: z.ZodSafeParseError<unknown>): void {
  res.status(400).json({ error: 'invalid printer request', issues: parsed.error.issues });
}

/** Authenticated shared connection management. Stored API keys are write-only. */
export function printerRoutes(devices: DeviceStore, printers: PrinterConnectionStore, moonraker: MoonrakerClient): Router {
  const router = Router();

  router.get('/printers', async (_req, res) => {
    res.set('cache-control', 'no-store');
    res.json({ printers: await printers.listPublic() });
  });

  router.post('/printers', async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed);
    const created = await printers.create(parsed.data);
    res.status(201).json(publicPrinter(created));
  });

  router.put('/printers/:id', async (req, res) => {
    const id = printerIdSchema.safeParse(req.params.id);
    const body = updateSchema.safeParse(req.body);
    if (!id.success) return invalid(res, id);
    if (!body.success) return invalid(res, body);
    const apiKey = body.data.clearApiKey ? null
      : body.data.apiKey?.trim() ? body.data.apiKey : undefined;
    const updated = await printers.update(id.data, {
      ...(body.data.name === undefined ? {} : { name: body.data.name }),
      ...(body.data.baseUrl === undefined ? {} : { baseUrl: body.data.baseUrl }),
      ...(apiKey === undefined ? {} : { apiKey }),
    });
    res.json(publicPrinter(updated));
  });

  router.delete('/printers/:id', async (req, res) => {
    const id = printerIdSchema.safeParse(req.params.id);
    if (!id.success) return invalid(res, id);
    const referencedBy = (await devices.list())
      .filter((device) => device.dashboardSections.some(
        (widget) => widget.type === 'printers' && widget.config.printerIds.includes(id.data),
      ))
      .map((device) => ({ id: device.id, name: device.name }));
    if (referencedBy.length > 0) {
      res.status(409).json({ error: 'printer is currently used by one or more panels', referencedBy });
      return;
    }
    await printers.delete(id.data);
    res.status(204).end();
  });

  router.post('/printers/:id/test', async (req, res) => {
    const id = printerIdSchema.safeParse(req.params.id);
    if (!id.success) return invalid(res, id);
    const printer = await printers.get(id.data);
    if (!printer) throw new PrinterStoreError('printer_not_found', `unknown printer: ${id.data}`);
    try {
      const status = await moonraker.query(printer);
      res.json({ ok: true, printer: publicPrinter(printer), status: { state: status.state, message: status.message } });
    } catch (err) {
      res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'Moonraker connection failed' });
    }
  });

  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (!(err instanceof PrinterStoreError)) return next(err);
    const status = err.code === 'printer_not_found' ? 404
      : err.code === 'printer_conflict' ? 409
        : err.code === 'printer_invalid' ? 400
          : 503;
    res.status(status).json({ error: err.message, code: err.code, backup: err.backupPath ? err.backupPath.split(/[\\/]/).pop() : null });
  });
  return router;
}
