// Contract: like cityPicker, this communicates with the form through
// `container.dataset` rather than a named input — save() in panels.js reads
// dataset.crs and ignores form fields the picker renders. A named <input>
// would be collected by FormData and then silently ignored.
import { getJson } from './api.js';
import { esc } from './components.js';

const DEBOUNCE_MS = 150;
const MIN_CHARS = 2;

/**
 * @param container  element to render into; its dataset carries the result
 * @param options    { id, field, label, value } — `field` is the DeviceRecord
 *                   key, used only for the input id so labels bind correctly
 */
export function renderStationPicker(container, { id, field, label, value }) {
  const inputId = `station-${id}-${field}`;
  container.dataset.crs = value || '';

  container.innerHTML = `
    <label for="${inputId}">${esc(label)}</label>
    <input id="${inputId}" type="text" autocomplete="off" spellcheck="false"
           value="${esc(value || '')}" placeholder="Station name or CRS code">
    <div class="city-results" hidden></div>
    <p class="meta station-current">${value ? `Using ${esc(value)}` : 'Not set'}</p>`;

  const input = container.querySelector(`#${CSS.escape(inputId)}`);
  const results = container.querySelector('.city-results');
  const currentLine = container.querySelector('.station-current');
  let sequence = 0;
  let timer = null;

  function choose(station) {
    container.dataset.crs = station.crs;
    input.value = `${station.name} (${station.crs})`;
    results.hidden = true;
    currentLine.textContent = `Will save ${station.crs} — ${station.name}`;
  }

  async function search(query) {
    const mine = ++sequence;
    try {
      const { results: found } = await getJson(`/api/stations?q=${encodeURIComponent(query)}`);
      if (mine !== sequence) return; // superseded keystroke

      if (found.length === 0) {
        results.innerHTML = '<div class="city-empty">No matches</div>';
        results.hidden = false;
        return;
      }

      results.innerHTML = found
        .map((s, i) => `<button type="button" class="city-option" data-index="${i}">${esc(s.name)} (${esc(s.crs)})</button>`)
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
    // Clearing the box clears the choice — otherwise an emptied field would
    // silently keep saving the station it used to hold.
    if (input.value.trim() === '') container.dataset.crs = '';
    const query = input.value.trim();
    if (query.length < MIN_CHARS) {
      sequence += 1;
      results.hidden = true;
      return;
    }
    timer = setTimeout(() => void search(query), DEBOUNCE_MS);
  });

  // Same fix as cityPicker.js, for the same measured reason: mousedown moves
  // focus off the input, blur hides the list, and by mouseup the option is no
  // longer hit-testable — so no click event is ever generated and choosing a
  // station does nothing. preventDefault stops focus moving at all. Keyboard
  // selection is unaffected.
  results.addEventListener('mousedown', (event) => event.preventDefault());
  input.addEventListener('blur', () => { results.hidden = true; });
}
