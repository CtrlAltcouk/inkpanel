import { esc } from './components.js';
import { renderStationPicker } from './stationPicker.js';
import { renderBusStopPicker } from './busStopPicker.js';
import { getJson, sendJson } from './api.js';
import { calendarControlsHtml, rememberCalendarConfig, switchCalendarProvider } from './calendarEditor.js';
import { todoProviderHtml, homeAssistantTodoControlsHtml, rememberTodoConfig, switchTodoProvider } from './todoEditor.js';
import { providerDraftState, rememberedProviderDrafts } from './providerDrafts.js';
import { entitiesControlsHtml, bindEntitiesEditor } from './entitiesEditor.js';

const TYPES = ['calendar', 'weather', 'trains', 'bus', 'traffic', 'octopus', 'printers', 'todo', 'bins', 'empty', 'entities'];
const POSITIONS = ['Top Left', 'Top Right', 'Bottom Left', 'Bottom Right'];
const MINI_PROFILE = 'ssd1681-200x200-mono';
const stateByRoot = new WeakMap();

function typeLabel(type) {
  if (type === 'entities') return 'Home Assistant Sensors';
  if (type === 'octopus') return 'Octopus Agile';
  if (type === 'todo') return 'To Do';
  if (type === 'printers') return '3D Printers';
  return `${type[0].toUpperCase()}${type.slice(1)}`;
}

