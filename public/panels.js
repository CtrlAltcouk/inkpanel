import { getJson, sendJson } from './api.js';
import { esc, formatRelative, formatVolts, field, pill } from './components.js';
import { renderStationPicker } from './stationPicker.js';

let selectedId = null;

function thumbnail(device) {
  const claimedPill = device.claimed
    ? pill('Claimed', 'status--claimed')
    : pill('Unclaimed', 'status--unclaimed');

  return `<button class="panel-card ${device.id === selectedId ? 'on' : ''}" data-select="${esc(device.id)}">
      <img class="panel-thumb" loading="lazy" alt="What ${esc(device.name)} is showing"
           src="/api/devices/${encodeURIComponent(device.id)}/render.png">
      <span class="panel-name">${esc(device.name)}</span>
      <span class="panel-meta">${esc(formatVolts(device.lastBatteryVolts))} · ${esc(formatRelative(device.lastSeenAt))}</span>
      ${claimedPill}
    </button>`;
}

function detail(device) {
  return `<div class="card" id="detail">
    <h2>${esc(device.name)}${device.claimed ? pill('Claimed', 'status--claimed') : pill('Unclaimed', 'status--unclaimed')}</h2>
    <p class="meta">${esc(device.id)} · fw ${esc(device.lastFirmwareVersion ?? 'unknown')}</p>

    <form data-id="${esc(device.id)}">
      ${field(device.id, 'name', 'Name', device.name)}

      <h3>Location</h3>
      <div id="city-picker"></div>
      ${field(device.id, 'timezone', 'Timezone', device.timezone)}

      <h3>Calendar</h3>
      <label for="${esc(device.id)}-cal">Secret iCal URLs, one per line</label>
      <textarea id="${esc(device.id)}-cal" name="calendarUrls" rows="3"
        placeholder="https://calendar.google.com/calendar/ical/.../private-xxxx/basic.ics">${esc((device.calendarUrls ?? []).join('\n'))}</textarea>

      <h3>Trains</h3>
      <div class="station-picker" data-field="trainOriginCrs"></div>
      <div class="station-picker" data-field="trainDestinationCrs"></div>
      <p class="meta">Both stations are needed. Leave either blank to hide the departures panel.</p>

      <h3>Refresh schedule</h3>
      <div class="row">
        <div>${field(device.id, 'activeIntervalSeconds', 'Interval (seconds)', device.activeIntervalSeconds, 'number')}</div>
        <div>${field(device.id, 'quietHoursStart', 'Quiet from (hour)', device.quietHoursStart, 'number')}</div>
        <div>${field(device.id, 'quietHoursEnd', 'Quiet until (hour)', device.quietHoursEnd, 'number')}</div>
      </div>

      <label class="checkbox">
        <input type="checkbox" name="claimed" ${device.claimed ? 'checked' : ''}>
        Claimed — show the dashboard instead of the setup screen
      </label>

      <div class="actions">
        <button type="submit">Save</button>
        <button type="button" class="ghost" data-push="${esc(device.id)}">Push</button>
        <!-- The strip card above already carries a live thumbnail for this
             device; opening a second copy here would be a second render.png
             request for the same picture. This reuses that exact <img>
             (via CSS, in place) rather than fetching it again. -->
        <button type="button" class="ghost" data-zoom="${esc(device.id)}">View full size</button>
      </div>
      <p class="notice" id="notice" hidden></p>
      <p class="error" id="error" hidden></p>
    </form>
  </div>`;
}

function pushMessage(result) {
  if (result.willAppearBy) {
    const at = new Date(result.willAppearBy).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `Rendered. Will appear by ${at} — or press KEY1 on the panel for now.`;
  }
  if (result.overdueSince) {
    const since = new Date(result.overdueSince).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `Rendered, but this panel has not checked in since ${since}. It will collect it when it next wakes.`;
  }
  return 'Rendered. Will appear at the panel’s next check-in.';
}

// #notice and #error are mutually exclusive: showing one always hides the
// other, so a failure that follows an earlier success (or vice versa) never
// leaves both visible at once.
function showError(root, err) {
  const notice = root.querySelector('#notice');
  const error = root.querySelector('#error');
  notice.hidden = true;
  const detailText = (err.issues ?? []).map((i) => `${i.path?.join('.') ?? '?'}: ${i.message}`).join('\n');
  error.textContent = `${err.message}${detailText ? `\n${detailText}` : ''}`;
  error.hidden = false;
}

function showNotice(root, text) {
  const notice = root.querySelector('#notice');
  const error = root.querySelector('#error');
  error.hidden = true;
  notice.textContent = text;
  notice.hidden = false;
}

