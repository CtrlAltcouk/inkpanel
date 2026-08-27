import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('repository and immediate App metadata parse and describe the HA-1 boundary', async () => {
  const repository = parse(await readFile(join(root, 'repository.yaml'), 'utf8'));
  const config = parse(await readFile(join(root, 'home-assistant', 'config.yaml'), 'utf8'));
  assert.equal(repository.url, 'https://github.com/CtrlAltcouk/inkpanel');
  assert.equal(config.version, '0.1.0-ha.8');
  assert.equal(config.image, 'ghcr.io/ctrlaltcouk/inkpanel-home-assistant');
  assert.deepEqual(config.arch, ['amd64', 'aarch64']);
  assert.equal(config.ingress, true);
  assert.equal(config.ingress_port, 8099);
  assert.equal(config.ports['8080/tcp'], 8080);
  assert.equal(config.ports['8443/tcp'], 8443);
  assert.equal(config.ports['8099/tcp'], undefined, 'Ingress must never be host-mapped');
  assert.equal(config.homeassistant_api, true);
  assert.equal(config.backup, 'cold');
  assert.equal(config.schema.panel_base_url, 'url');
  assert.equal(config.schema.lan_password, 'password');
});

test('the dedicated image preserves the Playwright version and /data startup adapter', async () => {
  const dockerfile = await readFile(join(root, 'Dockerfile.home-assistant'), 'utf8');
  const dockerignore = await readFile(join(root, '.dockerignore'), 'utf8');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.match(dockerfile, new RegExp(`playwright:v${pkg.dependencies.playwright.replace(/^[\\^~]/, '')}-noble`));
  assert.match(dockerfile, /CMD \["node", "scripts\/home-assistant-start\.mjs"\]/);
  assert.match(dockerfile, /VOLUME \["\/data"\]/);
  assert.match(dockerfile, /io\.hass\.type="app"/);
  assert.doesNotMatch(dockerfile, /io\.hass\.type="addon"/);
  assert.doesNotMatch(dockerfile, /arduino-cli/, 'firmware is compiled before the runtime image build');
  assert.doesNotMatch(dockerignore, /^firmware(?:\/dist)?\/?$/m,
    'the verified production firmware must remain in the Docker build context');
});

test('the image workflow builds, verifies and embeds production firmware before publishing', async () => {
  const workflow = await readFile(join(root, '.github', 'workflows', 'home-assistant-image.yml'), 'utf8');
  const parsed = parse(workflow);
  assert.ok(parsed.on.push.branches.includes('Home-Assistant'));
  assert.ok(parsed.jobs.init && parsed.jobs.firmware && parsed.jobs.build && parsed.jobs.publish && parsed.jobs['inspect-published']);
  assert.match(workflow, /prepare-multi-arch-matrix@4de35182/);
  assert.match(workflow, /build-image@4de35182/);
  assert.match(workflow, /publish-multi-arch-manifest@4de35182/);
  assert.match(workflow, /\["amd64", "aarch64"\]/);
  assert.match(workflow, /VERSION: 0\.1\.0-ha\.8/);
  assert.match(workflow, /matrix: \$\{\{ steps\.prepare\.outputs\.matrix \}\}/);
  assert.match(workflow, /runs-on: \$\{\{ matrix\.os \}\}/);
  assert.match(workflow, /registry-prefix: ghcr\.io\/ctrlaltcouk/);
  assert.deepEqual(parsed.jobs.build.needs, ['init', 'firmware']);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /\.\/scripts\/build-firmware\.sh/);
  assert.match(workflow, /bash scripts\/verify-firmware-package\.sh/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /actions\/download-artifact@v4/);
  assert.match(workflow, /name: inkpanel-production-firmware-\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /path: firmware\/dist\/?/);
  assert.match(workflow, /load: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.match(workflow, /expected_hash="\$\(bash scripts\/firmware-input-hash\.sh\)"/);
  assert.match(workflow, /\/app\/scripts\/verify-firmware-package\.sh \/app\/firmware\/dist "\$expected_hash"/);
  assert.match(workflow, /docker pull "\$IMAGE_REF"/);
  assert.doesNotMatch(workflow, /fixtures?/i, 'release images must use real compiled firmware');
  assert.doesNotMatch(workflow, /github-token:/);
});

test('the shared firmware verifier enforces complete, current full-size and Mini packages', async () => {
  const verifier = await readFile(join(root, 'scripts', 'verify-firmware-package.sh'), 'utf8');
  const ci = await readFile(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(verifier, /manifest\.json/);
  assert.match(verifier, /mini\/manifest\.json/);
  assert.match(verifier, /find .*'\*\.bin'.*-size \+0c/);
  assert.match(verifier, /= "full"/);
  assert.match(verifier, /= "mini"/);
  assert.match(verifier, /input\.sha256/);
  assert.match(verifier, /firmware-input-hash\.sh/);
  assert.match(verifier, /EXPECTED_INPUT_HASH="\$\{2:-\}"/,
    'an independently calculated hash can validate an image that intentionally has no .git directory');
  assert.match(ci, /bash scripts\/verify-firmware-package\.sh/,
    'normal firmware CI and the Home Assistant release use the same package invariant');
});
