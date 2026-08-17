import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { z } from 'zod';

export const printerIdSchema = z.string().uuid('invalid printer id');
export const printerNameSchema = z.string().trim().min(1).max(64);
export const printerApiKeySchema = z.string().trim().max(512);

export function normalizeMoonrakerUrl(value: string): string {
  const trimmed = value.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  const schemeSuffix = scheme ? trimmed.slice(scheme[0].length) : '';
  const explicitScheme = Boolean(scheme && !/^\d+(?:$|[/?#])/.test(schemeSuffix));
  const normalizedInput = /^https?:\/\//i.test(trimmed) || explicitScheme
    ? trimmed
    : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(normalizedInput);
  } catch {
    throw new Error('invalid Moonraker URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Moonraker URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) throw new Error('Moonraker URL must not contain credentials');
  if (!url.hostname) throw new Error('Moonraker URL must include a hostname');
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '';
  return url.toString().replace(/\/$/, '');
}

export const moonrakerUrlSchema = z.string().transform((value, ctx) => {
  try {
    return normalizeMoonrakerUrl(value);
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: err instanceof Error ? err.message : 'invalid Moonraker URL' });
    return z.NEVER;
  }
});

export const printerConnectionSchema = z.strictObject({
  id: printerIdSchema,
  name: printerNameSchema,
  baseUrl: moonrakerUrlSchema,
  apiKey: printerApiKeySchema.nullable(),
});

export const printerConnectionsFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  printers: z.array(printerConnectionSchema).max(20),
}).superRefine((file, ctx) => {
  const ids = new Set<string>();
  const names = new Set<string>();
  file.printers.forEach((printer, index) => {
    if (ids.has(printer.id)) ctx.addIssue({ code: 'custom', path: ['printers', index, 'id'], message: `duplicate printer id: ${printer.id}` });
    ids.add(printer.id);
    const folded = printer.name.toLocaleLowerCase('en-GB');
    if (names.has(folded)) ctx.addIssue({ code: 'custom', path: ['printers', index, 'name'], message: `duplicate printer name: ${printer.name}` });
    names.add(folded);
  });
});

export type PrinterConnection = z.infer<typeof printerConnectionSchema>;
type PrinterConnectionsFile = z.infer<typeof printerConnectionsFileSchema>;
export type PublicPrinterConnection = Omit<PrinterConnection, 'apiKey'> & { apiKeyConfigured: boolean };

export type PrinterStoreErrorCode = 'printer_corrupt' | 'printer_invalid' | 'printer_io' | 'printer_not_found' | 'printer_conflict';

export class PrinterStoreError extends Error {
  readonly name = 'PrinterStoreError';
  constructor(readonly code: PrinterStoreErrorCode, message: string, readonly backupPath: string | null = null) { super(message); }
}

function errnoCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function reason(err: z.ZodError): string {
  return err.issues.map((issue) => `${issue.path.map(String).join('.') || 'file'}: ${issue.message}`).join('; ');
}

function emptyFile(): PrinterConnectionsFile { return { schemaVersion: 1, printers: [] }; }
function clone<T>(value: T): T { return structuredClone(value); }
export function publicPrinter(printer: PrinterConnection): PublicPrinterConnection {
  return { id: printer.id, name: printer.name, baseUrl: printer.baseUrl, apiKeyConfigured: Boolean(printer.apiKey) };
}

