import { getJson, sendJson } from './api.js';
import { appPath } from './paths.js';
import { esc, formatRelative, formatVolts, field, pill } from './components.js';
import {
  collectBusApiCredentials,
  collectDashboardSections,
  collectRememberedDashboardSettings,
  collectTrafficApiKey,
  collectTrainApiKey,
  renderDashboardEditor,
} from './dashboardEditor.js';

const MINI_PROFILE = 'ssd1681-200x200-mono';
let selectedId = null;
let selectedPanelTab = 'dashboard';
let previewRevision = 0;

function panelPreviewUrl(deviceId) {
  // Fresh on open, save/reopen and explicit refresh, even within one clock tick.
  return appPath(`/api/devices/${encodeURIComponent(deviceId)}/render.png?t=${Date.now()}-${++previewRevision}`);
}

export function setSelectedPanel(id) { selectedId = id; }
function isMini(device) { return device.panelProfileId === MINI_PROFILE; }
function displayLabel(device) { return isMini(device) ? 'InkPanel Mini · 1.54 inch · 200 × 200' : 'InkPanel · 7.5 inch · 800 × 480'; }

function panelHeader(device) {
  return `<div class="panel-workspace-header">
    <div class="panel-workspace-title">
      <h1>${esc(device.name)}</h1>
      <div class="panel-workspace-id">${esc(device.id)} · ${esc(device.locationLabel || 'No location')}</div>
    </div>
    <div class="panel-workspace-statuses">
      ${device.claimed ? pill('Claimed', 'status--claimed') : pill('Unclaimed', 'status--unclaimed')}
      ${isMini(device) ? pill('Mini · 200×200') : pill('7.5″ · 800×480')}
      ${pill(`fw ${device.lastFirmwareVersion ?? 'unknown'}`)}
      ${pill(formatVolts(device.lastBatteryVolts))}
      ${pill(formatRelative(device.lastSeenAt))}
    </div>
  </div>`;
}

function stat(label, value) {
  return `<div class="panel-stat"><div class="panel-stat-label">${esc(label)}</div><div class="panel-stat-value">${esc(value)}</div></div>`;
}

function detail(device) {
  const mini = isMini(device);
  return `<div id="detail">
    ${panelHeader(device)}
    <div class="panel-tabs" role="tablist" aria-label="Panel settings">
      <button type="button" data-panel-tab="dashboard">Dashboard</button>
      <button type="button" data-panel-tab="device">Device</button>
      <button type="button" data-panel-tab="schedule">Schedule</button>
    </div>

    <form data-id="${esc(device.id)}">
      <section class="panel-view" data-panel-view="dashboard">
        <div class="studio-grid ${mini ? 'studio-grid--mini' : ''}">
          <div class="studio-card">
            <div class="studio-card-head"><div><h2>Live e-ink preview</h2><p class="meta">${esc(displayLabel(device))} · exactly what this panel will show</p></div></div>
            <div class="panel-preview-wrap ${mini ? 'panel-preview-wrap--mini' : ''}">
              <img class="panel-preview-image ${mini ? 'panel-preview-image--mini' : ''}" alt="What ${esc(device.name)} is showing" src="${panelPreviewUrl(device.id)}">
            </div>
            <div class="actions">
              <button type="button" data-push="${esc(device.id)}">Push to display</button>
              <button type="button" class="ghost" data-zoom="${esc(device.id)}">View full size</button>
            </div>
            <div class="panel-stat-grid">
              ${stat('Last seen', formatRelative(device.lastSeenAt))}
              ${stat('Refresh', `${device.activeIntervalSeconds}s`)}
              ${stat('Quiet hours', `${String(device.quietHoursStart).padStart(2, '0')}:00–${String(device.quietHoursEnd).padStart(2, '0')}:00`)}
              ${stat('Location', device.locationLabel || 'Not set')}
            </div>
          </div>

          <div class="studio-card">
            <div class="studio-card-head"><div><h3>${mini ? 'Display content' : 'Dashboard layout'}</h3><p class="meta">${mini ? 'One widget fills this Mini display. Widget settings are remembered.' : 'Select a section to configure it. Widget settings are remembered.'}</p></div></div>
            <div class="dashboard-editor" id="dashboard-editor"></div>
          </div>
        </div>
      </section>

      <section class="panel-view" data-panel-view="device" hidden>
        <div class="device-settings-grid">
          <div class="studio-card">
            <div class="studio-card-head"><div><h2>Device details</h2><p class="meta">Identity and location for this panel.</p></div></div>
            ${field(device.id, 'name', 'Name', device.name)}
            <label>City</label><div id="city-picker"></div>
            ${field(device.id, 'timezone', 'Timezone', device.timezone)}
            <label class="checkbox"><input type="checkbox" name="claimed" ${device.claimed ? 'checked' : ''}>Claimed — show the dashboard instead of the setup screen</label>
          </div>
          <div class="studio-card">
            <div class="studio-card-head"><div><h2>Status</h2><p class="meta">Read-only information reported by the panel.</p></div></div>
            <div class="panel-stat-grid">
              ${stat('Device ID', device.id)}
              ${stat('Display', mini ? 'Mini 200×200' : '7.5″ 800×480')}
              ${stat('Firmware', device.lastFirmwareVersion ?? 'unknown')}
              ${stat('Battery', formatVolts(device.lastBatteryVolts))}
              ${stat('Last seen', formatRelative(device.lastSeenAt))}
            </div>
          </div>
        </div>
      </section>

      <section class="panel-view" data-panel-view="schedule" hidden>
        <div class="studio-card">
          <div class="studio-card-head"><div><h2>Refresh schedule</h2><p class="meta">Normal wake interval and quiet hours.</p></div></div>
          <div class="schedule-settings-grid">
            <div>${field(device.id, 'activeIntervalSeconds', 'Interval (seconds)', device.activeIntervalSeconds, 'number')}</div>
            <div>${field(device.id, 'quietHoursStart', 'Quiet from (hour)', device.quietHoursStart, 'number')}</div>
            <div>${field(device.id, 'quietHoursEnd', 'Quiet until (hour)', device.quietHoursEnd, 'number')}</div>
          </div>
        </div>
      </section>

      <p class="notice" id="notice" hidden></p>
      <p class="error" id="error" hidden></p>
      <div class="panel-save-bar">
        <span class="panel-save-state" id="save-state">All changes saved</span>
        <div class="actions"><button type="submit">Save changes</button></div>
      </div>
    </form>
  </div>`;
}

