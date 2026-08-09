import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, readFile, writeFile, cp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UPDATER = join(root, 'scripts', 'proxmox', 'files', 'inkpanel-update');
const BASH = process.env.TEST_BASH ?? 'bash';
const bashPath = (path: string) => path
  .replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
  .replace(/\\/g, '/');
const WRITE_STATUS = join(root, 'scripts', 'proxmox', 'files', 'write-status.mjs');

/**
 * The updater is designed to run as root, invoking `runuser -u inkpanel` and
 * `systemctl` — neither of which this test can or should actually exercise.
 * These stubs let the REAL updater script run unmodified: `runuser -u USER --
 * CMD...` becomes a plain exec of CMD, and `systemctl` becomes a no-op that
 * records it was called. Everything else in the script — git, the firmware
 * diff, the non-fatal wrapping — runs for real.
 */
async function makeStubBin(dir: string): Promise<string> {
  const bin = join(dir, 'stubbin');
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, 'runuser'),
    '#!/usr/bin/env bash\nshift 2\nexec "$@"\n',
  );
  await writeFile(
    join(bin, 'systemctl'),
    '#!/usr/bin/env bash\necho "systemctl $*" >> "$SYSTEMCTL_LOG"\nexit 0\n',
  );
  await writeFile(join(bin, 'curl'), '#!/usr/bin/env bash\nprintf 200\n');
  await writeFile(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  await writeFile(join(bin, 'chown'), '#!/usr/bin/env bash\nexit 0\n');
  await chmod(join(bin, 'runuser'), 0o755);
  await chmod(join(bin, 'systemctl'), 0o755);
  await chmod(join(bin, 'curl'), 0o755);
  await chmod(join(bin, 'sleep'), 0o755);
  await chmod(join(bin, 'chown'), 0o755);
  return bin;
}

interface Fixture {
  dir: string;
  upstream: string;
  appDir: string;
  buildMarker: string;
  systemctlLog: string;
  updaterScript: string;
}

/**
 * A real git remote and a real clone, exactly like a genuine deployment —
 * not a fake filesystem standing in for one. `firmware/` and
 * `scripts/build-firmware.sh` exist from the first commit so the "before"
 * commit the updater captures is always well-formed.
 */
async function setupFixture(dir: string): Promise<Fixture> {
  const upstream = join(dir, 'upstream');
  const appDir = join(dir, 'app-root');
  const buildMarker = join(dir, 'build-ran.txt');
  const systemctlLog = join(dir, 'systemctl-calls.txt');

  await mkdir(upstream, { recursive: true });
  await run('git', ['init', '-q', '-b', 'main'], { cwd: upstream });
  await run('git', ['config', 'user.email', 't@t.example'], { cwd: upstream });
  await run('git', ['config', 'user.name', 'test'], { cwd: upstream });

  await mkdir(join(upstream, 'firmware'), { recursive: true });
  await writeFile(join(upstream, 'firmware', 'marker.txt'), 'old\n');
  await mkdir(join(upstream, 'scripts'), { recursive: true });
  // Not the real build-firmware.sh — a stand-in that proves whether it was
  // invoked. Exit code is set per-test via BUILD_EXIT_CODE.
  await writeFile(
    join(upstream, 'scripts', 'build-firmware.sh'),
    `#!/usr/bin/env bash\necho ran >> "${buildMarker.replace(/\\/g, '/')}"\nexit "\${BUILD_EXIT_CODE:-0}"\n`,
  );
  await chmod(join(upstream, 'scripts', 'build-firmware.sh'), 0o755);
  await run('git', ['add', '-A'], { cwd: upstream });
  await run('git', ['commit', '-q', '-m', 'initial'], { cwd: upstream });

  await mkdir(join(dir, 'app-parent'), { recursive: true });
  await run('git', ['clone', '-q', upstream, join(appDir, 'app')]);
  await run('git', ['config', 'user.email', 't@t.example'], { cwd: join(appDir, 'app') });
  await run('git', ['config', 'user.name', 'test'], { cwd: join(appDir, 'app') });
  await mkdir(join(appDir, 'data'), { recursive: true });

  const updaterScript = join(dir, 'inkpanel-update');
  let script = await readFile(UPDATER, 'utf8');
  script = script.replace('APP_DIR=/opt/inkpanel', `APP_DIR=${bashPath(appDir)}`);
  script = script.replace(
    'TRANSACTION_ROOT=/var/lib/inkpanel-update',
    `TRANSACTION_ROOT=${bashPath(join(dir, 'transaction-state'))}`,
  );
  script = script.replace('HEALTH_MAX_ATTEMPTS=45', 'HEALTH_MAX_ATTEMPTS=4');
  await writeFile(updaterScript, script);
  await chmod(updaterScript, 0o755);
  // write-status.mjs is resolved by the updater relative to its own
  // location, so it needs to sit alongside the copy above, not the original.
  await cp(WRITE_STATUS, join(dir, 'write-status.mjs'));

  return { dir, upstream, appDir, buildMarker, systemctlLog, updaterScript };
}

