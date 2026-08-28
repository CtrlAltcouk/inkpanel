import express from 'express';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const staticOptions = {
  index: false as const, etag: false, lastModified: false,
  setHeaders: (res: { setHeader(name: string, value: string): unknown }) => { res.setHeader('Cache-Control', 'no-store'); },
};

/** Build metadata only: never accept a request/query value as a filesystem path. */
export function studioAssetBase(release?: string): string {
  if (release === undefined) return './'; // Standalone and unpackaged HA embedders.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(release)) throw new Error('Invalid Studio asset release');
  return `./assets/${release}/`;
}

function mountFiles(router: express.Router) {
  for (const pkg of ['@fontsource/dela-gothic-one', '@fontsource/inter']) {
    const fonts = join(dirname(require.resolve(`${pkg}/package.json`)), 'files');
    router.use('/vendor/fonts', express.static(fonts, { immutable: true, maxAge: '30d' }));
  }
  router.use(express.static(publicDir, staticOptions));
}

export function mountStudioAssets(app: express.Express, release?: string): void {
  const assetBase = studioAssetBase(release);
  // Only known document entrypoints; no <base> element or change to API roots.
  for (const name of ['index', 'login', 'terms', 'privacy']) {
    const original = readFileSync(join(publicDir, `${name}.html`), 'utf8');
    const html = original.replace(/((?:src|href)=")\.\/([^"<>]+\.(?:js|css|svg))"/g,
      (_match, attribute: string, asset: string) => `${attribute}${assetBase}${asset}"`);
    app.get(name === 'index' ? ['/', '/index.html'] : `/${name}.html`, (_req, res) => {
      res.set('Cache-Control', 'no-store');
      // res.send would generate an ETag for HTML; keep the existing no-validator policy.
      res.type('html').end(html);
    });
  }
  if (release !== undefined) {
    const assets = express.Router();
    // Documents must stay outside the asset namespace so appPath keeps its root.
    assets.use((req, res, next) => {
      let path: string;
      try { path = decodeURIComponent(req.path).toLowerCase(); }
      catch { res.sendStatus(400); return; }
      if (path.endsWith('.html') || path.endsWith('/')) { res.sendStatus(404); return; }
      next();
    });
    mountFiles(assets);
    app.use(`/assets/${release}`, assets);
    // Never alias old release URLs to current files.
    app.use('/assets', (_req, res) => { res.sendStatus(404); });
  }
  mountFiles(app); // Legacy root paths and standalone remain available.
}
