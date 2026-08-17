import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { z } from 'zod';

export const todoListNameSchema = z.string().trim().min(1).max(64);
export const todoTaskTextSchema = z.string().trim().min(1).max(200);
export const todoListIdSchema = z.string().regex(
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
  'invalid To Do list id',
);
export const todoItemIdSchema = z.string().uuid('invalid To Do item id');

export const todoItemSchema = z.strictObject({
  id: todoItemIdSchema,
  text: todoTaskTextSchema,
  completed: z.boolean(),
});

export const todoListSchema = z.strictObject({
  id: todoListIdSchema,
  name: todoListNameSchema,
  items: z.array(todoItemSchema).max(500),
});

export const todoListsFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  lists: z.array(todoListSchema).max(100),
}).superRefine((file, ctx) => {
  const listIds = new Set<string>();
  const names = new Set<string>();
  file.lists.forEach((list, listIndex) => {
    if (listIds.has(list.id)) {
      ctx.addIssue({ code: 'custom', path: ['lists', listIndex, 'id'], message: `duplicate list id: ${list.id}` });
    }
    listIds.add(list.id);
    const foldedName = list.name.toLocaleLowerCase('en-GB');
    if (names.has(foldedName)) {
      ctx.addIssue({ code: 'custom', path: ['lists', listIndex, 'name'], message: `duplicate list name: ${list.name}` });
    }
    names.add(foldedName);

    const itemIds = new Set<string>();
    list.items.forEach((item, itemIndex) => {
      if (itemIds.has(item.id)) {
        ctx.addIssue({ code: 'custom', path: ['lists', listIndex, 'items', itemIndex, 'id'], message: `duplicate item id: ${item.id}` });
      }
      itemIds.add(item.id);
    });
  });
});

export type TodoItem = z.infer<typeof todoItemSchema>;
export type TodoList = z.infer<typeof todoListSchema>;
type TodoListsFile = z.infer<typeof todoListsFileSchema>;

export type TodoStoreErrorCode = 'todo_corrupt' | 'todo_invalid' | 'todo_io' | 'todo_not_found' | 'todo_conflict';

export class TodoStoreError extends Error {
  readonly name = 'TodoStoreError';

  constructor(
    readonly code: TodoStoreErrorCode,
    message: string,
    readonly backupPath: string | null = null,
  ) {
    super(message);
  }
}

function errnoCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function validationReason(err: z.ZodError): string {
  return err.issues.map((issue) => `${issue.path.map(String).join('.') || 'file'}: ${issue.message}`).join('; ');
}

