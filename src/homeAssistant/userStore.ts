import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { homeAssistantUserSchema, homeAssistantUserIdSchema, type HomeAssistantIngressUser } from './ingressUser.ts';
import { todoEntityIdSchema } from './todoSchemas.ts';

export const todoAssignmentsSchema = z.array(todoEntityIdSchema).max(100)
  .refine((ids) => new Set(ids).size === ids.length, 'duplicate assignments');
const userSchema = z.strictObject({
  userId: homeAssistantUserIdSchema,
  username: homeAssistantUserSchema.shape.username,
  displayName: homeAssistantUserSchema.shape.displayName,
  todoEntityIds: todoAssignmentsSchema,
});
export const homeAssistantUsersV1Schema = z.strictObject({ version: z.literal(1), users: z.array(userSchema).max(500) })
  .refine(({ users }) => new Set(users.map((user) => user.userId)).size === users.length, 'duplicate user IDs')
  .refine(({ users }) => {
    const ids = users.flatMap((user) => user.todoEntityIds);
    return new Set(ids).size === ids.length;
  }, 'a personal list can have only one owner');
type UsersFile = z.infer<typeof homeAssistantUsersV1Schema>;
export class HomeAssistantUserStoreError extends Error {
  constructor(readonly code: 'users_corrupt' | 'users_io' | 'users_invalid' | 'users_not_found', message: string) { super(message); }
}
const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

/** Deployment-local mappings only: no task contents, credentials or user-name authorization. */
export class HomeAssistantUserStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  private async read(): Promise<UsersFile> {
    let raw: Buffer;
    try { raw = await readFile(this.path); }
    catch (error) {
      if (errno(error) === 'ENOENT') return { version: 1, users: [] };
      throw new HomeAssistantUserStoreError('users_io', 'Home Assistant ownership storage is unavailable');
    }
    try { return homeAssistantUsersV1Schema.parse(JSON.parse(raw.toString('utf8'))); }
    catch {
      const backup = `${this.path}.corrupt-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
      await writeFile(backup, raw, { mode: 0o600, flag: 'wx' }).catch(() => undefined);
      throw new HomeAssistantUserStoreError('users_corrupt', 'Home Assistant ownership storage is invalid; original left untouched');
    }
  }
  private mutate(fn: (file: UsersFile) => void): Promise<void> {
    const result = this.queue.then(async () => {
      const file = await this.read();
      const before = JSON.stringify(file);
      fn(file);
      const parsed = homeAssistantUsersV1Schema.safeParse(file);
      if (!parsed.success) throw new HomeAssistantUserStoreError('users_invalid', 'Invalid or duplicate Home Assistant ownership assignment');
      if (before === JSON.stringify(parsed.data)) return;
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(temporary, `${JSON.stringify(parsed.data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.path);
      } catch {
        await unlink(temporary).catch(() => undefined);
        throw new HomeAssistantUserStoreError('users_io', 'Could not commit Home Assistant ownership changes');
      }
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  async list() { return structuredClone((await this.read()).users); }
  async assigned(userId: string, entityId: string): Promise<boolean> {
    homeAssistantUserIdSchema.parse(userId);
    todoEntityIdSchema.parse(entityId);
    return (await this.read()).users.some((user) => user.userId === userId && user.todoEntityIds.includes(entityId));
  }
  async observe(identity: HomeAssistantIngressUser): Promise<void> {
    const user = homeAssistantUserSchema.parse(identity);
    await this.mutate((file) => {
      const existing = file.users.find((entry) => entry.userId === user.id);
      if (existing) { existing.username = user.username; existing.displayName = user.displayName; }
      else file.users.push({ userId: user.id, username: user.username, displayName: user.displayName, todoEntityIds: [] });
    });
  }
  async assign(userId: string, todoEntityIds: string[]): Promise<void> {
    homeAssistantUserIdSchema.parse(userId);
    const ids = todoAssignmentsSchema.parse(todoEntityIds);
    await this.mutate((file) => {
      const user = file.users.find((entry) => entry.userId === userId);
      if (!user) throw new HomeAssistantUserStoreError('users_not_found', 'Unknown observed Home Assistant user');
      user.todoEntityIds = ids;
    });
  }
  async remove(userId: string): Promise<void> {
    homeAssistantUserIdSchema.parse(userId);
    await this.mutate((file) => { file.users = file.users.filter((user) => user.userId !== userId); });
  }
}