function showError(root, err) {
  const notice = root.querySelector('#notice'); const error = root.querySelector('#error');
  if (notice) notice.hidden = true;
  if (!error) return;
  const detailText = (err.issues ?? []).map((i) => `${i.path?.join('.') ?? '?'}: ${i.message}`).join('\n');
  error.textContent = `${err.message}${detailText ? `\n${detailText}` : ''}`; error.hidden = false;
}
function showNotice(root, text) {
  const notice = root.querySelector('#notice'); const error = root.querySelector('#error');
  if (error) error.hidden = true; if (notice) { notice.textContent = text; notice.hidden = false; }
}
function pushMessage(result) {
  if (result.willAppearBy) return `Rendered. Will appear by ${new Date(result.willAppearBy).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — or wake the panel for now.`;
  if (result.overdueSince) return 'Rendered. The panel will collect it when it next wakes.';
  return 'Rendered. Will appear at the panel’s next check-in.';
}

export function refreshPanelPreview(root, deviceId) {
  const img = root.querySelector('.panel-preview-image');
  if (img) img.src = panelPreviewUrl(deviceId);
}

export function bindTodoPreviewRefresh(editor, root, deviceId) {
  editor.addEventListener('inkpanel:todo-content-changed', () => refreshPanelPreview(root, deviceId));
}

export function bindPrinterPreviewRefresh(editor, root, deviceId) {
  editor.addEventListener('inkpanel:printer-content-changed', () => refreshPanelPreview(root, deviceId));
}

async function save(event, root) {
  event.preventDefault();
  const form = event.target; const raw = Object.fromEntries(new FormData(form));
  const picker = form.querySelector('#city-picker'); const dashboardEditor = form.querySelector('#dashboard-editor');
  const body = {
    name: raw.name, timezone: raw.timezone,
    dashboardSections: collectDashboardSections(dashboardEditor),
    activeIntervalSeconds: Number(raw.activeIntervalSeconds), quietHoursStart: Number(raw.quietHoursStart), quietHoursEnd: Number(raw.quietHoursEnd),
    claimed: form.querySelector('[name=claimed]').checked,
  };
  if (picker?.dataset.latitude) {
    body.latitude = Number(picker.dataset.latitude); body.longitude = Number(picker.dataset.longitude); body.locationLabel = picker.dataset.label;
    if (picker.dataset.timezone) body.timezone = picker.dataset.timezone;
  }
  const trainKey = collectTrainApiKey(dashboardEditor); if (trainKey) await sendJson('PUT', '/api/national-rail', { apiKey: trainKey });
  const bus = collectBusApiCredentials(dashboardEditor); if (bus) await sendJson('PUT', '/api/transportapi', bus);
  const trafficKey = collectTrafficApiKey(dashboardEditor); if (trafficKey) await sendJson('PUT', '/api/google-maps', { apiKey: trafficKey });
  await sendJson('PUT', `/api/dashboard-editor/${encodeURIComponent(form.dataset.id)}`, collectRememberedDashboardSettings(dashboardEditor));
  await sendJson('PUT', `/api/devices/${encodeURIComponent(form.dataset.id)}`, body);
  window.dispatchEvent(new CustomEvent('inkpanel:devices-changed'));
  await renderPanels(root);
}

