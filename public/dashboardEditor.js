import { esc } from './components.js';
import { renderStationPicker } from './stationPicker.js';

const TYPES = ['calendar', 'weather', 'trains', 'bins', 'empty'];
const POSITIONS = ['Top Left', 'Top Right', 'Bottom Left', 'Bottom Right'];
const stateByRoot = new WeakMap();

function defaultConfig(type) {
  if (type === 'calendar') return { calendarUrls: [] };
  if (type === 'trains') return { originCrs: '', destinationCrs: '' };
  if (type === 'bins') return { uprn: '' };
  return {};
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createDashboardDraftState(sections) {
  return sections.map((widget) => ({ type: widget.type, drafts: { [widget.type]: clone(widget.config) } }));
}

export function switchDashboardDraft(slots, index, nextType, currentConfig) {
  const slot = slots[index];
  slot.drafts[slot.type] = clone(currentConfig);
  slot.type = nextType;
  slot.drafts[nextType] ??= defaultConfig(nextType);
}

export function serialiseDashboardDraftState(slots) {
  return slots.map((slot) => ({ type: slot.type, version: 1, config: clone(slot.drafts[slot.type]) }));
}

export function stationPickerOptions(deviceId, sectionIndex, endpoint, label, value) {
  return { id: `${deviceId}-section-${sectionIndex}`, field: endpoint, label, value };
}

function rememberCell(cell, slot, type = slot.type) {
  if (type === 'calendar') {
    slot.drafts[type] = {
      calendarUrls: cell.querySelector('[data-calendar-urls]').value
        .split('\n').map((value) => value.trim()).filter(Boolean),
    };
  } else if (type === 'trains') {
    slot.drafts[type] = {
      originCrs: cell.querySelector('[data-station="origin"]')?.dataset.crs ?? '',
      destinationCrs: cell.querySelector('[data-station="destination"]')?.dataset.crs ?? '',
    };
  } else if (type === 'bins') {
    slot.drafts[type] = { uprn: cell.querySelector('[data-bins-uprn]').value.trim() };
  } else slot.drafts[type] = {};
}

function trainControlsHtml(config, trainApiConfigured, trainApiKeyDraft) {
  const placeholder = trainApiConfigured ? 'Configured — leave blank to keep' : 'Paste RDM Consumer key';
  const status = trainApiConfigured
    ? 'API key configured. Leave blank to keep it, or enter a new key to replace it.'
    : 'Required for live departures. This key is shared by every Trains section on this InkPanel server.';
  return `<label>National Rail API key</label><input type="password" data-train-api-key value="${esc(trainApiKeyDraft)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false"><p class="meta train-api-status">${esc(status)}</p><div class="station-picker" data-station="origin"></div><div class="station-picker" data-station="destination"></div>`;
}

function controlsHtml(type, config, locationLabel, trainApiConfigured, trainApiKeyDraft) {
  if (type === 'calendar') return `<label>Secret iCal URLs, one per line</label><textarea data-calendar-urls rows="3" placeholder="https://calendar.example/private.ics">${esc((config.calendarUrls ?? []).join('\n'))}</textarea>`;
  if (type === 'bins') return `<label>UPRN</label><input type="text" data-bins-uprn value="${esc(config.uprn ?? '')}" inputmode="numeric"><p class="meta">Milton Keynes only. Find your UPRN at <a href="https://www.findmyaddress.co.uk" target="_blank" rel="noreferrer">findmyaddress.co.uk</a>. Leave blank when not configured.</p>`;
  if (type === 'weather') return `<p class="meta">Uses panel location: ${esc(locationLabel || 'current panel location')}.</p>`;
  if (type === 'empty') return '<p class="meta">This dashboard section will be blank.</p>';
  return trainControlsHtml(config, trainApiConfigured, trainApiKeyDraft);
}

export function dashboardCellHtml(deviceId, index, slot, locationLabel = '', trainApi = {}) {
  const config = slot.drafts[slot.type] ?? defaultConfig(slot.type);
  return `<div class="dashboard-position">${POSITIONS[index]}</div><label for="widget-type-${esc(deviceId)}-${index}">Content</label><select id="widget-type-${esc(deviceId)}-${index}" data-widget-type>${TYPES.map((type) => `<option value="${type}" ${type === slot.type ? 'selected' : ''}>${type[0].toUpperCase()}${type.slice(1)}</option>`).join('')}</select><div data-widget-controls>${controlsHtml(slot.type, config, locationLabel, Boolean(trainApi.configured), trainApi.keyDraft ?? '')}</div>`;
}

function syncTrainApiKeyInputs(root, state, value) {
  state.trainApiKeyDraft = value;
  root.querySelectorAll('[data-train-api-key]').forEach((input) => {
    if (input.value !== value) input.value = value;
  });
}

function renderCell(root, index) {
  const state = stateByRoot.get(root);
  const slot = state.slots[index];
  const cell = root.querySelector(`[data-dashboard-slot="${index}"]`);
  const config = slot.drafts[slot.type] ?? defaultConfig(slot.type);
  cell.innerHTML = dashboardCellHtml(state.deviceId, index, slot, state.locationLabel, {
    configured: state.trainApiConfigured,
    keyDraft: state.trainApiKeyDraft,
  });
  cell.querySelector('[data-widget-type]').addEventListener('change', (event) => {
    const previousType = slot.type;
    rememberCell(cell, slot, previousType);
    switchDashboardDraft(state.slots, index, event.target.value, slot.drafts[previousType]);
    renderCell(root, index);
  });
  if (slot.type === 'trains') {
    cell.querySelector('[data-train-api-key]').addEventListener('input', (event) => {
      syncTrainApiKeyInputs(root, state, event.currentTarget.value);
    });
    renderStationPicker(cell.querySelector('[data-station="origin"]'), stationPickerOptions(state.deviceId, index, 'origin', 'From', config.originCrs ?? ''));
    renderStationPicker(cell.querySelector('[data-station="destination"]'), stationPickerOptions(state.deviceId, index, 'destination', 'To', config.destinationCrs ?? ''));
  }
}

export function renderDashboardEditor(root, device, trainApi = { configured: false }) {
  const slots = createDashboardDraftState(device.dashboardSections);
  stateByRoot.set(root, {
    deviceId: device.id,
    locationLabel: device.locationLabel,
    slots,
    trainApiConfigured: Boolean(trainApi.configured),
    trainApiKeyDraft: '',
  });
  root.innerHTML = slots.map((_slot, index) => `<div class="dashboard-editor-cell" data-dashboard-slot="${index}"></div>`).join('');
  slots.forEach((_slot, index) => renderCell(root, index));
}

export function collectDashboardSections(root) {
  const state = stateByRoot.get(root);
  if (!state) throw new Error('dashboard editor is not initialised');
  state.slots.forEach((slot, index) => rememberCell(root.querySelector(`[data-dashboard-slot="${index}"]`), slot));
  return serialiseDashboardDraftState(state.slots);
}

/** Returns only a newly-entered key. Stored keys are deliberately never readable in the browser. */
export function collectTrainApiKey(root) {
  const state = stateByRoot.get(root);
  if (!state) throw new Error('dashboard editor is not initialised');
  return state.trainApiKeyDraft.trim();
}
