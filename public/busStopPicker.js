import { getJson } from './api.js';
import { esc } from './components.js';

const DEBOUNCE_MS = 180;
const MIN_CHARS = 2;
const STOP_CODE = /^[A-Za-z0-9]{3,32}$/;

/**
 * Bus-stop picker backed by TransportAPI Places once credentials are saved.
 * A valid ATCO code can always be typed directly, including during first-time
 * credential setup before server-side search is available.
 */
export function renderBusStopPicker(container, {
  id,
  stopCode = '',
  stopLabel = '',
  searchEnabled = false,
}) {
  const inputId = `bus-stop-${id}`;
  container.dataset.stopCode = stopCode;
  container.dataset.stopLabel = stopLabel;
  const initial = stopLabel && stopCode ? `${stopLabel} (${stopCode})` : stopCode;
  const help = searchEnabled
    ? 'Search by stop name or type an ATCO stop code.'
    : 'Save TransportAPI credentials to enable name search, or enter an ATCO stop code directly.';

  container.innerHTML = `
    <label for="${inputId}">Bus stop</label>
    <input id="${inputId}" type="text" autocomplete="off" spellcheck="false"
           value="${esc(initial)}" placeholder="Stop name or ATCO code">
    <div class="city-results" hidden></div>
    <p class="meta bus-stop-current">${stopCode ? `Using ${esc(stopCode)}${stopLabel ? ` — ${esc(stopLabel)}` : ''}` : esc(help)}</p>`;

  const input = container.querySelector(`#${CSS.escape(inputId)}`);
  const results = container.querySelector('.city-results');
  const currentLine = container.querySelector('.bus-stop-current');
  let sequence = 0;
  let timer = null;

  function choose(stop) {
    container.dataset.stopCode = stop.stopCode;
    container.dataset.stopLabel = stop.name;
    input.value = `${stop.name} (${stop.stopCode})`;
    results.hidden = true;
    currentLine.textContent = `Will save ${stop.stopCode} — ${stop.name}`;
  }

  async function search(query) {
    const mine = ++sequence;
    try {
      const { results: found } = await getJson(`/api/bus-stops?q=${encodeURIComponent(query)}`);
      if (mine !== sequence) return;
      if (found.length === 0) {
        results.innerHTML = '<div class="city-empty">No matches</div>';
        results.hidden = false;
        return;
      }
      results.innerHTML = found
        .map((stop, index) => `<button type="button" class="city-option" data-index="${index}">${esc(stop.name)} (${esc(stop.stopCode)})${stop.locality ? ` · ${esc(stop.locality)}` : ''}</button>`)
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
    // A raw ATCO code remains a valid first-time setup path even before the
    // credential has been saved and search can be used.
    if (STOP_CODE.test(query)) {
      container.dataset.stopCode = query;
      container.dataset.stopLabel = '';
      currentLine.textContent = `Will save ATCO code ${query}`;
    } else {
      container.dataset.stopCode = '';
      container.dataset.stopLabel = '';
    }
    if (!searchEnabled || query.length < MIN_CHARS) {
      sequence += 1;
      results.hidden = true;
      return;
    }
    timer = setTimeout(() => void search(query), DEBOUNCE_MS);
  });

  results.addEventListener('mousedown', (event) => event.preventDefault());
  input.addEventListener('blur', () => { results.hidden = true; });
}
