import { esc } from './components.js';
import { renderStationPicker } from './stationPicker.js';
import { renderBusStopPicker } from './busStopPicker.js';

const TYPES = ['calendar', 'weather', 'trains', 'bus', 'traffic', 'octopus', 'bins', 'empty'];
const POSITIONS = ['Top Left', 'Top Right', 'Bottom Left', 'Bottom Right'];
const stateByRoot = new WeakMap();

function typeLabel(type) {
  if (type === 'octopus') return 'Octopus Agile';
  return `${type[0].toUpperCase()}${type.slice(1)}`;
}

function defaultConfig(type) {
  if (type === 'calendar') return { calendarUrls: [] };
  if (type === 'trains') return { originCrs: '', destinationCrs: '' };
  if (type === 'bus') return { stopCode: '', stopLabel: '', routeFilter: '' };
  if (type === 'traffic') return { origin: '', destination: '' };
  if (type === 'octopus') return { tariffCode: '' };
  if (type === 'bins') return { uprn: '' };
  return {};
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function widgetsByType(widgets = []) { return Object.fromEntries(widgets.map((widget) => [widget.type, clone(widget.config)])); }

export function createDashboardDraftState(sections, remembered = {}) {
  const shared = widgetsByType(remembered.shared ?? []);
  const rememberedSlots = remembered.slots ?? [[], [], [], []];
  return sections.map((widget, index) => ({
    type: widget.type,
    drafts: { ...clone(shared), ...widgetsByType(rememberedSlots[index] ?? []), [widget.type]: clone(widget.config) },
  }));
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
  if (!cell) return;
  if (type === 'calendar') {
    slot.drafts[type] = { calendarUrls: cell.querySelector('[data-calendar-urls]').value.split('\n').map((v) => v.trim()).filter(Boolean) };
  } else if (type === 'trains') {
    slot.drafts[type] = {
      originCrs: cell.querySelector('[data-station="origin"]')?.dataset.crs ?? '',
      destinationCrs: cell.querySelector('[data-station="destination"]')?.dataset.crs ?? '',
    };
  } else if (type === 'bus') {
    const picker = cell.querySelector('[data-bus-stop]');
    slot.drafts[type] = {
      stopCode: picker?.dataset.stopCode ?? '', stopLabel: picker?.dataset.stopLabel ?? '',
      routeFilter: cell.querySelector('[data-bus-route-filter]')?.value.trim() ?? '',
    };
  } else if (type === 'traffic') {
    slot.drafts[type] = {
      origin: cell.querySelector('[data-traffic-origin]')?.value.trim() ?? '',
      destination: cell.querySelector('[data-traffic-destination]')?.value.trim() ?? '',
    };
  } else if (type === 'octopus') {
    slot.drafts[type] = { tariffCode: cell.querySelector('[data-octopus-tariff]')?.value.trim().toUpperCase() ?? '' };
  } else if (type === 'bins') {
    slot.drafts[type] = { uprn: cell.querySelector('[data-bins-uprn]').value.trim() };
  } else slot.drafts[type] = {};
}

function trainControlsHtml(trainApiConfigured, trainApiKeyDraft) {
  const placeholder = trainApiConfigured ? 'Configured — leave blank to keep' : 'Paste RDM Consumer key';
  const status = trainApiConfigured ? 'API key configured. Leave blank to keep it, or enter a new key to replace it.' : 'Required for live departures. This key is shared by every Trains section on this InkPanel server.';
  return `<label>National Rail API key</label><input type="password" data-train-api-key value="${esc(trainApiKeyDraft)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false"><p class="meta train-api-status">${esc(status)} Get a Consumer key from <a href="https://raildata.org.uk/" target="_blank" rel="noreferrer">Rail Data Marketplace</a>.</p><div class="station-picker" data-station="origin"></div><div class="station-picker" data-station="destination"></div>`;
}
function busControlsHtml(config, configured, appId, appKey) {
  const status = configured ? 'TransportAPI configured. Leave both fields blank to keep the saved credentials.' : 'TransportAPI app ID and app key are required for live UK bus departures.';
  return `<label>TransportAPI app ID</label><input type="password" data-bus-app-id value="${esc(appId)}" placeholder="${configured ? 'Configured — leave blank to keep' : 'TransportAPI app ID'}" autocomplete="off" spellcheck="false"><label>TransportAPI app key</label><input type="password" data-bus-app-key value="${esc(appKey)}" placeholder="${configured ? 'Configured — leave blank to keep' : 'TransportAPI app key'}" autocomplete="off" spellcheck="false"><p class="meta train-api-status">${esc(status)} <a href="https://developer.transportapi.com/" target="_blank" rel="noreferrer">Create or view TransportAPI credentials</a>.</p><div class="station-picker" data-bus-stop></div><label>Route filter <span class="meta">(optional)</span></label><input type="text" data-bus-route-filter value="${esc(config.routeFilter ?? '')}" placeholder="e.g. 6 or X5" autocomplete="off" spellcheck="false"><p class="meta">Bus data source: TransportAPI. A free account is limited to 30 requests/day.</p>`;
}
function trafficControlsHtml(config, configured, key) {
  const status = configured ? 'Google Maps Routes API configured. Leave blank to keep the saved key.' : 'Enable the Google Maps Routes API with billing, then paste its API key here.';
  return `<label>Google Maps API key</label><input type="password" data-traffic-api-key value="${esc(key)}" placeholder="${configured ? 'Configured — leave blank to keep' : 'Google Maps API key'}" autocomplete="off" spellcheck="false"><p class="meta train-api-status">${esc(status)} <a href="https://developers.google.com/maps/documentation/routes/get-api-key" target="_blank" rel="noreferrer">Set up Routes API and create a key</a>.</p><label>From</label><input type="text" data-traffic-origin value="${esc(config.origin ?? '')}" placeholder="Home address or postcode"><label>To</label><input type="text" data-traffic-destination value="${esc(config.destination ?? '')}" placeholder="Work address or postcode"><p class="meta">Uses Google traffic-aware driving time. Google Maps attribution is shown on the panel.</p>`;
}
function controlsHtml(type, config, locationLabel, trainConfigured, trainKey, busConfigured, busId, busKey, trafficConfigured, trafficKey) {
  if (type === 'calendar') return `<label>Secret iCal URLs, one per line</label><textarea data-calendar-urls rows="3" placeholder="https://calendar.example/private.ics">${esc((config.calendarUrls ?? []).join('\n'))}</textarea><p class="meta">For Google Calendar, <a href="https://support.google.com/calendar/answer/37648?hl=en-GB" target="_blank" rel="noreferrer">find your Secret address in iCal format</a>. Treat that URL like a password.</p>`;
  if (type === 'bins') return `<label>UPRN</label><input type="text" data-bins-uprn value="${esc(config.uprn ?? '')}" inputmode="numeric"><p class="meta">Milton Keynes only. Find your UPRN at <a href="https://www.findmyaddress.co.uk" target="_blank" rel="noreferrer">findmyaddress.co.uk</a>.</p>`;
  if (type === 'weather') return `<p class="meta">Uses panel location: ${esc(locationLabel || 'current panel location')}.</p>`;
  if (type === 'empty') return '<p class="meta">This dashboard section will be blank.</p>';
  if (type === 'trains') return trainControlsHtml(trainConfigured, trainKey);
  if (type === 'bus') return busControlsHtml(config, busConfigured, busId, busKey);
  if (type === 'traffic') return trafficControlsHtml(config, trafficConfigured, trafficKey);
  return `<label>Octopus Agile tariff code</label><input type="text" data-octopus-tariff value="${esc(config.tariffCode ?? '')}" placeholder="E-1R-AGILE-24-10-01-C"><p class="meta">Paste the full electricity tariff code from Octopus. No Octopus API key is required for public Agile prices. <a href="https://developer.octopus.energy/guides/rest/api-endpoints/" target="_blank" rel="noreferrer">See Octopus tariff/API details</a>.</p>`;
}

export function dashboardCellHtml(deviceId, index, slot, locationLabel = '', trainApi = {}, busApi = {}, trafficApi = {}) {
  const config = slot.drafts[slot.type] ?? defaultConfig(slot.type);
  return `<div class="dashboard-position">${POSITIONS[index]}</div><h3 class="dashboard-config-title">${typeLabel(slot.type)}</h3><label for="widget-type-${esc(deviceId)}-${index}">Content</label><select id="widget-type-${esc(deviceId)}-${index}" data-widget-type>${TYPES.map((type) => `<option value="${type}" ${type === slot.type ? 'selected' : ''}>${typeLabel(type)}</option>`).join('')}</select><div data-widget-controls>${controlsHtml(slot.type, config, locationLabel, Boolean(trainApi.configured), trainApi.keyDraft ?? '', Boolean(busApi.configured), busApi.appIdDraft ?? '', busApi.appKeyDraft ?? '', Boolean(trafficApi.configured), trafficApi.keyDraft ?? '')}</div>`;
}

function summary(type, config, locationLabel) {
  if (type === 'calendar') return config.calendarUrls?.length ? `${config.calendarUrls.length} calendar${config.calendarUrls.length === 1 ? '' : 's'} connected` : 'Not set up';
  if (type === 'weather') return locationLabel || 'Uses panel location';
  if (type === 'trains') return config.originCrs && config.destinationCrs ? `${config.originCrs} → ${config.destinationCrs}` : 'Not set up';
  if (type === 'bus') return config.stopLabel || config.stopCode || 'Not set up';
  if (type === 'traffic') return config.origin && config.destination ? `${config.origin} → ${config.destination}` : 'Not set up';
  if (type === 'octopus') return config.tariffCode || 'Not set up';
  if (type === 'bins') return config.uprn ? `UPRN ${config.uprn}` : 'Not set up';
  return 'Blank section';
}

function currentPanel(root) { return root.querySelector('[data-dashboard-config-panel]'); }
function syncCurrent(root, state) { rememberCell(currentPanel(root), state.slots[state.selectedIndex]); }

function renderLayout(root) {
  const state = stateByRoot.get(root);
  const map = root.querySelector('[data-dashboard-layout-map]');
  map.innerHTML = state.slots.map((slot, index) => {
    const config = slot.drafts[slot.type] ?? defaultConfig(slot.type);
    return `<button type="button" class="dashboard-slot-summary ${index === state.selectedIndex ? 'on' : ''}" data-dashboard-select="${index}"><span class="dashboard-slot-summary__dot ${slot.type === 'empty' ? 'dashboard-slot-summary__dot--empty' : ''}"></span><span class="dashboard-slot-summary__position">${POSITIONS[index]}</span><span class="dashboard-slot-summary__type">${typeLabel(slot.type)}</span><span class="dashboard-slot-summary__detail">${esc(summary(slot.type, config, state.locationLabel))}</span></button>`;
  }).join('');
  map.querySelectorAll('[data-dashboard-select]').forEach((button) => button.addEventListener('click', () => {
    syncCurrent(root, state);
    state.selectedIndex = Number(button.dataset.dashboardSelect);
    renderLayout(root);
    renderEditor(root);
  }));
}

function renderEditor(root) {
  const state = stateByRoot.get(root);
  const index = state.selectedIndex;
  const slot = state.slots[index];
  const panel = currentPanel(root);
  const config = slot.drafts[slot.type] ?? defaultConfig(slot.type);
  panel.innerHTML = dashboardCellHtml(state.deviceId, index, slot, state.locationLabel,
    { configured: state.trainApiConfigured, keyDraft: state.trainApiKeyDraft },
    { configured: state.busApiConfigured, appIdDraft: state.busAppIdDraft, appKeyDraft: state.busAppKeyDraft },
    { configured: state.trafficApiConfigured, keyDraft: state.trafficApiKeyDraft });

  panel.querySelector('[data-widget-type]').addEventListener('change', (event) => {
    const previous = slot.type;
    rememberCell(panel, slot, previous);
    switchDashboardDraft(state.slots, index, event.target.value, slot.drafts[previous]);
    renderLayout(root); renderEditor(root);
  });
  if (slot.type === 'trains') {
    panel.querySelector('[data-train-api-key]').addEventListener('input', (e) => { state.trainApiKeyDraft = e.currentTarget.value; });
    renderStationPicker(panel.querySelector('[data-station="origin"]'), stationPickerOptions(state.deviceId, index, 'origin', 'From', config.originCrs ?? ''));
    renderStationPicker(panel.querySelector('[data-station="destination"]'), stationPickerOptions(state.deviceId, index, 'destination', 'To', config.destinationCrs ?? ''));
  } else if (slot.type === 'bus') {
    panel.querySelector('[data-bus-app-id]').addEventListener('input', (e) => { state.busAppIdDraft = e.currentTarget.value; });
    panel.querySelector('[data-bus-app-key]').addEventListener('input', (e) => { state.busAppKeyDraft = e.currentTarget.value; });
    renderBusStopPicker(panel.querySelector('[data-bus-stop]'), { id: `${state.deviceId}-section-${index}`, stopCode: config.stopCode ?? '', stopLabel: config.stopLabel ?? '', searchEnabled: state.busApiConfigured });
  } else if (slot.type === 'traffic') {
    panel.querySelector('[data-traffic-api-key]').addEventListener('input', (e) => { state.trafficApiKeyDraft = e.currentTarget.value; });
  }
}

export function renderDashboardEditor(root, device, trainApi = { configured: false }, busApi = { configured: false }, trafficApi = { configured: false }, remembered = { shared: [], slots: [[], [], [], []] }) {
  const slots = createDashboardDraftState(device.dashboardSections, remembered);
  stateByRoot.set(root, { deviceId: device.id, locationLabel: device.locationLabel, slots, selectedIndex: 0, trainApiConfigured: Boolean(trainApi.configured), trainApiKeyDraft: '', busApiConfigured: Boolean(busApi.configured), busAppIdDraft: '', busAppKeyDraft: '', trafficApiConfigured: Boolean(trafficApi.configured), trafficApiKeyDraft: '' });
  root.innerHTML = '<div class="dashboard-composer"><div class="dashboard-layout-map" data-dashboard-layout-map></div><div class="dashboard-config-panel" data-dashboard-config-panel></div></div>';
  renderLayout(root); renderEditor(root);
}

export function collectDashboardSections(root) {
  const state = stateByRoot.get(root);
  if (!state) throw new Error('dashboard editor is not initialised');
  syncCurrent(root, state);
  return serialiseDashboardDraftState(state.slots);
}

export function collectRememberedDashboardSettings(root) {
  const state = stateByRoot.get(root);
  if (!state) throw new Error('dashboard editor is not initialised');
  syncCurrent(root, state);
  return { slots: state.slots.map((slot) => Object.entries(slot.drafts).map(([type, config]) => ({ type, version: 1, config: clone(config) }))) };
}

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