async function runUpdater(
  fixture: Fixture,
  env: Record<string, string> = {},
): Promise<{ code: number; status: { state: string; log: string[] } }> {
  const stubbin = await makeStubBin(fixture.dir);
  let code = 0;
  try {
    await run(BASH, [fixture.updaterScript], {
      env: {
        ...process.env,
        PATH: process.platform === 'win32'
          ? `${bashPath(stubbin)}:/usr/bin:/bin`
          : `${stubbin}:${process.env.PATH}`,
        SYSTEMCTL_LOG: process.platform === 'win32'
          ? bashPath(fixture.systemctlLog)
          : fixture.systemctlLog,
        ...env,
      },
    });
  } catch (err) {
    code = (err as { code?: number }).code ?? 1;
  }
  const status = JSON.parse(
    await readFile(join(fixture.appDir, 'data', 'update-status.json'), 'utf8'),
  ) as { state: string; log: string[] };
  return { code, status };
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-firmware-rebuild-'));
  try {
    await fn(await setupFixture(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('bash -n accepts both proxmox scripts', async () => {
  await run('bash', ['-n', UPDATER]);
  await run('bash', ['-n', join(root, 'scripts', 'proxmox', 'inkpanel-lxc.sh')]);
});

test('a pull that touches firmware/ triggers a rebuild, and the update still succeeds', async () => {
  await withFixture(async (fixture) => {
    await writeFile(join(fixture.upstream, 'firmware', 'marker.txt'), 'new\n');
    await run('git', ['add', '-A'], { cwd: fixture.upstream });
    await run('git', ['commit', '-q', '-m', 'firmware change'], { cwd: fixture.upstream });

    const { code, status } = await runUpdater(fixture);

    assert.equal(code, 0);
    assert.equal(status.state, 'success');
    assert.ok(
      status.log.some((l) => /firmware rebuild \(firmware inputs changed\)/.test(l)),
      'the log should record that the rebuild ran',
    );
    assert.ok(status.log.some((l) => /firmware rebuild: ok/.test(l)));
    await assert.doesNotReject(readFile(fixture.buildMarker, 'utf8'), 'build-firmware.sh must actually have run');
    assert.ok(
      status.log.some((l) => l.includes('deploy candidate')),
      'the service must still deploy after a successful rebuild',
    );
  });
});

// The built firmware is a function of three inputs, not one: the sketch, the
// build script (which pins the FQBN — the target board), and the manifest
// generator (which pins the flash offsets). Watching only firmware/ produced
// a genuinely confusing real failure: a fix correcting the FQBN to the right
// board variant landed in scripts/build-firmware.sh, the updater logged
// "firmware rebuild skipped", and the stale binaries built for the WRONG
// board stayed in place. The Flash tab kept serving them, every flash
// reported success, and the board kept refusing to boot — with the fix
// sitting in the checkout, never once compiled. Nothing anywhere said so.
for (const changedFile of ['scripts/build-firmware.sh', 'scripts/firmware-manifest.mjs']) {
  test(`a pull that changes ${changedFile} triggers a rebuild too`, async () => {
    await withFixture(async (fixture) => {
      const target = join(fixture.upstream, ...changedFile.split('/'));
      await mkdir(dirname(target), { recursive: true });
      // Append rather than overwrite: build-firmware.sh is the stub the
      // fixture relies on to record that a build ran, and replacing it
      // wholesale would make this test pass for the wrong reason.
      const existing = await readFile(target, 'utf8').catch(() => '#!/usr/bin/env bash\n');
      await writeFile(target, `${existing}\n# touched by the test\n`);
      await run('git', ['add', '-A'], { cwd: fixture.upstream });
      await run('git', ['commit', '-q', '-m', `change ${changedFile}`], { cwd: fixture.upstream });

      const { code, status } = await runUpdater(fixture);

      assert.equal(code, 0);
      assert.equal(status.state, 'success');
      assert.ok(
        status.log.some((l) => /firmware rebuild \(firmware inputs changed\)/.test(l)),
        `changing ${changedFile} must trigger a rebuild — it changes what gets built`,
      );
      await assert.doesNotReject(
        readFile(fixture.buildMarker, 'utf8'),
        'build-firmware.sh must actually have run',
      );
    });
  });
}

// This is the property the design explicitly calls the most important one in
// the whole feature: whether an ESP32 compile succeeds has nothing to do
// with whether the server can keep serving frames to panels it is already
// running for. A regression here — the build step migrating back onto the
// `|| fail` pattern used by git pull and npm ci — would mean a firmware-side
// compile error takes down every panel in the house on the next update.
test('a failing firmware rebuild does NOT fail the update', async () => {
  await withFixture(async (fixture) => {
    await writeFile(join(fixture.upstream, 'firmware', 'marker.txt'), 'new\n');
    await run('git', ['add', '-A'], { cwd: fixture.upstream });
    await run('git', ['commit', '-q', '-m', 'firmware change, build will fail'], { cwd: fixture.upstream });

    const { code, status } = await runUpdater(fixture, { BUILD_EXIT_CODE: '1' });

    assert.equal(code, 0, 'the updater process itself must exit 0');
    assert.equal(status.state, 'success', 'the update must still be recorded as successful');
    assert.ok(
      status.log.some((l) => /firmware rebuild: FAILED/.test(l)),
      'the failure must be visible in the log, not swallowed silently',
    );
    assert.ok(
      status.log.some((l) => l.includes('deploy candidate')),
      'the service must still deploy even though the rebuild failed',
    );
  });
});

test('a pull that does not touch firmware/ skips the rebuild entirely', async () => {
  await withFixture(async (fixture) => {
    await writeFile(join(fixture.upstream, 'README.md'), 'unrelated change\n');
    await run('git', ['add', '-A'], { cwd: fixture.upstream });
    await run('git', ['commit', '-q', '-m', 'unrelated change'], { cwd: fixture.upstream });

    const { code, status } = await runUpdater(fixture);

    assert.equal(code, 0);
    assert.equal(status.state, 'success');
    assert.ok(status.log.some((l) => /firmware rebuild skipped/.test(l)));
    await assert.rejects(
      readFile(fixture.buildMarker, 'utf8'),
      'build-firmware.sh must not have run when firmware/ was untouched',
    );
  });
});

test('the rebuild step in the updater is not wired to the fatal path', async () => {
  const script = await readFile(UPDATER, 'utf8');
  const start = script.indexOf('firmware rebuild (firmware inputs changed)');
  const end = script.indexOf('log "== deploy candidate =="');
  assert.ok(start > -1 && end > start, 'could not locate the firmware rebuild block');
  const block = script.slice(script.lastIndexOf('\n', start), end);

  assert.doesNotMatch(
    block,
    /build-firmware\.sh[^\n]*\|\|\s*fail/,
    'the build invocation must not use the `|| fail` pattern git pull and npm ci use — that pattern aborts the update',
  );
  assert.match(block, /if\s+runuser[\s\S]*then[\s\S]*else[\s\S]*fi/, 'the build must be wrapped in an if/else, which is what keeps a nonzero exit from tripping set -e');
});

test('the installer runs the ESP32 core install and the initial build as the app user, not root', async () => {
  const script = await readFile(join(root, 'scripts', 'proxmox', 'inkpanel-lxc.sh'), 'utf8');
  assert.match(script, /runuser -u \$\{APP\} -- arduino-cli core install esp32:esp32/);
  assert.match(script, /runuser -u \$\{APP\} -- \.\/scripts\/build-firmware\.sh/);
});

test('the installer checks free disk space before installing the ESP32 core', async () => {
  const script = await readFile(join(root, 'scripts', 'proxmox', 'inkpanel-lxc.sh'), 'utf8');
  const spaceCheck = script.indexOf('MIN_FREE_MB');
  const coreInstall = script.indexOf('arduino-cli core install esp32:esp32');
  assert.ok(spaceCheck > -1, 'no disk space check found');
  assert.ok(coreInstall > -1, 'no core install found');
  assert.ok(spaceCheck < coreInstall, 'the space check must run before the core install, not after');
});

// A real install hit this directly: the arduino-cli fetch had its output
// swallowed by `>/dev/null 2>&1`, so when it silently failed to install
// anything, the failure only surfaced two steps later as a bare
// "arduino-cli: command not found" with no indication of what actually went
// wrong or why. Two properties close that gap, and both are checked here
// rather than just one, because either alone leaves a blind spot: the first
// makes a script-level failure (a real `fail()` inside install.sh) visible at
// the point it happens; the second catches the quieter case where install.sh
// exits 0 having installed nothing, because curl returned an empty or
// truncated body that "sh" then executed as a no-op.
test('the arduino-cli install step is diagnosable when it fails, not silent', async () => {
  const script = await readFile(join(root, 'scripts', 'proxmox', 'inkpanel-lxc.sh'), 'utf8');
  const installIdx = script.indexOf('install.sh | BINDIR=/usr/local/bin sh');
  assert.ok(installIdx > -1, 'could not find the arduino-cli install invocation');

  const installLineStart = script.lastIndexOf('\n', installIdx);
  const installLineEnd = script.indexOf('\n', installIdx);
  const installLine = script.slice(installLineStart, installLineEnd);
  assert.doesNotMatch(
    installLine,
    />\s*\/dev\/null/,
    'the install script\'s own output must not be suppressed — it is the one step that talks to an external host other than the already-proven-reachable Debian/Node mirrors, and a real failure here needs to be visible at the point it happens',
  );

  const versionCheckIdx = script.indexOf("arduino-cli $(run 'arduino-cli version'");
  assert.ok(versionCheckIdx > installIdx, 'could not find the arduino-cli version step after the install');
  const between = script.slice(installIdx, versionCheckIdx);
  assert.match(
    between,
    /command -v arduino-cli[\s\S]*\|\|\s*die/,
    'an explicit command -v check with a die() must sit between the install and the version step, to catch install.sh exiting 0 with nothing actually installed',
  );
});

// The second real reinstall attempt hit this: arduino-cli genuinely
// installed into /usr/local/bin ("installed successfully" from its own
// output), but every lookup for it afterward -- its own internal
// `command -v` check AND the installer's -- reported "not found", because
// `pct exec ... bash -c` does not carry /usr/local/bin on PATH the way an
// interactive login shell would. Node/npm/git/curl all install into
// /usr/bin via apt, which stayed reachable regardless, so this went
// unnoticed until the first thing that installs into /usr/local/bin.
//
// This can't be exercised behaviorally without a real Proxmox host — pct
// exec's actual PATH behavior is what's in question, and nothing here can
// simulate it. This is a structural guard only: it fails if run()'s
// explicit PATH is ever "simplified" away back to whatever pct exec
// happens to default to.
test('the installer sets an explicit PATH for every command it runs inside the container', async () => {
  const script = await readFile(join(root, 'scripts', 'proxmox', 'inkpanel-lxc.sh'), 'utf8');
  const runDef = script.split('\n').find((l) => l.trimStart().startsWith('run()'));
  assert.ok(runDef, 'could not find the run() helper definition');
  assert.match(runDef!, /PATH="\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin"/);
});

test('the installer default disk size accounts for the firmware toolchain', async () => {
  const script = await readFile(join(root, 'scripts', 'proxmox', 'inkpanel-lxc.sh'), 'utf8');
  assert.match(script, /DISK="\$\{DISK:-12\}"/);
});

test('a failed initial firmware build at install time does not abort the installer', async () => {
  const script = await readFile(join(root, 'scripts', 'proxmox', 'inkpanel-lxc.sh'), 'utf8');
  const buildLine = script
    .split('\n')
    .find((l) => l.includes('./scripts/build-firmware.sh') && l.includes('runuser'));
  assert.ok(buildLine, 'could not find the initial build invocation');
  // The continuation line carries the non-fatal `|| warn`; die() would abort
  // the whole install via the script's ERR trap.
  const idx = script.indexOf(buildLine!);
  const after = script.slice(idx, idx + 300);
  assert.match(after, /\|\|\s*warn/, 'the initial build must degrade with warn(), not die()');
  assert.doesNotMatch(after, /\|\|\s*die/);
});