function activateTab(detailEl, name) {
  selectedPanelTab = name;
  detailEl.querySelectorAll('[data-panel-tab]').forEach((button) => button.classList.toggle('on', button.dataset.panelTab === name));
  detailEl.querySelectorAll('[data-panel-view]').forEach((section) => { section.hidden = section.dataset.panelView !== name; });
}

async function renderDetail(root, device, serviceStatus) {
  root.innerHTML = detail(device);
  window.dispatchEvent(new CustomEvent('inkpanel:panel-selected', { detail: { id: device.id } }));
  const detailEl = root.querySelector('#detail'); const form = detailEl.querySelector('form');
  activateTab(detailEl, selectedPanelTab);
  detailEl.querySelectorAll('[data-panel-tab]').forEach((button) => button.addEventListener('click', () => activateTab(detailEl, button.dataset.panelTab)));
  form.addEventListener('input', () => { const state = form.querySelector('#save-state'); if (state) state.textContent = 'Unsaved changes'; });
  form.addEventListener('change', () => { const state = form.querySelector('#save-state'); if (state) state.textContent = 'Unsaved changes'; });
  form.addEventListener('submit', (event) => void save(event, root).catch((err) => { if (err?.status !== 401) showError(root, err); }));

  detailEl.querySelector('[data-push]').addEventListener('click', async (event) => {
    const button = event.currentTarget; button.disabled = true; button.textContent = 'Rendering…';
    try {
      const result = await sendJson('POST', `/api/devices/${encodeURIComponent(button.dataset.push)}/push`);
      showNotice(root, pushMessage(result));
      refreshPanelPreview(root, button.dataset.push);
    } catch (err) { if (err?.status !== 401) showError(root, err); }
    finally { button.disabled = false; button.textContent = 'Push to display'; }
  });
  detailEl.querySelector('[data-zoom]').addEventListener('click', () => root.querySelector('.panel-preview-image')?.classList.toggle('panel-preview-image--zoomed'));
  detailEl.querySelector('.panel-preview-image').addEventListener('click', (event) => { if (event.currentTarget.classList.contains('panel-preview-image--zoomed')) event.currentTarget.classList.remove('panel-preview-image--zoomed'); });

  const [{ renderCityPicker }, remembered] = await Promise.all([import('./cityPicker.js'), getJson(`/api/dashboard-editor/${encodeURIComponent(device.id)}`)]);
  renderCityPicker(detailEl.querySelector('#city-picker'), device);
  const dashboardEditor = detailEl.querySelector('#dashboard-editor');
  bindTodoPreviewRefresh(dashboardEditor, root, device.id);
  bindPrinterPreviewRefresh(dashboardEditor, root, device.id);
  renderDashboardEditor(dashboardEditor, device, serviceStatus.trainApi, serviceStatus.busApi, serviceStatus.trafficApi, remembered, serviceStatus.todoLists, serviceStatus.printers, serviceStatus.haCalendars, serviceStatus.haTodos, serviceStatus.haSensors);
}

export async function renderPanels(root) {
  const [{ devices }, trainApi, busApi, trafficApi, { lists: todoLists }, { printers }, runtime, calendars, todos, sensors] = await Promise.all([
    getJson('/api/devices'), getJson('/api/national-rail'), getJson('/api/transportapi'),
    getJson('/api/google-maps'), getJson('/api/todo-lists'), getJson('/api/printers'),
    getJson('/api/runtime-config'),
    getJson('/api/home-assistant/calendars').catch(() => ({ available: false, calendars: [] })),
    getJson('/api/home-assistant/todo-lists').catch(() => ({ available: false, lists: [] })),
    getJson('/api/home-assistant/sensors').catch(() => ({ available: false, entities: [] })),
  ]);
  // Deployment capability is independent of discovery availability. A failed
  // runtime read surfaces as a page error instead of silently hiding providers.
  const supported = runtime.updateMode === 'home-assistant';
  const haCalendars = { ...calendars, supported };
  const haTodos = { ...todos, supported };
  if (supported) {
    const identity = await getJson('/api/home-assistant/current-user').catch(() => ({ available: false, user: null }));
    const [mappings, personal] = await Promise.all([
      getJson('/api/home-assistant/users').catch(() => ({ users: [] })),
      identity.available ? getJson('/api/home-assistant/my-todo-lists').catch(() => ({ lists: [] })) : Promise.resolve({ lists: [] }),
    ]);
    Object.assign(haTodos, { personalSupported: true, currentUser: identity.user, users: mappings.users, personalLists: personal.lists });
  }
  const haSensors = { ...sensors, supported };
  if (!devices.length) { root.innerHTML = '<div class="studio-card panel-empty-state"><h2>No panels yet</h2><p class="empty">Power one on and it will appear in the sidebar.</p></div>'; return; }
  if (!devices.some((d) => d.id === selectedId)) selectedId = devices[0].id;
  await renderDetail(root, devices.find((d) => d.id === selectedId), { trainApi, busApi, trafficApi, todoLists, printers, haCalendars, haTodos, haSensors });
}
