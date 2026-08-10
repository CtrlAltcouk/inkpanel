import { esc } from './components.js';
import { renderStationPicker } from './stationPicker.js';
import { renderBusStopPicker } from './busStopPicker.js';

const TYPES = ['calendar', 'weather', 'trains', 'bus', 'traffic', 'bins', 'empty'];
const POSITIONS = ['Top Left', 'Top Right', 'Bottom Left', 'Bottom Right'];
const stateByRoot = new WeakMap();

function defaultConfig(type) {
  if (type === 'calendar') return { calendarUrls: [] };
  if (type === 'trains') return { originCrs: '', destinationCrs: '' };
  if (type === 'bus') return { stopCode: '', stopLabel: '', routeFilter: '' };
  if (type === 'traffic') return { origin: '', destination: '' };
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
  } else if (type === 'bus') {
    const picker = cell.querySelector('[data-bus-stop]');
    slot.drafts[type] = {
      stopCode: picker?.dataset.stopCode ?? '',
      stopLabel: picker?.dataset.stopLabel ?? '',
      routeFilter: cell.querySelector('[data-bus-route-filter]')?.value.trim() ?? '',
    };
  } else if (type === 'traffic') {
    slot.drafts[type] = {
      origin: cell.querySelector('[data-traffic-origin]')?.value.trim() ?? '',
      destination: cell.querySelector('[data-traffic-destination]')?.value.trim() ?? '',
    };
  } else if (type === 'bins') {
    slot.drafts[type] = { uprn: cell.querySelector('[data-bins-uprn]').value.trim() };
  } else slot.drafts[type] = {};
}

function trainControlsHtml(trainApiConfigured, trainApiKeyDraft) {
  const placeholder = trainApiConfigured ? 'Configured — leave blank to keep' : 'Paste RDM Consumer key';
  const status = trainApiConfigured
    ? 'API key configured. Leave blank to keep it, or enter a new key to replace it.'
    : 'Required for live departures. This key is shared by every Trains section on this InkPanel server.';
  return `<label>National Rail API key</label><input type="password" data-train-api-key value="${esc(trainApiKeyDraft)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false"><p class="meta train-api-status">${esc(status)}</p><div class="station-picker" data-station="origin"></div><div class="station-picker" data-station="destination"></div>`;
}

function busControlsHtml(config, busApiConfigured, busAppIdDraft, busAppKeyDraft) {
  const status = busApiConfigured
    ? 'TransportAPI configured. Leave both fields blank to keep the saved credentials.'
    : 'TransportAPI app ID and app key are required for live UK bus departures.';
  return `<label>TransportAPI app ID</label><input type="password" data-bus-app-id value="${esc(busAppIdDraft)}" placeholder="${busApiConfigured ? 'Configured — leave blank to keep' : 'TransportAPI app ID'}" autocomplete="off" spellcheck="false"><label>TransportAPI app key</label><input type="password" data-bus-app-key value="${esc(busAppKeyDraft)}" placeholder="${busApiConfigured ? 'Configured — leave blank to keep' : 'TransportAPI app key'}" autocomplete="off" spellcheck="false"><p class="meta train-api-status">${esc(status)}</p><div class="station-picker" data-bus-stop></div><label>Route filter <span class="meta">(optional)</span></label><input type="text" data-bus-route-filter value="${esc(config.routeFilter ?? '')}" placeholder="e.g. 6 or X5" autocomplete="off" spellcheck="false"><p class="meta">Bus data source: TransportAPI. A free account is limited to 30 requests/day.</p>`;
}

function trafficControlsHtml(config, trafficApiConfigured, trafficApiKeyDraft) {
  const status = trafficApiConfigured
    ? 'Google Maps Routes API configured. Leave blank to keep the saved key.'
    : 'Enable the Google Maps Routes API with billing, then paste its API key here.';
  return `<label>Google Maps API key</label><input type="password" data-traffic-api-key value="${esc(trafficApiKeyDraft)}" placeholder="${trafficApiConfigured ? 'Configured — leave blank to keep' : 'Google Maps API key'}" autocomplete="off" spellcheck="false"><p class="meta train-api-status">${esc(status)}</p><label>From</label><input type="text" data-traffic-origin value="${esc(config.origin ?? '')}" placeholder="Home address or postcode" autocomplete="street-address"><label>To</label><input type="text" data-traffic-destination value="${esc(config.destination ?? '')}" placeholder="Work address or postcode" autocomplete="street-address"><p class="meta">Uses Google traffic-aware driving time. Google Maps attribution is shown on the panel.</p>`;
}

function controlsHtml(
  type,
  config,
  locationLabel,
  trainApiConfigured,
  trainApiKeyDraft,
  busApiConfigured,
  busAppIdDraft,
  busAppKeyDraft,
  trafficApiConfigured,
  trafficApiKeyDraft,
) {
  if (type === 'calendar') return `<label>Secret iCal URLs, one per line</label><textarea data-calendar-urls rows="3" placeholder="https://calendar.example/private.ics">${esc((config.calendarUrls ?? []).join('\n'))}</textarea>`;
  if (type === 'bins') return `<label>UPRN</label><input type="text" data-bins-uprn value="${esc(config.uprn ?? '')}" inputmode="numeric"><p class="meta">Milton Keynes only. Find your UPRN at <a href="https://www.findmyaddress.co.uk" target="_blank" rel="noreferrer">findmyaddress.co.uk</a>. Leave blank when not configured.</p>`;
  if (type === 'weather') return `<p class="meta">Uses panel location: ${esc(locationLabel || 'current panel location')}.</p>`;
  if (type === 'empty') return '<p class="meta">This dashboard section will be blank.</p>';
  if (type === 'trains') return trainControlsHtml(trainApiConfigured, trainApiKeyDraft);
  if (type === 'bus') return busControlsHtml(config, busApiConfigured, busAppIdDraft, busAppKeyDraft);
  return trafficControlsHtml(config, trafficApiConfigured, trafficApiKeyDraft);
}

