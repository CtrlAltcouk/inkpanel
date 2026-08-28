import { getJson, sendJson } from './api.js';
import { esc } from './components.js';
import { renderHomeAssistantUsers } from './homeAssistantUsers.js';

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
  return `Could not check${update.error ? `: ${esc(update.error)}` : ''}`;
}

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

function homeAssistantSection(status) {
  if (status?.mode !== 'home-assistant-app') {
    return `<h3>Home Assistant</h3><p class="meta">Not running as a Home Assistant App.</p>`;
  }
  if (!status.available) {
    return `<h3>Home Assistant</h3><div class="health"><span class="pill">Unavailable</span></div>
      <p class="meta">${esc(status.error || 'Could not reach the Home Assistant Core API.')}</p>
      <p class="meta">Updates are managed by Home Assistant.</p>`;
  }
  return `<h3>Home Assistant</h3><div class="health">
    <span class="pill">Connected</span>
    <span class="pill">Core ${esc(status.version)}</span>
    <span class="pill">${esc(status.locationName)}</span>
    <span class="pill">${esc(status.timeZone)}</span>
  </div>
  <p class="meta">Updates are managed by Home Assistant.</p>`;
}

export function settingsView(info, homeAssistantStatus) {
  return `<div class="studio-card">
    <div class="studio-card-head"><div><h2>Server</h2><p class="meta">InkPanel runtime and source health.</p></div></div>
    <div class="health">
      <span class="pill">v${esc(info.version)}${info.commit ? ` · ${esc(info.commit)}` : ''}</span>
      <span class="pill">${Math.round(info.uptimeSeconds / 60)}m uptime</span>
      <span class="pill">${info.deviceCount} panel${info.deviceCount === 1 ? '' : 's'}</span>
      <span class="pill">${esc(formatBytes(info.freeBytes))}</span>
    </div>
    <h3>Sources</h3>
    ${sourcesSection(info.sources)}
    ${homeAssistantSection(homeAssistantStatus)}
    <div class="actions"><button type="button" class="ghost" id="recheck">Refresh status</button></div>
  </div>`;
}

function updatesView(info) {
  const canUpdate = info.update.state === 'behind';
  return `<div class="studio-card">
    <div class="studio-card-head"><div><h2>Updates</h2><p class="meta">Use InkPanel's built-in transactional updater. Failed candidates automatically roll back.</p></div></div>
    <div class="health">
      <span class="pill">Installed v${esc(info.version)}${info.commit ? ` · ${esc(info.commit)}` : ''}</span>
      <span class="pill">${esc(updateLine(info.update))}</span>
    </div>
    <div class="actions">
      <button type="button" id="update" ${canUpdate ? '' : 'disabled'}>${canUpdate ? 'Update now' : 'Nothing to update'}</button>
      <button type="button" class="ghost" id="recheck">Check again</button>
    </div>
    <pre class="update-log" id="log" hidden></pre>
    <p class="error" id="error" hidden></p>
  </div>`;
}

export function isCurrentStatus(status, requestedAt) {
  if (!status?.startedAt) return false;
  return new Date(status.startedAt).getTime() >= new Date(requestedAt).getTime();
}

async function pollUntilDone(log, requestedAt) {
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
    if (requestedAt && !isCurrentStatus(status, requestedAt)) continue;
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

export async function renderSettings(root, { refresh = false } = {}) {
  const [info, homeAssistantStatus] = await Promise.all([
    getJson(`/api/system/info${refresh ? '?refresh=1' : ''}`),
    getJson('/api/home-assistant/status'),
  ]);
  root.innerHTML = settingsView(info, homeAssistantStatus);
  if (homeAssistantStatus?.mode === 'home-assistant-app') {
    const ownership = document.createElement('div');
    root.append(ownership);
    await renderHomeAssistantUsers(ownership);
  }
  root.querySelector('#recheck').addEventListener('click', async () => {
    root.innerHTML = '<p class="empty">Checking…</p>';
    try {
      await renderSettings(root, { refresh: true });
    } catch (err) {
      if (err?.status === 401) return;
      root.innerHTML = `<div class="card"><p class="error">${esc(err.message)}</p></div>`;
    }
  });
}

export async function renderUpdates(root, { refresh = false } = {}) {
  const info = await getJson(`/api/system/info${refresh ? '?refresh=1' : ''}`);
  root.innerHTML = updatesView(info);

  const log = root.querySelector('#log');
  const error = root.querySelector('#error');

  root.querySelector('#recheck').addEventListener('click', async () => {
    root.innerHTML = '<p class="empty">Checking…</p>';
    try {
      await renderUpdates(root, { refresh: true });
    } catch (err) {
      if (err?.status === 401) return;
      root.innerHTML = `<div class="card"><p class="error">${esc(err.message)}</p></div>`;
    }
  });

  root.querySelector('#update').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Updating…';
    error.hidden = true;
    log.hidden = false;
    log.textContent = 'Requested…';

    let requestedAt = null;
    try {
      const response = await sendJson('POST', '/api/system/update');
      requestedAt = response.requestedAt;
    } catch (err) {
      if (err.status === 409) {
        log.textContent = 'An update is already in progress — watching…';
      } else if (err.status === 401) {
        return;
      } else {
        error.textContent = err.message;
        error.hidden = false;
        button.disabled = false;
        button.textContent = 'Update now';
        return;
      }
    }

    await pollUntilDone(log, requestedAt);
  });
}
