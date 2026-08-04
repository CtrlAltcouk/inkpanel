import { getJson, sendJson } from './api.js';
import { esc, formatRelative, formatVolts, field, pill } from './components.js';

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
      <h3>Location</h3>
      <div id="city-picker"></div>
      ${field(device.id, 'timezone', 'Timezone', device.timezone)}

      <h3>Calendar</h3>
      <label for="${esc(device.id)}-cal">Secret iCal URLs, one per line</label>
      <textarea id="${esc(device.id)}-cal" name="calendarUrls" rows="3"
        placeholder="https://calendar.google.com/calendar/ical/.../private-xxxx/basic.ics">${esc((device.calendarUrls ?? []).join('\n'))}</textarea>

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
      </div>
      <p class="notice" id="notice" hidden></p>
      <p class="error" id="error" hidden></p>
    </form>

    <h3>What the panel shows</h3>
    <img class="preview" alt="Rendered output for ${esc(device.name)}"
         src="/api/devices/${encodeURIComponent(device.id)}/render.png?t=${Date.now()}">
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

async function save(event, root) {
  event.preventDefault();
  const form = event.target;
  const raw = Object.fromEntries(new FormData(form));
  const picker = form.querySelector('#city-picker');

  const body = {
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

  await sendJson('PUT', `/api/devices/${encodeURIComponent(form.dataset.id)}`, body);
  await renderPanels(root);
}

export async function renderPanels(root) {
  const { devices } = await getJson('/api/devices');

  if (devices.length === 0) {
    root.innerHTML = '<div class="card"><p class="empty">No panels yet. Power one on and it will appear here.</p></div>';
    return;
  }

  if (!devices.some((d) => d.id === selectedId)) selectedId = devices[0].id;
  const selected = devices.find((d) => d.id === selectedId);

  root.innerHTML = `<div class="panel-strip">${devices.map(thumbnail).join('')}</div>${detail(selected)}`;

  root.querySelectorAll('[data-select]').forEach((card) => {
    card.addEventListener('click', () => {
      selectedId = card.dataset.select;
      void renderPanels(root);
    });
  });

  const form = root.querySelector('form');
  form.addEventListener('submit', (event) => {
    void save(event, root).catch((err) => {
      const el = root.querySelector('#error');
      const detailText = (err.issues ?? []).map((i) => `${i.path?.join('.') ?? '?'}: ${i.message}`).join('\n');
      el.textContent = `${err.message}${detailText ? `\n${detailText}` : ''}`;
      el.hidden = false;
    });
  });

  root.querySelector('[data-push]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const notice = root.querySelector('#notice');
    button.disabled = true;
    button.textContent = 'Rendering…';
    try {
      const result = await sendJson('POST', `/api/devices/${encodeURIComponent(button.dataset.push)}/push`);
      notice.textContent = pushMessage(result);
      notice.hidden = false;
      // Cache-bust so the preview reflects the render that just happened.
      root.querySelector('.preview').src =
        `/api/devices/${encodeURIComponent(button.dataset.push)}/render.png?t=${Date.now()}`;
    } finally {
      button.disabled = false;
      button.textContent = 'Push';
    }
  });

  const { renderCityPicker } = await import('./cityPicker.js');
  renderCityPicker(root.querySelector('#city-picker'), selected);
}
