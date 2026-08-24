import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function normalizePanelBaseUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  let url;
  try { url = new URL(raw); } catch { throw new Error('panel_base_url must be a valid HTTP or HTTPS URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('panel_base_url must use HTTP or HTTPS');
  }
  if (url.username || url.password) throw new Error('panel_base_url must not contain credentials');
  if (!url.hostname || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('panel_base_url must be a LAN origin without a path, query, or fragment');
  }
  return url.toString().replace(/\/$/, '');
}

export function runtimeEnvironment(options, inherited = process.env) {
  const lanPassword = typeof options?.lan_password === 'string' ? options.lan_password.trim() : '';
  if (!lanPassword) throw new Error('lan_password is required');
  return {
    ...inherited,
    DATA_DIR: '/data',
    PORT: '8080',
    PUBLIC_BASE_URL: normalizePanelBaseUrl(options?.panel_base_url),
    INKPANEL_PASSWORD: lanPassword,
    HTTPS_PORT: '8443',
    HOME_ASSISTANT_MODE: '1',
    HOME_ASSISTANT_INGRESS_PORT: '8099',
    HOME_ASSISTANT_BASE_URL: 'http://supervisor/core/api',
  };
}

export async function main() {
  const options = JSON.parse(await readFile('/data/options.json', 'utf8'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: '/app',
    env: runtimeEnvironment(options),
    stdio: 'inherit',
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('exit', (code, signal) => process.exitCode = signal ? 1 : (code ?? 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