export function dashboardCellHtml(
  deviceId,
  index,
  slot,
  locationLabel = '',
  trainApi = {},
  busApi = {},
  trafficApi = {},
) {
  const config = slot.drafts[slot.type] ?? defaultConfig(slot.type);
  return `<div class="dashboard-position">${POSITIONS[index]}</div><label for="widget-type-${esc(deviceId)}-${index}">Content</label><select id="widget-type-${esc(deviceId)}-${index}" data-widget-type>${TYPES.map((type) => `<option value="${type}" ${type === slot.type ? 'selected' : ''}>${type[0].toUpperCase()}${type.slice(1)}</option>`).join('')}</select><div data-widget-controls>${controlsHtml(slot.type, config, locationLabel, Boolean(trainApi.configured), trainApi.keyDraft ?? '', Boolean(busApi.configured), busApi.appIdDraft ?? '', busApi.appKeyDraft ?? '', Boolean(trafficApi.configured), trafficApi.keyDraft ?? '')}</div>`;
}

function syncInputs(root, selector, state, stateKey, value) {
  state[stateKey] = value;
  root.querySelectorAll(selector).forEach((input) => {
    if (input.value !== value) input.value = value;
  });
}

function renderCell(root, index) {
  const state = stateByRoot.get(root);
  const slot = state.slots[index];
  const cell = root.querySelector(`[data-dashboard-slot="${index}"]`);
  const config = slot.drafts[slot.type] ?? defaultConfig(slot.type);
  cell.innerHTML = dashboardCellHtml(
    state.deviceId,
    index,
    slot,
    state.locationLabel,
    { configured: state.trainApiConfigured, keyDraft: state.trainApiKeyDraft },
    { configured: state.busApiConfigured, appIdDraft: state.busAppIdDraft, appKeyDraft: state.busAppKeyDraft },
    { configured: state.trafficApiConfigured, keyDraft: state.trafficApiKeyDraft },
  );
  cell.querySelector('[data-widget-type]').addEventListener('change', (event) => {
    const previousType = slot.type;
    rememberCell(cell, slot, previousType);
    switchDashboardDraft(state.slots, index, event.target.value, slot.drafts[previousType]);
    renderCell(root, index);
  });
  if (slot.type === 'trains') {
    cell.querySelector('[data-train-api-key]').addEventListener('input', (event) => {
      syncInputs(root, '[data-train-api-key]', state, 'trainApiKeyDraft', event.currentTarget.value);
    });
    renderStationPicker(cell.querySelector('[data-station="origin"]'), stationPickerOptions(state.deviceId, index, 'origin', 'From', config.originCrs ?? ''));
    renderStationPicker(cell.querySelector('[data-station="destination"]'), stationPickerOptions(state.deviceId, index, 'destination', 'To', config.destinationCrs ?? ''));
  } else if (slot.type === 'bus') {
    cell.querySelector('[data-bus-app-id]').addEventListener('input', (event) => {
      syncInputs(root, '[data-bus-app-id]', state, 'busAppIdDraft', event.currentTarget.value);
    });
    cell.querySelector('[data-bus-app-key]').addEventListener('input', (event) => {
      syncInputs(root, '[data-bus-app-key]', state, 'busAppKeyDraft', event.currentTarget.value);
    });
    renderBusStopPicker(cell.querySelector('[data-bus-stop]'), {
      id: `${state.deviceId}-section-${index}`,
      stopCode: config.stopCode ?? '',
      stopLabel: config.stopLabel ?? '',
      searchEnabled: state.busApiConfigured,
    });
  } else if (slot.type === 'traffic') {
    cell.querySelector('[data-traffic-api-key]').addEventListener('input', (event) => {
      syncInputs(root, '[data-traffic-api-key]', state, 'trafficApiKeyDraft', event.currentTarget.value);
    });
  }
}

export function renderDashboardEditor(
  root,
  device,
  trainApi = { configured: false },
  busApi = { configured: false },
  trafficApi = { configured: false },
) {
  const slots = createDashboardDraftState(device.dashboardSections);
  stateByRoot.set(root, {
    deviceId: device.id,
    locationLabel: device.locationLabel,
    slots,
    trainApiConfigured: Boolean(trainApi.configured),
    trainApiKeyDraft: '',
    busApiConfigured: Boolean(busApi.configured),
    busAppIdDraft: '',
    busAppKeyDraft: '',
    trafficApiConfigured: Boolean(trafficApi.configured),
    trafficApiKeyDraft: '',
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

/** Returns only newly-entered secrets. Stored values are never readable in the browser. */
export function collectTrainApiKey(root) {
  const state = stateByRoot.get(root);
  if (!state) throw new Error('dashboard editor is not initialised');
  return state.trainApiKeyDraft.trim();
}

export function collectBusApiCredentials(root) {
  const state = stateByRoot.get(root);
  if (!state) throw new Error('dashboard editor is not initialised');
  const appId = state.busAppIdDraft.trim();
  const appKey = state.busAppKeyDraft.trim();
  if (!appId && !appKey) return null;
  if (!appId || !appKey) throw new Error('Enter both the TransportAPI app ID and app key, or leave both blank.');
  return { appId, appKey };
}

export function collectTrafficApiKey(root) {
  const state = stateByRoot.get(root);
  if (!state) throw new Error('dashboard editor is not initialised');
  return state.trafficApiKeyDraft.trim();
}
