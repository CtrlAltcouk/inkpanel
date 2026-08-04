import { getJson, sendJson } from './api.js';
import { esc } from './components.js';

const POLL_MS = 2000;
const GIVE_UP_MS = 3 * 60 * 1000;

function formatBytes(bytes) {
  if (typeof bytes !== 'number') return 'unknown';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB free` : `${Math.round(bytes / 1024 ** 2)} MB free`;
}

function updateLine(update) {
  if (update.state === 'behind') return `Update available (${esc(update.remote)})`;
  if (update.state === 'current') return 'Up to date';
  // Deliberately not "up to date" — failing to check is not the same thing.
  return `Could not check${update.error ? `: ${esc(update.error)}` : ''}`;
}

/**
 * `sources.issues` is `[]` both when every rendered panel is reporting ok and
 * when nothing has rendered since the last restart (the FrameService memo it
 * is read from starts empty). Collapsing those into one "all healthy" message
 * would be exactly the false all-clear that the split `renderedDevices` /
 * `totalDevices` shape exists to prevent — so the three situations (nothing
 * to report on, nothing rendered yet, and rendered-with-issues-or-not) are
 * rendered as distinct lines rather than one glossed-over pill.
 */
function sourcesLine({ issues, renderedDevices, totalDevices }) {
  if (totalDevices === 0) return 'No panels yet.';

  if (renderedDevices === 0) {
    return `Nothing rendered since restart yet (${totalDevices} panel${totalDevices === 1 ? '' : 's'} known).`;
  }

  const coverage = renderedDevices < totalDevices
    ? ` (${renderedDevices} of ${totalDevices} panel${totalDevices === 1 ? '' : 's'} rendered)`
    : '';

  return issues.length === 0
    ? `All sources healthy${coverage}.`
    : `${issues.length} source issue${issues.length === 1 ? '' : 's'}${coverage}:`;
}

function sourcesSection(sources) {
  const items = sources.issues
    .map((issue) => `<li>${esc(issue.deviceId)} · ${esc(issue.sourceId)}: ${esc(issue.status)}${issue.error ? ` — ${esc(issue.error)}` : ''}</li>`)
    .join('');
  return `<p class="meta">${sourcesLine(sources)}</p>${items ? `<ul class="issue-list">${items}</ul>` : ''}`;
}

function view(info) {
  const canUpdate = info.update.state === 'behind';
  return `<div class="card">
    <h2>Server</h2>
    <div class="health">
      <span class="pill">v${esc(info.version)}${info.commit ? ` · ${esc(info.commit)}` : ''}</span>
      <span class="pill">${Math.round(info.uptimeSeconds / 60)}m uptime</span>
      <span class="pill">${info.deviceCount} panel${info.deviceCount === 1 ? '' : 's'}</span>
      <span class="pill">${esc(formatBytes(info.freeBytes))}</span>
    </div>

    <h3>Sources</h3>
    ${sourcesSection(info.sources)}

    <h3>Updates</h3>
    <p class="meta">${updateLine(info.update)}</p>
    <div class="actions">
      <button type="button" id="update" ${canUpdate ? '' : 'disabled'}>
        ${canUpdate ? 'Update now' : 'Nothing to update'}
      </button>
      <button type="button" class="ghost" id="recheck">Check again</button>
    </div>
    <pre class="update-log" id="log" hidden></pre>
    <p class="error" id="error" hidden></p>
  </div>`;
}

/**
 * Poll until the update finishes.
 *
 * The server restarts underneath us partway through, so connection failures are
 * an expected part of a successful update rather than an error condition.
 */
async function pollUntilDone(log) {
  const deadline = Date.now() + GIVE_UP_MS;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));

    let status = null;
    try {
      status = await getJson('/api/system/update/status');
    } catch {
      log.textContent = 'Server restarting…';
      continue;
    }

    if (status.log.length > 0) log.textContent = status.log.join('\n');

    if (status.state === 'success') {
      log.textContent += '\n\nDone. Reloading…';
      setTimeout(() => location.reload(), 1500);
      return;
    }
    if (status.state === 'failed') {
      log.textContent = `${status.log.join('\n')}\n\nFAILED: ${status.error ?? 'unknown'}\n\nThe old version is still running.`;
      return;
    }
  }

  log.textContent += '\n\nGave up waiting. Check: journalctl -u inkpanel -n 50';
}

export async function renderSettings(root) {
  const info = await getJson('/api/system/info');
  root.innerHTML = view(info);

  const log = root.querySelector('#log');
  const error = root.querySelector('#error');

  root.querySelector('#recheck').addEventListener('click', async () => {
    root.innerHTML = '<p class="empty">Checking…</p>';
    await renderSettings(root);
  });

  root.querySelector('#update').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Updating…';
    error.hidden = true;
    log.hidden = false;
    log.textContent = 'Requested…';

    try {
      await sendJson('POST', '/api/system/update');
    } catch (err) {
      if (err.status === 409) {
        // A real state, not a generic failure: an update is already running
        // (another tab, or a previous press that outlived a reload). Watch
        // its status instead of reporting this request's own rejection.
        log.textContent = 'An update is already in progress — watching…';
      } else {
        error.textContent = err.message;
        error.hidden = false;
        button.disabled = false;
        button.textContent = 'Update now';
        return;
      }
    }

    await pollUntilDone(log);
  });
}
