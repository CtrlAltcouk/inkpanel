// Contract: the picker communicates with the form through `container.dataset`,
// not through named inputs — `save()` in panels.js reads latitude/longitude/
// label/timezone off the container's dataset, ignoring any form fields the
// picker happens to render. A named <input> here would be collected by
// FormData and then silently ignored by save(), which only looks at dataset.
import { getJson } from './api.js';
import { esc } from './components.js';

const DEBOUNCE_MS = 250;
const MIN_CHARS = 2;

export function renderCityPicker(container, device) {
  const current = device.locationLabel || `${device.latitude}, ${device.longitude}`;

  container.innerHTML = `
    <label for="city-input">City</label>
    <input id="city-input" type="text" autocomplete="off" spellcheck="false"
           value="${esc(current)}" placeholder="Start typing a town or city">
    <div class="city-results" hidden></div>
    <p class="meta city-current">Using ${esc(current)}</p>`;

  const input = container.querySelector('#city-input');
  const results = container.querySelector('.city-results');
  const currentLine = container.querySelector('.city-current');
  let timer = null;
  let sequence = 0;

  // If the user hand-edits the timezone field after choosing a city, their
  // edit must win: save() in panels.js prefers dataset.timezone over the
  // visible field, so a stale dataset.timezone would silently override a
  // deliberate correction. Clear it on direct edits so save() falls back to
  // whatever the field actually shows. The field lives in the surrounding
  // form, not inside this container — see the note in choose() below — and
  // may not exist at all, so this must not throw when it's absent.
  const timezoneField = container.closest('form')?.querySelector('input[name="timezone"]');
  timezoneField?.addEventListener('input', () => {
    delete container.dataset.timezone;
  });

  function choose(result) {
    // panels.js reads these on submit. Storing on the container keeps the
    // picker free of any knowledge of the form around it.
    container.dataset.latitude = String(result.latitude);
    container.dataset.longitude = String(result.longitude);
    container.dataset.label = result.label;
    container.dataset.timezone = result.timezone;

    input.value = result.label;
    results.hidden = true;
    currentLine.textContent = `Will save ${result.label} — timezone ${result.timezone}`;

    // A wrong timezone silently shifts every event time on the panel, so keep
    // the visible field in step with the chosen city. renderPanels(root)
    // hands us a detached container, so we can't reach the timezone field via
    // `document` — walk up to the surrounding form instead.
    const form = container.closest('form');
    const timezoneField = form?.querySelector('input[name="timezone"]');
    if (timezoneField) timezoneField.value = result.timezone;
  }

  async function search(query) {
    const mine = ++sequence;
    try {
      const { results: found } = await getJson(`/api/geocode?q=${encodeURIComponent(query)}`);
      // Discard responses from superseded keystrokes.
      if (mine !== sequence) return;

      if (found.length === 0) {
        results.innerHTML = '<div class="city-empty">No matches</div>';
        results.hidden = false;
        return;
      }

      results.innerHTML = found
        .map((r, i) => `<button type="button" class="city-option" data-index="${i}">${esc(r.label)}</button>`)
        .join('');
      results.hidden = false;
      results.querySelectorAll('.city-option').forEach((button) => {
        button.addEventListener('click', () => choose(found[Number(button.dataset.index)]));
      });
    } catch {
      if (mine !== sequence) return;
      results.innerHTML = '<div class="city-empty">Lookup failed</div>';
      results.hidden = false;
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < MIN_CHARS) {
      sequence += 1;
      results.hidden = true;
      return;
    }
    timer = setTimeout(() => void search(query), DEBOUNCE_MS);
  });

  input.addEventListener('blur', () => {
    // Delay so a click on an option registers before the list disappears.
    setTimeout(() => { results.hidden = true; }, 150);
  });

  // Seed latitude/longitude immediately so a save that never touches the
  // picker still round-trips the existing coordinates (save() only includes
  // lat/lon/label at all when dataset.latitude is present). Deliberately NOT
  // seeding dataset.timezone: save() copies it over raw.timezone whenever
  // it's set, so seeding it from the device's current value would silently
  // clobber a timezone the user typed directly into the visible field
  // without ever touching this picker.
  if (device.latitude !== undefined && device.latitude !== null) {
    container.dataset.latitude = String(device.latitude);
    container.dataset.longitude = String(device.longitude);
  }
}