function defaultConfig(type) {
  if (type === 'entities') return { entityIds: [] };
  if (type === 'calendar') return { calendarUrls: [] };
  if (type === 'trains') return { originCrs: '', destinationCrs: '' };
  if (type === 'bus') return { stopCode: '', stopLabel: '', routeFilter: '' };
  if (type === 'traffic') return { origin: '', destination: '' };
  if (type === 'octopus') return { tariffCode: '' };
  if (type === 'todo') return { listId: '' };
  if (type === 'printers') return { printerIds: [] };
  if (type === 'bins') return { uprn: '' };
  return {};
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function widgetsByType(widgets = []) { return Object.fromEntries([...widgets].reverse().map((widget) => [widget.type, clone(widget.config)])); }
function versionsByType(widgets = []) { return Object.fromEntries([...widgets].reverse().map((widget) => [widget.type, widget.version])); }

export function normalizePrinterUrlValue(value) {
  const trimmed = value.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed)) return trimmed;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  const schemeSuffix = scheme ? trimmed.slice(scheme[0].length) : '';
  return scheme && !/^\d+(?:$|[/?#])/.test(schemeSuffix) ? trimmed : `http://${trimmed}`;
}

export function createDashboardDraftState(sections, remembered = {}) {
  // Apply identical precedence to config and version. Controls edit config;
  // generic serializers retain the version belonging to that draft.
  const shared = widgetsByType(remembered.shared ?? []);
  const rememberedSlots = remembered.slots ?? [[], [], [], []];
  return sections.map((widget, index) => ({
    type: widget.type,
    drafts: { ...clone(shared), ...widgetsByType(rememberedSlots[index] ?? []), [widget.type]: clone(widget.config) },
    versions: { ...versionsByType(remembered.shared), ...versionsByType(rememberedSlots[index]), [widget.type]: widget.version },
    providerDrafts: providerDraftState([...(remembered.shared ?? []), ...(rememberedSlots[index] ?? []), widget]),
  }));
}

export function switchDashboardDraft(slots, index, nextType, currentConfig) {
  const slot = slots[index];
  slot.drafts[slot.type] = clone(currentConfig);
  slot.type = nextType;
  slot.drafts[nextType] ??= defaultConfig(nextType);
  slot.versions[nextType] ??= 1;
}

export function serialiseDashboardDraftState(slots) {
  return slots.map((slot) => ({ type: slot.type, version: slot.versions[slot.type], config: clone(slot.drafts[slot.type]) }));
}

export function stationPickerOptions(deviceId, sectionIndex, endpoint, label, value) {
  return { id: `${deviceId}-section-${sectionIndex}`, field: endpoint, label, value };
}

function rememberCell(cell, slot, type = slot.type) {
  if (!cell) return;
  if (type === 'calendar') {
    slot.drafts[type] = rememberCalendarConfig(cell, slot);
  } else if (type === 'entities') {
    slot.drafts[type] = { entityIds: [...cell.querySelectorAll('[data-selected-entity]')].map((item) => item.dataset.selectedEntity) };
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
  } else if (type === 'todo') {
    slot.drafts[type] = rememberTodoConfig(cell, slot);
  } else if (type === 'printers') {
    const mini = cell.querySelector('[data-printer-single]');
    slot.drafts[type] = {
      printerIds: mini
        ? (mini.value ? [mini.value] : [])
        : [...cell.querySelectorAll('[data-printer-select]:checked')]
          .sort((a, b) => Number(a.dataset.printerPosition) - Number(b.dataset.printerPosition))
          .map((input) => input.value),
    };
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
function todoControlsHtml(config, lists) {
  const selected = lists.find((list) => list.id === config.listId) ?? null;
  const options = lists.map((list) => `<option value="${esc(list.id)}" ${list.id === config.listId ? 'selected' : ''}>${esc(list.name)}</option>`).join('');
  const tasks = selected?.items.map((item, index) => `<div class="todo-editor-row ${item.completed ? 'todo-editor-row--done' : ''}" data-todo-item="${esc(item.id)}">
    <input type="checkbox" data-todo-completed ${item.completed ? 'checked' : ''} aria-label="Mark ${esc(item.text)} complete">
    <input type="text" data-todo-text value="${esc(item.text)}" maxlength="200" aria-label="Task text">
    <button type="button" class="ghost todo-editor-move" data-todo-move="-1" ${index === 0 ? 'disabled' : ''} aria-label="Move task up">↑</button>
    <button type="button" class="ghost todo-editor-move" data-todo-move="1" ${index === selected.items.length - 1 ? 'disabled' : ''} aria-label="Move task down">↓</button>
    <button type="button" class="ghost todo-editor-delete" data-todo-delete-item aria-label="Delete task">×</button>
  </div>`).join('') ?? '';
  const selectedControls = selected ? `<div class="todo-editor-toolbar"><input type="text" data-todo-rename value="${esc(selected.name)}" maxlength="64" aria-label="List name"><button type="button" class="ghost" data-todo-rename-button>Rename</button><button type="button" class="ghost" data-todo-delete-list>Delete list</button></div>
    <div class="todo-editor-items">${tasks || '<p class="meta">No tasks yet — the panel will show ALL DONE.</p>'}</div>
    <div class="todo-editor-add"><input type="text" data-todo-new-task maxlength="200" placeholder="Add a task"><button type="button" data-todo-add>Add task</button></div>` : '<p class="meta">Choose or create a list to configure this widget.</p>';
  return `<label>To Do list</label><select data-todo-list><option value="">Choose a list</option>${options}</select>
    <div class="todo-editor-create"><input type="text" data-todo-new-list maxlength="64" placeholder="New list name"><button type="button" class="ghost" data-todo-create>Create list</button></div>
    ${selectedControls}<p class="error" data-todo-error hidden></p>`;
}
function printerConnectionHtml(printer) {
  return `<div class="printer-connection" data-printer-connection="${esc(printer.id)}">
    <div class="printer-connection-title"><strong>${esc(printer.name)}</strong><span>${esc(printer.baseUrl)}</span><small>${printer.apiKeyConfigured ? 'API key configured' : 'No API key'}</small></div>
    <div class="printer-connection-edit" data-printer-connection-edit hidden>
      <input type="text" data-printer-edit-name value="${esc(printer.name)}" maxlength="64" aria-label="Printer name">
      <input type="url" data-printer-edit-url value="${esc(printer.baseUrl)}" aria-label="Moonraker URL">
      <input type="password" data-printer-edit-key value="" maxlength="512" placeholder="${printer.apiKeyConfigured ? 'Leave blank to preserve API key' : 'Optional API key'}" autocomplete="new-password" aria-label="Moonraker API key">
      ${printer.apiKeyConfigured ? '<label class="checkbox"><input type="checkbox" data-printer-clear-key> Clear saved API key</label>' : ''}
      <button type="button" data-printer-save>Save connection</button>
    </div>
    <div class="printer-connection-actions"><button type="button" class="ghost" data-printer-test>Test</button><button type="button" class="ghost" data-printer-edit>Edit</button><button type="button" class="ghost" data-printer-delete>Delete</button></div>
    <p class="meta" data-printer-test-result hidden></p>
  </div>`;
}

function printerControlsHtml(config, printers, isMini) {
  const selected = config.printerIds ?? [];
  const selection = isMini
    ? `<label>Printer</label><select data-printer-single><option value="">Choose a printer</option>${printers.map((printer) => `<option value="${esc(printer.id)}" ${selected[0] === printer.id ? 'selected' : ''}>${esc(printer.name)}</option>`).join('')}</select><p class="meta" data-printer-assignment-help>InkPanel Mini displays one printer. Setup: add and save a connection below, test it, select it in the Printer dropdown, then click Save changes. The selected printer is what this Mini will display.</p>`
    : `<label>Printers shown</label><div class="printer-selection">${printers.map((printer) => {
        const index = selected.indexOf(printer.id);
        return `<div class="printer-selection-row"><label class="checkbox"><input type="checkbox" data-printer-select data-printer-position="${index >= 0 ? index : 999}" value="${esc(printer.id)}" ${index >= 0 ? 'checked' : ''}> ${esc(printer.name)}</label>${index >= 0 ? `<span><button type="button" class="ghost" data-printer-order="-1" data-printer-id="${esc(printer.id)}" ${index === 0 ? 'disabled' : ''}>&uarr;</button><button type="button" class="ghost" data-printer-order="1" data-printer-id="${esc(printer.id)}" ${index === selected.length - 1 ? 'disabled' : ''}>&darr;</button></span>` : ''}</div>`;
      }).join('') || '<p class="meta">Add a printer connection below.</p>'}</div><p class="meta" data-printer-assignment-help>Select up to four printers. Setup: add and save connections below, test them, select the printers here, then click Save changes. The selected printers are what this panel will display; their order controls the overview.</p>`;
  return `${selection}<div class="printer-management"><h4>Configured printers</h4>${printers.map(printerConnectionHtml).join('') || '<p class="meta">No printer connections yet.</p>'}
    <div class="printer-connection-create"><input type="text" data-printer-new-name maxlength="64" placeholder="Printer name"><input type="url" data-printer-new-url placeholder="http://192.168.1.50"><input type="password" data-printer-new-key maxlength="512" placeholder="Optional API key" autocomplete="new-password"><button type="button" data-printer-create>Add printer</button></div>
    <p class="error" data-printer-error hidden></p></div>`;
}

function controlsHtml(type, config, locationLabel, trainConfigured, trainKey, busConfigured, busId, busKey, trafficConfigured, trafficKey, todoLists, printers, isMini, haCalendars, haTodos, haSensors) {
  if (type === 'entities') return entitiesControlsHtml(haSensors);
  if (type === 'calendar') return calendarControlsHtml(config, haCalendars);
  if (type === 'bins') return `<label>UPRN</label><input type="text" data-bins-uprn value="${esc(config.uprn ?? '')}" inputmode="numeric"><p class="meta">Milton Keynes only. Find your UPRN at <a href="https://www.findmyaddress.co.uk" target="_blank" rel="noreferrer">findmyaddress.co.uk</a>.</p>`;
  if (type === 'weather') return `<p class="meta">Uses panel location: ${esc(locationLabel || 'current panel location')}.</p>`;
  if (type === 'empty') return '<p class="meta">This dashboard section will be blank.</p>';
  if (type === 'trains') return trainControlsHtml(trainConfigured, trainKey);
  if (type === 'bus') return busControlsHtml(config, busConfigured, busId, busKey);
  if (type === 'traffic') return trafficControlsHtml(config, trafficConfigured, trafficKey);
  if (type === 'todo') return todoProviderHtml(config, haTodos) + (config.provider === 'home-assistant'
    ? homeAssistantTodoControlsHtml(config, haTodos) : todoControlsHtml(config, todoLists));
  if (type === 'printers') return printerControlsHtml(config, printers, isMini);
  return `<label>Octopus Agile tariff code</label><input type="text" data-octopus-tariff value="${esc(config.tariffCode ?? '')}" placeholder="E-1R-AGILE-24-10-01-C"><p class="meta">Paste the full electricity tariff code from Octopus. No Octopus API key is required for public Agile prices. <a href="https://developer.octopus.energy/guides/rest/api-endpoints/" target="_blank" rel="noreferrer">See Octopus tariff/API details</a>.</p>`;
}

export function dashboardCellHtml(deviceId, index, slot, locationLabel = '', trainApi = {}, busApi = {}, trafficApi = {}, positionLabel = POSITIONS[index], todoLists = [], printers = [], isMini = false, haCalendars = {}, haTodos = {}, haSensors = {}) {
  const config = slot.drafts[slot.type] ?? defaultConfig(slot.type);
  const types = TYPES.filter((type) => type !== 'entities' || haSensors.supported || slot.type === 'entities');
  return `<div class="dashboard-position">${esc(positionLabel)}</div><h3 class="dashboard-config-title">${typeLabel(slot.type)}</h3><label for="widget-type-${esc(deviceId)}-${index}">Content</label><select id="widget-type-${esc(deviceId)}-${index}" data-widget-type>${types.map((type) => `<option value="${type}" ${type === slot.type ? 'selected' : ''}>${typeLabel(type)}</option>`).join('')}</select><div data-widget-controls>${controlsHtml(slot.type, config, locationLabel, Boolean(trainApi.configured), trainApi.keyDraft ?? '', Boolean(busApi.configured), busApi.appIdDraft ?? '', busApi.appKeyDraft ?? '', Boolean(trafficApi.configured), trafficApi.keyDraft ?? '', todoLists, printers, isMini, haCalendars, haTodos, haSensors)}</div>`;
}

function summary(type, config, locationLabel, todoLists = []) {
  if (type === 'entities') return config.entityIds.length ? `${config.entityIds.length} sensor${config.entityIds.length === 1 ? '' : 's'}` : 'Not set up';
  if (type === 'calendar') { const count = (config.entityIds ?? config.calendarUrls ?? []).length; return count ? `${count} calendar${count === 1 ? '' : 's'} connected` : 'Not set up'; }
  if (type === 'weather') return locationLabel || 'Uses panel location';
  if (type === 'trains') return config.originCrs && config.destinationCrs ? `${config.originCrs} → ${config.destinationCrs}` : 'Not set up';
  if (type === 'bus') return config.stopLabel || config.stopCode || 'Not set up';
  if (type === 'traffic') return config.origin && config.destination ? `${config.origin} → ${config.destination}` : 'Not set up';
  if (type === 'octopus') return config.tariffCode || 'Not set up';
  if (type === 'todo') return config.provider === 'home-assistant'
    ? config.entityId || 'Not set up' : todoLists.find((list) => list.id === config.listId)?.name || 'Not set up';
  if (type === 'printers') return config.printerIds?.length ? `${config.printerIds.length} printer${config.printerIds.length === 1 ? '' : 's'}` : 'Not set up';
  if (type === 'bins') return config.uprn ? `UPRN ${config.uprn}` : 'Not set up';
  return 'Blank section';
}

function currentPanel(root) { return root.querySelector('[data-dashboard-config-panel]'); }
function syncCurrent(root, state) { rememberCell(currentPanel(root), state.slots[state.selectedIndex]); }
function slotPosition(state, index) { return state.isMini ? 'Display content' : POSITIONS[index]; }

function renderLayout(root) {
  const state = stateByRoot.get(root);
  const map = root.querySelector('[data-dashboard-layout-map]');
  map.innerHTML = state.slots.map((slot, index) => {
    const config = slot.drafts[slot.type] ?? defaultConfig(slot.type);
    return `<button type="button" class="dashboard-slot-summary ${index === state.selectedIndex ? 'on' : ''}" data-dashboard-select="${index}"><span class="dashboard-slot-summary__dot ${slot.type === 'empty' ? 'dashboard-slot-summary__dot--empty' : ''}"></span><span class="dashboard-slot-summary__position">${esc(slotPosition(state, index))}</span><span class="dashboard-slot-summary__type">${typeLabel(slot.type)}</span><span class="dashboard-slot-summary__detail">${esc(summary(slot.type, config, state.locationLabel, state.todoLists))}</span></button>`;
  }).join('');
  map.querySelectorAll('[data-dashboard-select]').forEach((button) => button.addEventListener('click', () => {
    syncCurrent(root, state);
    state.selectedIndex = Number(button.dataset.dashboardSelect);
    renderLayout(root);
    renderEditor(root);
  }));
}

function markDashboardChanged(root) {
  root.closest('form')?.dispatchEvent(new Event('input', { bubbles: true }));
}

function notifyTodoContentChanged(root) {
  root.dispatchEvent(new CustomEvent('inkpanel:todo-content-changed', { bubbles: true }));
}

function notifyPrinterContentChanged(root) {
  root.dispatchEvent(new CustomEvent('inkpanel:printer-content-changed', { bubbles: true }));
}

function bindTodoEditor(root, state, slot, panel) {
  const config = slot.drafts.todo ?? defaultConfig('todo');
  slot.drafts.todo = config;
  const showError = (err) => {
    const output = panel.querySelector('[data-todo-error]');
    if (!output) return;
    output.textContent = err?.message ?? String(err);
    output.hidden = false;
  };
  const mutate = async (button, operation, { after = () => {}, configChanged = false, contentChanged = false } = {}) => {
    button.disabled = true;
    try {
      const result = await operation();
      state.todoLists = (await getJson('/api/todo-lists')).lists;
      after(result);
      if (configChanged) markDashboardChanged(root);
      if (contentChanged) notifyTodoContentChanged(root);
      renderLayout(root);
      renderEditor(root);
    } catch (err) {
      button.disabled = false;
      showError(err);
    }
  };

  panel.querySelector('[data-todo-list]').addEventListener('change', (event) => {
    config.listId = event.currentTarget.value;
    markDashboardChanged(root);
    renderLayout(root);
    renderEditor(root);
  });
  panel.querySelector('[data-todo-create]').addEventListener('click', (event) => {
    const name = panel.querySelector('[data-todo-new-list]').value.trim();
    void mutate(event.currentTarget, () => sendJson('POST', '/api/todo-lists', { name }), {
      after: (created) => { config.listId = created.id; },
      configChanged: true,
    });
  });

  // These fields edit the separately persisted shared list, not DeviceStore.
  // Stop their native events before the enclosing panel form's generic dirty
  // listeners see them. The list selector is deliberately excluded.
  panel.querySelectorAll('[data-todo-new-list], [data-todo-rename], [data-todo-new-task], [data-todo-text], [data-todo-completed]').forEach((control) => {
    control.addEventListener('input', (event) => event.stopPropagation());
    control.addEventListener('change', (event) => event.stopPropagation());
  });

  const selected = () => state.todoLists.find((list) => list.id === config.listId);
  panel.querySelector('[data-todo-rename-button]')?.addEventListener('click', (event) => {
    const name = panel.querySelector('[data-todo-rename]').value.trim();
    void mutate(event.currentTarget, () => sendJson('PUT', `/api/todo-lists/${encodeURIComponent(config.listId)}`, { name }));
  });
  panel.querySelector('[data-todo-delete-list]')?.addEventListener('click', (event) => {
    if (!globalThis.confirm(`Delete the “${selected()?.name ?? 'selected'}” To Do list?`)) return;
    void mutate(event.currentTarget, () => sendJson('DELETE', `/api/todo-lists/${encodeURIComponent(config.listId)}`), {
      after: () => { config.listId = ''; },
      configChanged: true,
    });
  });
  panel.querySelector('[data-todo-add]')?.addEventListener('click', (event) => {
    const text = panel.querySelector('[data-todo-new-task]').value.trim();
    void mutate(event.currentTarget, () => sendJson('POST', `/api/todo-lists/${encodeURIComponent(config.listId)}/items`, { text }), { contentChanged: true });
  });

  panel.querySelectorAll('[data-todo-item]').forEach((row) => {
    const itemId = row.dataset.todoItem;
    row.querySelector('[data-todo-completed]').addEventListener('change', (event) => {
      void mutate(event.currentTarget, () => sendJson('PUT', `/api/todo-lists/${encodeURIComponent(config.listId)}/items/${encodeURIComponent(itemId)}`, { completed: event.currentTarget.checked }), { contentChanged: true });
    });
    row.querySelector('[data-todo-text]').addEventListener('change', (event) => {
      void mutate(event.currentTarget, () => sendJson('PUT', `/api/todo-lists/${encodeURIComponent(config.listId)}/items/${encodeURIComponent(itemId)}`, { text: event.currentTarget.value.trim() }), { contentChanged: true });
    });
    row.querySelector('[data-todo-delete-item]').addEventListener('click', (event) => {
      void mutate(event.currentTarget, () => sendJson('DELETE', `/api/todo-lists/${encodeURIComponent(config.listId)}/items/${encodeURIComponent(itemId)}`), { contentChanged: true });
    });
    row.querySelectorAll('[data-todo-move]').forEach((button) => button.addEventListener('click', (event) => {
      const list = selected();
      const index = list.items.findIndex((item) => item.id === itemId);
      const target = index + Number(event.currentTarget.dataset.todoMove);
      const itemIds = list.items.map((item) => item.id);
      [itemIds[index], itemIds[target]] = [itemIds[target], itemIds[index]];
      void mutate(event.currentTarget, () => sendJson('PUT', `/api/todo-lists/${encodeURIComponent(config.listId)}/items/order`, { itemIds }), { contentChanged: true });
    }));
  });
}

function bindPrinterEditor(root, state, slot, panel) {
  const config = slot.drafts.printers ?? defaultConfig('printers');
  slot.drafts.printers = config;
  const showError = (err) => {
    const output = panel.querySelector('[data-printer-error]');
    if (!output) return;
    output.textContent = err?.message ?? String(err);
    output.hidden = false;
  };
  const mutate = async (button, operation, { contentChanged = false } = {}) => {
    button.disabled = true;
    try {
      await operation();
      state.printers = (await getJson('/api/printers')).printers;
      if (contentChanged) notifyPrinterContentChanged(root);
      renderLayout(root);
      renderEditor(root);
    } catch (err) {
      button.disabled = false;
      showError(err);
    }
  };

  panel.querySelectorAll('[data-printer-new-name], [data-printer-new-url], [data-printer-new-key], [data-printer-edit-name], [data-printer-edit-url], [data-printer-edit-key], [data-printer-clear-key]').forEach((control) => {
    control.addEventListener('input', (event) => event.stopPropagation());
    control.addEventListener('change', (event) => event.stopPropagation());
  });
  panel.querySelectorAll('[data-printer-new-url], [data-printer-edit-url]').forEach((input) => {
    input.addEventListener('blur', () => { input.value = normalizePrinterUrlValue(input.value); });
  });

  panel.querySelector('[data-printer-single]')?.addEventListener('change', (event) => {
    config.printerIds = event.currentTarget.value ? [event.currentTarget.value] : [];
    markDashboardChanged(root);
    renderLayout(root);
    renderEditor(root);
  });
  panel.querySelectorAll('[data-printer-select]').forEach((input) => input.addEventListener('change', (event) => {
    const id = event.currentTarget.value;
    if (event.currentTarget.checked) {
      if (config.printerIds.length >= 4) {
        event.currentTarget.checked = false;
        showError(new Error('Select up to four printers.'));
        return;
      }
      config.printerIds.push(id);
    } else config.printerIds = config.printerIds.filter((selectedId) => selectedId !== id);
    markDashboardChanged(root);
    renderLayout(root);
    renderEditor(root);
  }));
  panel.querySelectorAll('[data-printer-order]').forEach((button) => button.addEventListener('click', (event) => {
    const index = config.printerIds.indexOf(event.currentTarget.dataset.printerId);
    const target = index + Number(event.currentTarget.dataset.printerOrder);
    [config.printerIds[index], config.printerIds[target]] = [config.printerIds[target], config.printerIds[index]];
    markDashboardChanged(root);
    renderEditor(root);
  }));

  panel.querySelector('[data-printer-create]').addEventListener('click', (event) => {
    const name = panel.querySelector('[data-printer-new-name]').value.trim();
    const urlInput = panel.querySelector('[data-printer-new-url]');
    const baseUrl = normalizePrinterUrlValue(urlInput.value);
    urlInput.value = baseUrl;
    const apiKey = panel.querySelector('[data-printer-new-key]').value.trim();
    void mutate(event.currentTarget, () => sendJson('POST', '/api/printers', { name, baseUrl, apiKey }));
  });

  panel.querySelectorAll('[data-printer-connection]').forEach((connection) => {
    const id = connection.dataset.printerConnection;
    connection.querySelector('[data-printer-edit]').addEventListener('click', () => {
      connection.querySelector('[data-printer-connection-edit]')?.toggleAttribute('hidden');
    });
    connection.querySelector('[data-printer-save]').addEventListener('click', (event) => {
      const apiKey = connection.querySelector('[data-printer-edit-key]').value.trim();
      const urlInput = connection.querySelector('[data-printer-edit-url]');
      const baseUrl = normalizePrinterUrlValue(urlInput.value);
      urlInput.value = baseUrl;
      void mutate(event.currentTarget, () => sendJson('PUT', `/api/printers/${encodeURIComponent(id)}`, {
        name: connection.querySelector('[data-printer-edit-name]').value.trim(),
        baseUrl,
        apiKey,
        clearApiKey: Boolean(connection.querySelector('[data-printer-clear-key]')?.checked),
      }), { contentChanged: true });
    });
    connection.querySelector('[data-printer-test]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const output = connection.querySelector('[data-printer-test-result]');
      button.disabled = true;
      try {
        const result = await sendJson('POST', `/api/printers/${encodeURIComponent(id)}/test`);
        output.textContent = result.ok ? `Connected: ${result.status.state.toUpperCase()}` : result.error;
        output.hidden = false;
      } catch (err) {
        output.textContent = err?.message ?? String(err);
        output.hidden = false;
      } finally { button.disabled = false; }
    });
    connection.querySelector('[data-printer-delete]').addEventListener('click', (event) => {
      if (!globalThis.confirm('Delete this printer connection?')) return;
      void mutate(event.currentTarget, () => sendJson('DELETE', `/api/printers/${encodeURIComponent(id)}`));
    });
  });
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
    { configured: state.trafficApiConfigured, keyDraft: state.trafficApiKeyDraft },
    slotPosition(state, index), state.todoLists, state.printers, state.isMini, state.haCalendars, state.haTodos, state.haSensors);

  panel.querySelector('[data-widget-type]').addEventListener('change', (event) => {
    const previous = slot.type;
    rememberCell(panel, slot, previous);
    switchDashboardDraft(state.slots, index, event.target.value, slot.drafts[previous]);
    renderLayout(root); renderEditor(root);
  });
  if (slot.type === 'entities') {
    bindEntitiesEditor(panel, config, state.haSensors, (nextConfig) => {
      slot.drafts.entities = nextConfig;
      renderLayout(root); markDashboardChanged(root);
    });
  } else if (slot.type === 'calendar') {
    panel.querySelector('[data-calendar-provider]')?.addEventListener('change', (event) => {
      rememberCell(panel, slot);
      switchCalendarProvider(slot, event.target.value);
      renderLayout(root); renderEditor(root); markDashboardChanged(root);
    });
    panel.querySelectorAll('[data-ha-calendar]').forEach((input) => input.addEventListener('change', () => {
      const tooMany = panel.querySelectorAll('[data-ha-calendar]:checked').length > 10;
      if (tooMany) input.checked = false;
      const error = panel.querySelector('[data-calendar-error]');
      error.textContent = tooMany ? 'Select at most 10 calendars.' : '';
      error.hidden = !tooMany;
      rememberCell(panel, slot); renderLayout(root);
    }));
  } else if (slot.type === 'trains') {
    panel.querySelector('[data-train-api-key]').addEventListener('input', (e) => { state.trainApiKeyDraft = e.currentTarget.value; });
    renderStationPicker(panel.querySelector('[data-station="origin"]'), stationPickerOptions(state.deviceId, index, 'origin', 'From', config.originCrs ?? ''));
    renderStationPicker(panel.querySelector('[data-station="destination"]'), stationPickerOptions(state.deviceId, index, 'destination', 'To', config.destinationCrs ?? ''));
  } else if (slot.type === 'bus') {
    panel.querySelector('[data-bus-app-id]').addEventListener('input', (e) => { state.busAppIdDraft = e.currentTarget.value; });
    panel.querySelector('[data-bus-app-key]').addEventListener('input', (e) => { state.busAppKeyDraft = e.currentTarget.value; });
    renderBusStopPicker(panel.querySelector('[data-bus-stop]'), { id: `${state.deviceId}-section-${index}`, stopCode: config.stopCode ?? '', stopLabel: config.stopLabel ?? '', searchEnabled: state.busApiConfigured });
  } else if (slot.type === 'traffic') {
    panel.querySelector('[data-traffic-api-key]').addEventListener('input', (e) => { state.trafficApiKeyDraft = e.currentTarget.value; });
  } else if (slot.type === 'todo') {
    panel.querySelector('[data-todo-provider]')?.addEventListener('change', (event) => {
      rememberCell(panel, slot);
      switchTodoProvider(slot, event.target.value);
      renderLayout(root); renderEditor(root); markDashboardChanged(root);
    });
    if (config.provider === 'home-assistant') {
      panel.querySelector('[data-ha-todo-list]').addEventListener('change', () => {
        rememberCell(panel, slot); renderLayout(root); markDashboardChanged(root);
      });
    } else bindTodoEditor(root, state, slot, panel);
  } else if (slot.type === 'printers') {
    bindPrinterEditor(root, state, slot, panel);
  }
}

export function renderDashboardEditor(root, device, trainApi = { configured: false }, busApi = { configured: false }, trafficApi = { configured: false }, remembered = { shared: [], slots: [[], [], [], []] }, todoLists = [], printers = [], haCalendars = {}, haTodos = {}, haSensors = {}) {
  const slots = createDashboardDraftState(device.dashboardSections, remembered);
  const isMini = device.panelProfileId === MINI_PROFILE;
  stateByRoot.set(root, { deviceId: device.id, locationLabel: device.locationLabel, slots, selectedIndex: 0, isMini, trainApiConfigured: Boolean(trainApi.configured), trainApiKeyDraft: '', busApiConfigured: Boolean(busApi.configured), busAppIdDraft: '', busAppKeyDraft: '', trafficApiConfigured: Boolean(trafficApi.configured), trafficApiKeyDraft: '', todoLists: clone(todoLists), printers: clone(printers), haCalendars, haTodos, haSensors });
  root.innerHTML = `<div class="dashboard-composer ${isMini ? 'dashboard-composer--single' : ''}"><div class="dashboard-layout-map ${isMini ? 'dashboard-layout-map--single' : ''}" data-dashboard-layout-map></div><div class="dashboard-config-panel" data-dashboard-config-panel></div></div>`;
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
  return serialiseRememberedDashboardDrafts(state.slots);
}

export function serialiseRememberedDashboardDrafts(slots) {
  return { slots: slots.map(rememberedProviderDrafts) };
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
