import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UPDATER = join(root, 'scripts', 'proxmox', 'files', 'inkpanel-update');
const WRITE_STATUS = join(root, 'scripts', 'proxmox', 'files', 'write-status.mjs');
const BASH = process.env.TEST_BASH ?? 'bash';

const posix = (path: string) => path.replace(/\\/g, '/');
const bashPath = (path: string) => path
  .replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
  .replace(/\\/g, '/');

interface UpdateStatus {
  state: string;
  error: string | null;
  log: string[];
}

interface Fixture {
  dir: string;
  upstream: string;
  appDir: string;
  repoDir: string;
  dataDir: string;
  updater: string;
  stubbin: string;
  healthPlan: string;
  curlLog: string;
  systemctlLog: string;
  npmLog: string;
  statusTrace: string;
  serviceState: string;
  startCount: string;
  buildMarker: string;
  protectedDepsLog: string;
  transactionRoot: string;
}

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, body);
  await chmod(path, 0o755);
}

async function setupFixture(dir: string): Promise<Fixture> {
  const upstream = join(dir, 'upstream');
  const appDir = join(dir, 'app-root');
  const repoDir = join(appDir, 'app');
  const dataDir = join(appDir, 'data');
  const stubbin = join(dir, 'stubbin');
  const healthPlan = join(dir, 'health-plan.txt');
  const curlLog = join(dir, 'curl.log');
  const systemctlLog = join(dir, 'systemctl.log');
  const npmLog = join(dir, 'npm.log');
  const statusTrace = join(dir, 'status-trace.log');
  const serviceState = join(dir, 'service-state.txt');
  const startCount = join(dir, 'start-count.txt');
  const buildMarker = join(dir, 'build-ran.txt');
  const protectedDepsLog = join(dir, 'protected-deps-path.txt');
  const transactionRoot = join(dir, 'transaction-state');

  await mkdir(join(upstream, 'firmware'), { recursive: true });
  await mkdir(join(upstream, 'scripts'), { recursive: true });
  await writeFile(join(upstream, 'firmware', 'marker.txt'), 'old firmware input\n');
  await writeFile(join(upstream, 'README.md'), 'initial\n');
  await writeFile(join(upstream, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  await writeFile(join(upstream, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await writeExecutable(
    join(upstream, 'scripts', 'build-firmware.sh'),
    `#!/usr/bin/env bash
set -eu
echo ran >> "${bashPath(buildMarker)}"
if [[ "\${BUILD_EXIT_CODE:-0}" != "0" ]]; then exit "\${BUILD_EXIT_CODE}"; fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
rm -rf "$ROOT/firmware/dist"
mkdir -p "$ROOT/firmware/dist"
printf 'candidate firmware\n' > "$ROOT/firmware/dist/package.txt"
`,
  );
  await run('git', ['init', '-q', '-b', 'main'], { cwd: upstream });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: upstream });
  await run('git', ['config', 'user.name', 'test'], { cwd: upstream });
  await run('git', ['add', '-A'], { cwd: upstream });
  await run('git', ['commit', '-q', '-m', 'initial'], { cwd: upstream });

  await mkdir(appDir, { recursive: true });
  await run('git', ['clone', '-q', upstream, repoDir]);
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(repoDir, 'node_modules'), { recursive: true });
  await writeFile(join(repoDir, 'node_modules', 'package.txt'), 'old dependencies\n');
  await mkdir(join(repoDir, 'firmware', 'dist'), { recursive: true });
  await writeFile(join(repoDir, 'firmware', 'dist', 'package.txt'), 'old firmware\n');
  await writeFile(join(dataDir, 'config.json'), Buffer.from([0x7b, 0x22, 0x6f, 0x6c, 0x64, 0x22, 0x3a, 0x31, 0x7d, 0x0a]));

  await mkdir(stubbin, { recursive: true });
  await writeExecutable(join(stubbin, 'runuser'), '#!/usr/bin/env bash\nshift 2\nexec "$@"\n');
  await writeExecutable(
    join(stubbin, 'systemctl'),
    `#!/usr/bin/env bash
set -u
echo "systemctl $*" >> "$SYSTEMCTL_LOG"
case "\${1:-}" in
  is-active) [[ "$(cat "$SERVICE_STATE" 2>/dev/null || true)" == active ]] ;;
  stop) printf inactive > "$SERVICE_STATE" ;;
  start)
    count="$(cat "$START_COUNT_FILE" 2>/dev/null || printf 0)"
    count=$((count + 1))
    printf '%s' "$count" > "$START_COUNT_FILE"
    if [[ "$count" -eq 1 && "\${CANDIDATE_START_FAIL:-0}" == 1 ]]; then exit 1; fi
    if [[ "$count" -gt 1 && "\${ROLLBACK_START_FAIL:-0}" == 1 ]]; then exit 1; fi
    printf active > "$SERVICE_STATE"
    if [[ "$count" -eq 1 && "\${CANDIDATE_TAMPER_DEPS:-0}" == 1 ]]; then
      snapshot="$(find "$TRANSACTION_ROOT_PATH" -type d -name node_modules.before -print -quit)"
      printf '%s' "$snapshot" > "$PROTECTED_DEPS_LOG"
      parent_mode="$(stat -c '%a' "$(dirname "$snapshot")")"
      if (( (8#$parent_mode & 0077) != 0 )); then
        printf compromised > "$snapshot/candidate-tampered.txt"
      fi
    fi
    if [[ "$count" -eq 1 && -n "\${CANDIDATE_CONFIG_CONTENT:-}" ]]; then
      printf '%s' "$CANDIDATE_CONFIG_CONTENT" > "$CONFIG_PATH"
    fi
    ;;
esac
`,
  );
  await writeExecutable(
    join(stubbin, 'curl'),
    `#!/usr/bin/env bash
echo "curl $*" >> "$CURL_LOG"
response="$(head -n 1 "$HEALTH_PLAN" 2>/dev/null || true)"
if [[ -n "$response" ]]; then
  tail -n +2 "$HEALTH_PLAN" > "$HEALTH_PLAN.next"
  mv "$HEALTH_PLAN.next" "$HEALTH_PLAN"
else
  response=200
fi
if [[ "$response" == error ]]; then exit 7; fi
printf '%s' "$response"
`,
  );
  await writeExecutable(join(stubbin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  await writeExecutable(join(stubbin, 'chown'), '#!/usr/bin/env bash\nexit 0\n');
  await writeExecutable(
    join(stubbin, 'install'),
    '#!/usr/bin/env bash\nargs=("$@")\ncount=${#args[@]}\ncp "${args[$((count - 2))]}" "${args[$((count - 1))]}"\n',
  );
  await writeExecutable(
    join(stubbin, 'npm'),
    `#!/usr/bin/env bash
echo "npm $*" >> "$NPM_LOG"
if [[ "\${NPM_FAIL:-0}" == 1 ]]; then exit 1; fi
prefix=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --prefix ]]; then prefix="$2"; shift 2; else shift; fi
done
mkdir -p "$prefix/node_modules"
printf 'candidate dependencies\n' > "$prefix/node_modules/package.txt"
`,
  );
  await writeExecutable(
    join(stubbin, 'node'),
    '#!/usr/bin/env bash\necho "$2" >> "$STATUS_TRACE"\nexec "$REAL_NODE" "$@"\n',
  );

  await writeFile(serviceState, 'active');
  await writeFile(startCount, '0');
  await writeFile(healthPlan, '200\n200\n200\n200\n');

  const updater = join(dir, 'inkpanel-update');
  let script = await readFile(UPDATER, 'utf8');
  script = script.replace('APP_DIR=/opt/inkpanel', `APP_DIR=${bashPath(appDir)}`);
  script = script.replace(
    'TRANSACTION_ROOT=/var/lib/inkpanel-update',
    `TRANSACTION_ROOT=${bashPath(transactionRoot)}`,
  );
  script = script.replace('HEALTH_MAX_ATTEMPTS=45', 'HEALTH_MAX_ATTEMPTS=5');
  await writeExecutable(updater, script);
  await cp(WRITE_STATUS, join(dir, 'write-status.mjs'));

  return {
    dir, upstream, appDir, repoDir, dataDir, updater, stubbin, healthPlan,
    curlLog, systemctlLog, npmLog, statusTrace, serviceState, startCount, buildMarker,
    protectedDepsLog, transactionRoot,
  };
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'inkpanel-transaction-'));
  try {
    await fn(await setupFixture(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function commitUpstream(
  fixture: Fixture,
  message: string,
  change: () => Promise<void>,
): Promise<string> {
  await change();
  await run('git', ['add', '-A'], { cwd: fixture.upstream });
  await run('git', ['commit', '-q', '-m', message], { cwd: fixture.upstream });
  return (await run('git', ['rev-parse', 'HEAD'], { cwd: fixture.upstream })).stdout.trim();
}

async function head(fixture: Fixture): Promise<string> {
  return (await run('git', ['rev-parse', 'HEAD'], { cwd: fixture.repoDir })).stdout.trim();
}

async function runUpdater(
  fixture: Fixture,
  responses: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; status: UpdateStatus; stderr: string }> {
  await writeFile(fixture.healthPlan, `${responses.join('\n')}\n`);
  let code = 0;
  let stderr = '';
  try {
    await run(BASH, [fixture.updater], {
      env: {
        ...process.env,
        PATH: process.platform === 'win32'
          ? `${bashPath(fixture.stubbin)}:/usr/bin:/bin`
          : `${fixture.stubbin}:${process.env.PATH}`,
        REAL_NODE: process.platform === 'win32' ? bashPath(process.execPath) : process.execPath,
        SYSTEMCTL_LOG: process.platform === 'win32' ? bashPath(fixture.systemctlLog) : fixture.systemctlLog,
        SERVICE_STATE: process.platform === 'win32' ? bashPath(fixture.serviceState) : fixture.serviceState,
        START_COUNT_FILE: process.platform === 'win32' ? bashPath(fixture.startCount) : fixture.startCount,
        HEALTH_PLAN: process.platform === 'win32' ? bashPath(fixture.healthPlan) : fixture.healthPlan,
        CURL_LOG: process.platform === 'win32' ? bashPath(fixture.curlLog) : fixture.curlLog,
        NPM_LOG: process.platform === 'win32' ? bashPath(fixture.npmLog) : fixture.npmLog,
        STATUS_TRACE: process.platform === 'win32' ? bashPath(fixture.statusTrace) : fixture.statusTrace,
        CONFIG_PATH: process.platform === 'win32'
          ? bashPath(join(fixture.dataDir, 'config.json'))
          : join(fixture.dataDir, 'config.json'),
        PROTECTED_DEPS_LOG: process.platform === 'win32'
          ? bashPath(fixture.protectedDepsLog)
          : fixture.protectedDepsLog,
        TRANSACTION_ROOT_PATH: process.platform === 'win32'
          ? bashPath(fixture.transactionRoot)
          : fixture.transactionRoot,
        ...env,
      },
    });
  } catch (err) {
    code = (err as { code?: number }).code ?? 1;
    stderr = (err as { stderr?: string }).stderr ?? '';
  }
  let statusText: string;
  try {
    statusText = await readFile(join(fixture.dataDir, 'update-status.json'), 'utf8');
  } catch (err) {
    throw new Error(`updater produced no status (exit ${code}): ${stderr}`, { cause: err });
  }
  const status = JSON.parse(statusText) as UpdateStatus;
  return { code, status, stderr };
}

test('status remains running until three consecutive candidate health probes succeed', async () => {
  await withFixture(async (fixture) => {
    await commitUpstream(fixture, 'server change', async () => {
      await writeFile(join(fixture.upstream, 'README.md'), 'candidate\n');
    });
    const result = await runUpdater(fixture, ['200', '200', '503', '200', '200', '200']);
    const states = (await readFile(fixture.statusTrace, 'utf8')).trim().split('\n');

    assert.equal(result.code, 0, `${result.stderr}\n${result.status.log.join('\n')}`);
    assert.equal(result.status.state, 'success');
    assert.equal(states.at(-1), 'success');
    assert.ok(states.slice(0, -1).every((state) => state === 'running'));
    assert.ok(result.status.log.some((line) => line.includes('3/3 consecutive')));
  });
});

test('failed candidate health rolls back multiple commits to the exact baseline SHA', async () => {
  await withFixture(async (fixture) => {
    const before = await head(fixture);
    await commitUpstream(fixture, 'first candidate commit', async () => {
      await writeFile(join(fixture.upstream, 'README.md'), 'candidate one\n');
    });
    await commitUpstream(fixture, 'second candidate commit', async () => {
      await writeFile(join(fixture.upstream, 'README.md'), 'candidate two\n');
    });

    const result = await runUpdater(
      fixture,
      ['200', '503', '503', '503', '503', '503', '200', '200', '200'],
    );

    assert.notEqual(result.code, 0);
    assert.equal(await head(fixture), before);
    assert.equal(result.status.state, 'failed');
    assert.match(result.status.error ?? '', /automatic rollback succeeded/i);
    assert.match(result.status.error ?? '', new RegExp(before));
  });
});

test('rollback restores exact config bytes after a failed candidate writes a future schema', async () => {
  await withFixture(async (fixture) => {
    const baseline = await readFile(join(fixture.dataDir, 'config.json'));
    await commitUpstream(fixture, 'candidate', async () => {
      await writeFile(join(fixture.upstream, 'README.md'), 'candidate\n');
    });
    const result = await runUpdater(
      fixture,
      ['200', '503', '503', '503', '503', '503', '200', '200', '200'],
      { CANDIDATE_CONFIG_CONTENT: '{"schemaVersion":999,"devices":[]}' },
    );

    assert.notEqual(result.code, 0);
    assert.deepEqual(await readFile(join(fixture.dataDir, 'config.json')), baseline);
    assert.match(result.status.error ?? '', /rolled back/i);
  });
});

test('rollback restores config absence when the candidate creates config.json', async () => {
  await withFixture(async (fixture) => {
    const configPath = join(fixture.dataDir, 'config.json');
    await rm(configPath);
    await commitUpstream(fixture, 'candidate', async () => {
      await writeFile(join(fixture.upstream, 'README.md'), 'candidate\n');
    });
    await runUpdater(
      fixture,
      ['200', '503', '503', '503', '503', '503', '200', '200', '200'],
      { CANDIDATE_CONFIG_CONTENT: '{"schemaVersion":999,"devices":[]}' },
    );

    await assert.rejects(access(configPath));
  });
});

test('candidate server rollback restores the previous firmware package', async () => {
  await withFixture(async (fixture) => {
    await commitUpstream(fixture, 'firmware candidate', async () => {
      await writeFile(join(fixture.upstream, 'firmware', 'marker.txt'), 'new firmware input\n');
    });
    await runUpdater(fixture, ['200', '503', '503', '503', '503', '503', '200', '200', '200']);

    assert.equal(
      await readFile(join(fixture.repoDir, 'firmware', 'dist', 'package.txt'), 'utf8'),
      'old firmware\n',
    );
  });
});

test('candidate server rollback restores firmware package absence', async () => {
  await withFixture(async (fixture) => {
    const dist = join(fixture.repoDir, 'firmware', 'dist');
    await rm(dist, { recursive: true });
    await commitUpstream(fixture, 'firmware candidate', async () => {
      await writeFile(join(fixture.upstream, 'firmware', 'marker.txt'), 'new firmware input\n');
    });
    await runUpdater(fixture, ['200', '503', '503', '503', '503', '503', '200', '200', '200']);

    await assert.rejects(access(dist));
  });
});

test('dependency staging failure leaves live node_modules and service alone and restores Git', async () => {
  await withFixture(async (fixture) => {
    const before = await head(fixture);
    await commitUpstream(fixture, 'dependency candidate', async () => {
      await writeFile(join(fixture.upstream, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
    });
    const result = await runUpdater(
      fixture,
      ['200', '200', '200', '200'],
      { NPM_FAIL: '1' },
    );

    assert.notEqual(result.code, 0);
    assert.equal(await head(fixture), before);
    assert.equal(
      await readFile(join(fixture.repoDir, 'node_modules', 'package.txt'), 'utf8'),
      'old dependencies\n',
    );
    assert.doesNotMatch(await readFile(fixture.systemctlLog, 'utf8').catch(() => ''), /systemctl stop/);
  });
});

test('health failure after dependency activation restores old node_modules without rerunning npm', async () => {
  await withFixture(async (fixture) => {
    await commitUpstream(fixture, 'dependency candidate', async () => {
      await writeFile(join(fixture.upstream, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
    });
    await runUpdater(
      fixture,
      ['200', '503', '503', '503', '503', '503', '200', '200', '200'],
      { CANDIDATE_TAMPER_DEPS: '1' },
    );

    const protectedPath = await readFile(fixture.protectedDepsLog, 'utf8');
    assert.ok(protectedPath.startsWith(fixture.transactionRoot));
    assert.ok(!protectedPath.startsWith(fixture.repoDir));
    assert.equal(
      await readFile(join(fixture.repoDir, 'node_modules', 'package.txt'), 'utf8'),
      'old dependencies\n',
    );
    await assert.rejects(access(join(fixture.repoDir, 'node_modules', 'candidate-tampered.txt')));
    assert.equal((await readFile(fixture.npmLog, 'utf8')).trim().split('\n').length, 1);
  });
});

test('dependency rollback preserves a symlink baseline without mutating its target', async () => {
  await withFixture(async (fixture) => {
    const liveDependencies = join(fixture.repoDir, 'node_modules');
    const target = join(fixture.dir, 'dependency-target');
    await rm(liveDependencies, { recursive: true });
    await mkdir(target);
    await writeFile(join(target, 'package.txt'), 'symlink target dependencies\n');
    await chmod(target, 0o751);
    const targetBefore = await stat(target);
    await symlink(target, liveDependencies, 'dir');

    await commitUpstream(fixture, 'dependency candidate', async () => {
      await writeFile(join(fixture.upstream, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
    });
    await runUpdater(
      fixture,
      ['200', '503', '503', '503', '503', '503', '200', '200', '200'],
    );

    assert.equal((await lstat(liveDependencies)).isSymbolicLink(), true);
    assert.equal(await readlink(liveDependencies), target);
    assert.equal(await readFile(join(target, 'package.txt'), 'utf8'), 'symlink target dependencies\n');
    const targetAfter = await stat(target);
    assert.equal(targetAfter.mode & 0o777, targetBefore.mode & 0o777);
    assert.equal(targetAfter.uid, targetBefore.uid);
    assert.equal(targetAfter.gid, targetBefore.gid);
    assert.equal((await readFile(fixture.npmLog, 'utf8')).trim().split('\n').length, 1);
  });
});

test('an app-controlled status symlink cannot redirect the update writer', async () => {
  await withFixture(async (fixture) => {
    const sentinel = join(fixture.dir, 'protected-sentinel.txt');
    const statusPath = join(fixture.dataDir, 'update-status.json');
    const original = Buffer.from('root-owned sentinel bytes\n');
    await writeFile(sentinel, original);
    await symlink(sentinel, statusPath);
    await commitUpstream(fixture, 'candidate', async () => {
      await writeFile(join(fixture.upstream, 'README.md'), 'candidate\n');
    });

    const result = await runUpdater(fixture, ['200', '200', '200', '200']);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await readFile(sentinel), original);
    assert.equal(result.status.state, 'success');
  });
});

test('unhealthy preflight performs no git pull', async () => {
  await withFixture(async (fixture) => {
    const before = await head(fixture);
    await commitUpstream(fixture, 'candidate', async () => {
      await writeFile(join(fixture.upstream, 'README.md'), 'candidate\n');
    });
    const result = await runUpdater(fixture, ['503']);

    assert.notEqual(result.code, 0);
    assert.equal(await head(fixture), before);
    assert.ok(!result.status.log.some((line) => line.includes('git pull')));
  });
});

test('tracked local modifications are refused without being destroyed', async () => {
  await withFixture(async (fixture) => {
    const local = 'locally modified and precious\n';
    await writeFile(join(fixture.repoDir, 'README.md'), local);
    const result = await runUpdater(fixture, ['200']);

    assert.notEqual(result.code, 0);
    assert.equal(await readFile(join(fixture.repoDir, 'README.md'), 'utf8'), local);
    assert.match(result.status.error ?? '', /tracked local modifications/i);
  });
});

test('rollback failure reports manual intervention required', async () => {
  await withFixture(async (fixture) => {
    await commitUpstream(fixture, 'candidate', async () => {
      await writeFile(join(fixture.upstream, 'README.md'), 'candidate\n');
    });
    const result = await runUpdater(
      fixture,
      ['200', '503', '503', '503', '503', '503', '503', '503', '503', '503', '503'],
    );

    assert.notEqual(result.code, 0);
    assert.equal(result.status.state, 'failed');
    assert.match(result.status.error ?? '', /manual intervention required/i);
  });
});

test('PORT is parsed as validated data and shell syntax is never executed', async () => {
  await withFixture(async (fixture) => {
    await writeFile(join(fixture.appDir, 'inkpanel.env'), 'PORT=9090\n');
    await commitUpstream(fixture, 'candidate', async () => {
      await writeFile(join(fixture.upstream, 'README.md'), 'candidate\n');
    });
    const valid = await runUpdater(fixture, ['200', '200', '200', '200']);
    assert.equal(valid.code, 0);
    assert.match(await readFile(fixture.curlLog, 'utf8'), /127\.0\.0\.1:9090\/health/);
  });

  await withFixture(async (fixture) => {
    const marker = join(fixture.dir, 'must-not-exist');
    await writeFile(
      join(fixture.appDir, 'inkpanel.env'),
      `PORT=$(touch ${posix(marker)})\n`,
    );
    const invalid = await runUpdater(fixture, ['200']);
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.status.error ?? '', /invalid PORT/i);
    await assert.rejects(access(marker));
  });
});

test('the deployed updater never promotes checkout content into privileged paths', async () => {
  const script = await readFile(UPDATER, 'utf8');
  assert.doesNotMatch(
    script,
    /(?:cp|install)\s+[^\n]*(?:\/usr\/local\/bin|\/etc\/systemd\/system)/,
    'an app-owned checkout must never replace a root executable or unit during self-update',
  );
});

test('root never follows app-controlled firmware paths during snapshot or restore', async () => {
  const script = await readFile(UPDATER, 'utf8');
  assert.doesNotMatch(script, /(^|\n)\s*(?:cp|rm\s+-rf)\b[^\n]*\$FIRMWARE_DIST/);
  assert.match(script, /runuser -u "\$APP" -- cp -a -- "\$FIRMWARE_DIST"/);
  assert.match(script, /runuser -u "\$APP" -- rm -rf -- "\$FIRMWARE_DIST"/);
  assert.match(
    script,
    /mv -- "\$FIRMWARE_STAGE" "\$TRANSACTION_DIR\/firmware-snapshot"/,
  );
  assert.match(
    script,
    /mv -T -- "\$TRANSACTION_DIR\/firmware-snapshot" "\$restore_stage"/,
    'root must treat the app-owned restore destination as a final path, not a directory',
  );
  assert.doesNotMatch(
    script,
    /(^|\n)\s*mv\s+[^\n]*\$FIRMWARE_STAGE\//,
    'root must rename the staging object without traversing its contents',
  );
  assert.match(
    script,
    /runuser -u "\$APP" -- mv -- "\$restore_stage\/firmware-dist" "\$FIRMWARE_DIST"/,
  );
  assert.match(script, /\[\[ ! -d "\$REPO_DIR" \|\| -L "\$REPO_DIR" \]\]/);
});

test('dependency snapshots are opaque renames with no root ownership or mode changes', async () => {
  const script = await readFile(UPDATER, 'utf8');
  assert.doesNotMatch(script, /DEPS_OLD_MODE/);
  assert.match(
    script,
    /mv -T -- "\$REPO_DIR\/node_modules" "\$DEPS_OLD"/,
  );
  assert.match(
    script,
    /mv -T -- "\$DEPS_OLD" "\$REPO_DIR\/node_modules"/,
  );
  assert.match(
    script,
    /runuser -u "\$APP" -- rm -rf -- "\$REPO_DIR\/node_modules"/,
  );
  assert.match(
    script,
    /runuser -u "\$APP" -- mv -T -- "\$DEPS_STAGE\/node_modules" "\$REPO_DIR\/node_modules"/,
  );
  assert.doesNotMatch(script, /(?:chown|chmod)[^\n]*(?:\$DEPS_OLD|\$REPO_DIR\/node_modules)/);
});

test('status publication and mode changes run as the unprivileged app user', async () => {
  const script = await readFile(UPDATER, 'utf8');
  const start = script.indexOf('write_status() {');
  const end = script.indexOf('\n}', start);
  assert.ok(start > -1 && end > start, 'could not locate write_status');
  const block = script.slice(start, end);
  assert.match(block, /runuser -u "\$APP" -- node/);
  assert.doesNotMatch(block, /(^|\n)\s*(?:node|chmod)\s/);
});
