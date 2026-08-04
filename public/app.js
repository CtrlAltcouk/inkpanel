const container = document.getElementById('devices');

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function field(device, key, label, type = 'text') {
  return `
    <label for="${esc(device.id)}-${key}">${esc(label)}</label>
    <input id="${esc(device.id)}-${key}" name="${key}" type="${type}"
           ${type === 'number' ? 'step="any"' : ''} value="${esc(device[key])}">`;
}

function healthPills(device) {
  const seen = device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : 'never';
  const battery = device.lastBatteryVolts ? `${device.lastBatteryVolts.toFixed(2)} V` : 'unknown';
  const firmware = device.lastFirmwareVersion ?? 'unknown';
  return `<div class="health">
    <span class="pill">last seen ${esc(seen)}</span>
    <span class="pill">battery ${esc(battery)}</span>
    <span class="pill">fw ${esc(firmware)}</span>
  </div>`;
}

function card(device) {
  const statusClass = device.claimed ? 'status--claimed' : 'status--unclaimed';
  const statusText = device.claimed ? 'Claimed' : 'Unclaimed';

  return `
  <div class="card">
    <h2>${esc(device.name)}<span class="status ${statusClass}">${statusText}</span></h2>
    <p class="meta">${esc(device.id)}</p>
    ${healthPills(device)}

    <form data-id="${esc(device.id)}">
      <h3>Location and time</h3>
      <div class="row">
        <div>${field(device, 'name', 'Name')}</div>
        <div>${field(device, 'timezone', 'Timezone')}</div>
      </div>
      <div class="row">
        <div>${field(device, 'latitude', 'Latitude', 'number')}</div>
        <div>${field(device, 'longitude', 'Longitude', 'number')}</div>
      </div>

      <h3>Calendar</h3>
      <label for="${esc(device.id)}-cal">Secret iCal URLs, one per line</label>
      <textarea id="${esc(device.id)}-cal" name="calendarUrls" rows="3"
        placeholder="https://calendar.google.com/calendar/ical/.../basic.ics">${esc((device.calendarUrls ?? []).join('\n'))}</textarea>

      <h3>Refresh schedule</h3>
      <div class="row">
        <div>${field(device, 'activeIntervalSeconds', 'Interval (seconds)', 'number')}</div>
        <div>${field(device, 'quietHoursStart', 'Quiet from (hour)', 'number')}</div>
        <div>${field(device, 'quietHoursEnd', 'Quiet until (hour)', 'number')}</div>
      </div>

      <label class="checkbox">
        <input type="checkbox" name="claimed" ${device.claimed ? 'checked' : ''}>
        Claimed — show the dashboard instead of the setup screen
      </label>

      <button type="submit">Save</button>
      <p class="error" hidden></p>
    </form>

    <h3>What the panel shows</h3>
    <img class="preview" alt="Rendered output for ${esc(device.name)}"
         src="/api/devices/${encodeURIComponent(device.id)}/render.png?t=${Date.now()}">
  </div>`;
}

async function save(event) {
  event.preventDefault();
  const form = event.target;
  const errorEl = form.querySelector('.error');
  const raw = Object.fromEntries(new FormData(form));

  const body = {
    name: raw.name,
    timezone: raw.timezone,
    latitude: Number(raw.latitude),
    longitude: Number(raw.longitude),
    calendarUrls: String(raw.calendarUrls || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    activeIntervalSeconds: Number(raw.activeIntervalSeconds),
    quietHoursStart: Number(raw.quietHoursStart),
    quietHoursEnd: Number(raw.quietHoursEnd),
    claimed: form.querySelector('[name=claimed]').checked,
  };

  const res = await fetch(`/api/devices/${encodeURIComponent(form.dataset.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const problem = await res.json().catch(() => ({ error: res.statusText }));
    const detail = (problem.issues ?? [])
      .map((i) => `${i.path?.join('.') ?? '?'}: ${i.message}`)
      .join('\n');
    errorEl.textContent = `${problem.error}${detail ? `\n${detail}` : ''}`;
    errorEl.hidden = false;
    return;
  }

  errorEl.hidden = true;
  await load();
}

async function load() {
  try {
    const res = await fetch('/api/devices');
    if (res.status === 401) {
      location.href = '/login.html';
      return;
    }
    const { devices } = await res.json();
    container.innerHTML = devices.length
      ? devices.map(card).join('')
      : '<div class="card"><p class="empty">No panels yet. Power one on and it will appear here.</p></div>';
    container.querySelectorAll('form').forEach((f) => f.addEventListener('submit', save));
  } catch (err) {
    container.innerHTML = `<div class="card"><p class="error">Could not reach the server: ${esc(err.message)}</p></div>`;
  }
}

await load();
