import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Read a managed secret file. Missing is a normal unconfigured state. */
export async function readOptionalSecretFile(path: string): Promise<string | null> {
  try {
    const value = await readFile(path, 'utf8');
    if (process.platform !== 'win32') await chmod(path, 0o600);
    return value;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Publish a secret atomically in the same directory and keep it owner-only.
 * The temporary file is removed on any failed write/rename path.
 */
export async function writeSecretFile(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temp, value, { mode: 0o600 });
    if (process.platform !== 'win32') await chmod(temp, 0o600);
    await rename(temp, path);
    if (process.platform !== 'win32') await chmod(path, 0o600);
  } catch (err) {
    await unlink(temp).catch(() => undefined);
    throw err;
  }
}