async function save(event, root) {
  event.preventDefault();
  const form = event.target;
  const raw = Object.fromEntries(new FormData(form));
  const picker = form.querySelector('#city-picker');

  const body = {
    name: raw.name,
    timezone: raw.timezone,
    calendarUrls: String(raw.calendarUrls || '').split('\n').map((s) => s.trim()).filter(Boolean),
    activeIntervalSeconds: Number(raw.activeIntervalSeconds),
    quietHoursStart: Number(raw.quietHoursStart),
    quietHoursEnd: Number(raw.quietHoursEnd),
    claimed: form.querySelector('[name=claimed]').checked,
  };

  // The city picker owns three fields at once; it only contributes when a
  // result has actually been chosen.
  if (picker?.dataset.latitude) {
    body.latitude = Number(picker.dataset.latitude);
    body.longitude = Number(picker.dataset.longitude);
    body.locationLabel = picker.dataset.label;
    if (picker.dataset.timezone) body.timezone = picker.dataset.timezone;
  }

  // The station pickers show "Milton Keynes Central (MKC)" in the visible
  // input, which is not a CRS code — read the dataset seam they maintain
  // instead of collecting the input's text.
  const origin = form.querySelector('[data-field="trainOriginCrs"]');
  const destination = form.querySelector('[data-field="trainDestinationCrs"]');
  body.trainOriginCrs = origin?.dataset.crs ?? '';
  body.trainDestinationCrs = destination?.dataset.crs ?? '';

  await sendJson('PUT', `/api/devices/${encodeURIComponent(form.dataset.id)}`, body);
  await renderPanels(root);
}

// Renders (or replaces) the #detail card for `device` and wires its form,
// push and zoom controls. Shared by the initial render and by card
// selection so both stay in sync.
async function renderDetail(root, device) {
  const html = detail(device);
  const existing = root.querySelector('#detail');
  if (existing) {
    existing.outerHTML = html;
  } else {
    root.insertAdjacentHTML('beforeend', html);
  }

  const detailEl = root.querySelector('#detail');

  const form = detailEl.querySelector('form');
  form.addEventListener('submit', (event) => {
    // A 401 has already sent the browser to /login.html (see api.js);
    // painting "authentication required" into the page here would just be
    // noise on the way out, so only genuine failures get shown.
    void save(event, root).catch((err) => {
      if (err?.status !== 401) showError(root, err);
    });
  });

  detailEl.querySelector('[data-push]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Rendering…';
    try {
      const result = await sendJson('POST', `/api/devices/${encodeURIComponent(button.dataset.push)}/push`);
      showNotice(root, pushMessage(result));
      // Cache-bust the strip thumbnail so it reflects the render that just
      // happened, rather than requesting a second copy of the same image.
      const thumb = root.querySelector(`[data-select="${CSS.escape(button.dataset.push)}"] .panel-thumb`);
      if (thumb) thumb.src = `/api/devices/${encodeURIComponent(button.dataset.push)}/render.png?t=${Date.now()}`;
    } catch (err) {
      if (err?.status !== 401) showError(root, err);
    } finally {
      button.disabled = false;
      button.textContent = 'Push';
    }
  });

  detailEl.querySelector('[data-zoom]').addEventListener('click', () => {
    const img = root.querySelector(`[data-select="${CSS.escape(device.id)}"] .panel-thumb`);
    img?.classList.toggle('panel-thumb--zoomed');
  });

  const { renderCityPicker } = await import('./cityPicker.js');
  renderCityPicker(detailEl.querySelector('#city-picker'), device);

  detailEl.querySelectorAll('.station-picker').forEach((container) => {
    const field = container.dataset.field;
    renderStationPicker(container, {
      id: device.id,
      field,
      label: field === 'trainOriginCrs' ? 'From' : 'To',
      value: device[field] || '',
    });
  });
}

// Switching the selected card must not re-fetch every thumbnail: it only
// swaps the detail pane and toggles which card is highlighted. The strip's
// <img> elements are left completely untouched, so no new render.png
// requests happen just from clicking around.
function selectDevice(root, devices, id) {
  selectedId = id;
  root.querySelectorAll('[data-select]').forEach((card) => {
    card.classList.toggle('on', card.dataset.select === id);
  });
  const device = devices.find((d) => d.id === id);
  void renderDetail(root, device);
}

export async function renderPanels(root) {
  const { devices } = await getJson('/api/devices');

  if (devices.length === 0) {
    root.innerHTML = '<div class="card"><p class="empty">No panels yet. Power one on and it will appear here.</p></div>';
    return;
  }

  if (!devices.some((d) => d.id === selectedId)) selectedId = devices[0].id;

  root.innerHTML = `<div class="panel-strip">${devices.map(thumbnail).join('')}</div>`;
  root.querySelectorAll('[data-select]').forEach((card) => {
    card.addEventListener('click', () => selectDevice(root, devices, card.dataset.select));
  });
  root.querySelectorAll('.panel-thumb').forEach((img) => {
    // While zoomed, clicking the (now full-screen) picture closes it again.
    // Stop the click from also bubbling to the card's own select handler.
    img.addEventListener('click', (event) => {
      if (img.classList.contains('panel-thumb--zoomed')) {
        event.stopPropagation();
        img.classList.remove('panel-thumb--zoomed');
      }
    });
  });

  await renderDetail(root, devices.find((d) => d.id === selectedId));
}