/** Authoritative, schema-validated connection registry. API keys never leave this boundary. */
export class PrinterConnectionStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}

  private async preserveCorrupt(raw: Buffer): Promise<string | null> {
    const digest = createHash('sha256').update(raw).digest('hex').slice(0, 16);
    const backup = `${this.path}.corrupt-${digest}`;
    try {
      await copyFile(this.path, backup, fsConstants.COPYFILE_EXCL);
      return backup;
    } catch (err) {
      return errnoCode(err) === 'EEXIST' ? backup : null;
    }
  }

  private async read(): Promise<PrinterConnectionsFile> {
    let raw: Buffer;
    try {
      raw = await readFile(this.path);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return emptyFile();
      throw new PrinterStoreError('printer_io', `could not read printer connections (${errnoCode(err) ?? 'I/O error'})`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      const backup = await this.preserveCorrupt(raw);
      throw new PrinterStoreError('printer_corrupt', `printer connection storage is corrupt (invalid JSON); the original was left untouched${backup ? `; diagnostic copy: ${basename(backup)}` : ''}`, backup);
    }
    const validation = printerConnectionsFileSchema.safeParse(parsed);
    if (!validation.success) {
      const backup = await this.preserveCorrupt(raw);
      throw new PrinterStoreError('printer_corrupt', `printer connection storage is corrupt (${reason(validation.error)}); the original was left untouched${backup ? `; diagnostic copy: ${basename(backup)}` : ''}`, backup);
    }
    return validation.data;
  }

  private async write(file: PrinterConnectionsFile): Promise<void> {
    const validation = printerConnectionsFileSchema.safeParse(file);
    if (!validation.success) throw new PrinterStoreError('printer_invalid', `refusing to write invalid printer connections (${reason(validation.error)})`);
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, `${JSON.stringify(validation.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.path);
    } catch (err) {
      throw new PrinterStoreError('printer_io', `could not write printer connections (${errnoCode(err) ?? 'I/O error'}); no change was committed`);
    }
  }

  private mutate<T>(fn: (file: PrinterConnectionsFile) => T): Promise<T> {
    const next = this.queue.then(async () => {
      const file = await this.read();
      const result = fn(file);
      await this.write(file);
      return clone(result);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async list(): Promise<PrinterConnection[]> { return clone((await this.read()).printers); }
  async listPublic(): Promise<PublicPrinterConnection[]> { return (await this.list()).map(publicPrinter); }
  async get(id: string): Promise<PrinterConnection | null> {
    const parsed = printerIdSchema.safeParse(id);
    if (!parsed.success) return null;
    return clone((await this.read()).printers.find((printer) => printer.id === parsed.data) ?? null);
  }

  async create(input: { name: string; baseUrl: string; apiKey?: string }): Promise<PrinterConnection> {
    const name = printerNameSchema.parse(input.name);
    const baseUrl = moonrakerUrlSchema.parse(input.baseUrl);
    const apiKey = printerApiKeySchema.parse(input.apiKey ?? '') || null;
    return this.mutate((file) => {
      if (file.printers.length >= 20) throw new PrinterStoreError('printer_conflict', 'at most 20 printers may be configured');
      if (file.printers.some((printer) => printer.name.toLocaleLowerCase('en-GB') === name.toLocaleLowerCase('en-GB'))) {
        throw new PrinterStoreError('printer_conflict', `a printer named "${name}" already exists`);
      }
      const printer: PrinterConnection = { id: randomUUID(), name, baseUrl, apiKey };
      file.printers.push(printer);
      return printer;
    });
  }

  async update(id: string, patch: { name?: string; baseUrl?: string; apiKey?: string | null }): Promise<PrinterConnection> {
    const parsedId = printerIdSchema.parse(id);
    const name = patch.name === undefined ? undefined : printerNameSchema.parse(patch.name);
    const baseUrl = patch.baseUrl === undefined ? undefined : moonrakerUrlSchema.parse(patch.baseUrl);
    const apiKey = patch.apiKey === undefined ? undefined : (patch.apiKey === null ? null : printerApiKeySchema.parse(patch.apiKey) || null);
    return this.mutate((file) => {
      const printer = file.printers.find((candidate) => candidate.id === parsedId);
      if (!printer) throw new PrinterStoreError('printer_not_found', `unknown printer: ${parsedId}`);
      if (name !== undefined && file.printers.some((candidate) => candidate.id !== parsedId && candidate.name.toLocaleLowerCase('en-GB') === name.toLocaleLowerCase('en-GB'))) {
        throw new PrinterStoreError('printer_conflict', `a printer named "${name}" already exists`);
      }
      if (name !== undefined) printer.name = name;
      if (baseUrl !== undefined) printer.baseUrl = baseUrl;
      if (apiKey !== undefined) printer.apiKey = apiKey;
      return printer;
    });
  }

  async delete(id: string): Promise<void> {
    const parsedId = printerIdSchema.parse(id);
    await this.mutate((file) => {
      const index = file.printers.findIndex((printer) => printer.id === parsedId);
      if (index === -1) throw new PrinterStoreError('printer_not_found', `unknown printer: ${parsedId}`);
      file.printers.splice(index, 1);
    });
  }
}