function emptyFile(): TodoListsFile {
  return { schemaVersion: 1, lists: [] };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Schema-validated, atomic local persistence for shared InkPanel To Do lists. */
export class TodoStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async preserveCorrupt(raw: Buffer): Promise<string | null> {
    const digest = createHash('sha256').update(raw).digest('hex').slice(0, 16);
    const backup = `${this.path}.corrupt-${digest}`;
    try {
      await copyFile(this.path, backup, fsConstants.COPYFILE_EXCL);
      return backup;
    } catch (err) {
      if (errnoCode(err) === 'EEXIST') return backup;
      return null;
    }
  }

  private async read(): Promise<TodoListsFile> {
    let raw: Buffer;
    try {
      raw = await readFile(this.path);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return emptyFile();
      throw new TodoStoreError('todo_io', `could not read To Do lists (${errnoCode(err) ?? 'I/O error'})`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      const backup = await this.preserveCorrupt(raw);
      throw new TodoStoreError(
        'todo_corrupt',
        `To Do list storage is corrupt (invalid JSON); the original was left untouched${backup ? `; diagnostic copy: ${basename(backup)}` : ''}`,
        backup,
      );
    }
    const validation = todoListsFileSchema.safeParse(parsed);
    if (!validation.success) {
      const backup = await this.preserveCorrupt(raw);
      throw new TodoStoreError(
        'todo_corrupt',
        `To Do list storage is corrupt (${validationReason(validation.error)}); the original was left untouched${backup ? `; diagnostic copy: ${basename(backup)}` : ''}`,
        backup,
      );
    }
    return validation.data;
  }

  private async write(file: TodoListsFile): Promise<void> {
    const validation = todoListsFileSchema.safeParse(file);
    if (!validation.success) {
      throw new TodoStoreError('todo_invalid', `refusing to write invalid To Do lists (${validationReason(validation.error)})`);
    }
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, `${JSON.stringify(validation.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.path);
    } catch (err) {
      throw new TodoStoreError('todo_io', `could not write To Do lists (${errnoCode(err) ?? 'I/O error'}); no change was committed`);
    }
  }

  private mutate<T>(fn: (file: TodoListsFile) => T): Promise<T> {
    const next = this.queue.then(async () => {
      const file = await this.read();
      const result = fn(file);
      await this.write(file);
      return clone(result);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async list(): Promise<TodoList[]> {
    return clone((await this.read()).lists);
  }

  async get(id: string): Promise<TodoList | null> {
    const parsedId = todoListIdSchema.safeParse(id);
    if (!parsedId.success) return null;
    return clone((await this.read()).lists.find((list) => list.id === parsedId.data) ?? null);
  }

  async create(name: string): Promise<TodoList> {
    const parsedName = todoListNameSchema.parse(name);
    return this.mutate((file) => {
      if (file.lists.some((list) => list.name.toLocaleLowerCase('en-GB') === parsedName.toLocaleLowerCase('en-GB'))) {
        throw new TodoStoreError('todo_conflict', `a To Do list named "${parsedName}" already exists`);
      }
      let id = randomUUID();
      while (file.lists.some((list) => list.id === id)) id = randomUUID();
      const created: TodoList = { id, name: parsedName, items: [] };
      file.lists.push(created);
      return created;
    });
  }

  async rename(id: string, name: string): Promise<TodoList> {
    const parsedId = todoListIdSchema.parse(id);
    const parsedName = todoListNameSchema.parse(name);
    return this.mutate((file) => {
      const list = file.lists.find((candidate) => candidate.id === parsedId);
      if (!list) throw new TodoStoreError('todo_not_found', `unknown To Do list: ${parsedId}`);
      if (file.lists.some((candidate) => candidate.id !== parsedId && candidate.name.toLocaleLowerCase('en-GB') === parsedName.toLocaleLowerCase('en-GB'))) {
        throw new TodoStoreError('todo_conflict', `a To Do list named "${parsedName}" already exists`);
      }
      list.name = parsedName;
      return list;
    });
  }

  async delete(id: string): Promise<void> {
    const parsedId = todoListIdSchema.parse(id);
    await this.mutate((file) => {
      const index = file.lists.findIndex((list) => list.id === parsedId);
      if (index === -1) throw new TodoStoreError('todo_not_found', `unknown To Do list: ${parsedId}`);
      file.lists.splice(index, 1);
    });
  }

  async addItem(listId: string, text: string): Promise<TodoItem> {
    const parsedListId = todoListIdSchema.parse(listId);
    const parsedText = todoTaskTextSchema.parse(text);
    return this.mutate((file) => {
      const list = file.lists.find((candidate) => candidate.id === parsedListId);
      if (!list) throw new TodoStoreError('todo_not_found', `unknown To Do list: ${parsedListId}`);
      const item: TodoItem = { id: randomUUID(), text: parsedText, completed: false };
      list.items.push(item);
      return item;
    });
  }

  async updateItem(listId: string, itemId: string, patch: { text?: string; completed?: boolean }): Promise<TodoItem> {
    const parsedListId = todoListIdSchema.parse(listId);
    const parsedItemId = todoItemIdSchema.parse(itemId);
    const parsedPatch = z.strictObject({
      text: todoTaskTextSchema.optional(),
      completed: z.boolean().optional(),
    }).refine((value) => value.text !== undefined || value.completed !== undefined, 'no item changes supplied').parse(patch);
    return this.mutate((file) => {
      const list = file.lists.find((candidate) => candidate.id === parsedListId);
      if (!list) throw new TodoStoreError('todo_not_found', `unknown To Do list: ${parsedListId}`);
      const item = list.items.find((candidate) => candidate.id === parsedItemId);
      if (!item) throw new TodoStoreError('todo_not_found', `unknown To Do item: ${parsedItemId}`);
      if (parsedPatch.text !== undefined) item.text = parsedPatch.text;
      if (parsedPatch.completed !== undefined) item.completed = parsedPatch.completed;
      return item;
    });
  }

  async deleteItem(listId: string, itemId: string): Promise<void> {
    const parsedListId = todoListIdSchema.parse(listId);
    const parsedItemId = todoItemIdSchema.parse(itemId);
    await this.mutate((file) => {
      const list = file.lists.find((candidate) => candidate.id === parsedListId);
      if (!list) throw new TodoStoreError('todo_not_found', `unknown To Do list: ${parsedListId}`);
      const index = list.items.findIndex((item) => item.id === parsedItemId);
      if (index === -1) throw new TodoStoreError('todo_not_found', `unknown To Do item: ${parsedItemId}`);
      list.items.splice(index, 1);
    });
  }

  async reorderItems(listId: string, itemIds: string[]): Promise<TodoList> {
    const parsedListId = todoListIdSchema.parse(listId);
    const parsedIds = z.array(todoItemIdSchema).max(500).parse(itemIds);
    return this.mutate((file) => {
      const list = file.lists.find((candidate) => candidate.id === parsedListId);
      if (!list) throw new TodoStoreError('todo_not_found', `unknown To Do list: ${parsedListId}`);
      if (new Set(parsedIds).size !== parsedIds.length
        || parsedIds.length !== list.items.length
        || parsedIds.some((id) => !list.items.some((item) => item.id === id))) {
        throw new TodoStoreError('todo_conflict', 'item order must contain every current item exactly once');
      }
      const byId = new Map(list.items.map((item) => [item.id, item]));
      list.items = parsedIds.map((id) => byId.get(id)!);
      return list;
    });
  }
}
