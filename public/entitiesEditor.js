import { esc } from './components.js';

const MAX_SENSORS = 4;
const MAX_RESULTS = 20;

function fallbackName(id) { return id.replace(/^sensor\./, '').replaceAll('_', ' '); }
function currentValue(entity) {
  const value = entity?.state?.trim();
  if (!value || /^(unknown|unavailable|undefined|null|nan)$/i.test(value)) return 'Unavailable';
  return `${value}${entity.unit ? ` ${entity.unit}` : ''}`;
}

export function entitiesControlsHtml(discovery = {}) {
  return `<div class="entities-editor">
    <p class="meta">Choose up to four sensors. Their order controls the display. Click Save changes to apply. Read only: manage sensor states in Home Assistant.</p>
    ${!discovery.available ? '<p class="meta" data-entities-unavailable>Home Assistant sensors are unavailable. Saved selections are retained.</p>' : ''}
    <div data-entities-selected></div>
    <label>Search sensors<input type="search" data-entity-search placeholder="Friendly name or sensor.entity_id" autocomplete="off"></label>
    <p class="meta" data-entities-count></p><div data-entities-results></div>
  </div>`;
}

/** Only selection changes cross the callback boundary; searching is UI state. */
export function bindEntitiesEditor(panel, config, discovery, onChange) {
  let selected = [...config.entityIds];
  const known = discovery.entities ?? [];
  const input = panel.querySelector('[data-entity-search]');
  const selectedRoot = panel.querySelector('[data-entities-selected]');
  const resultsRoot = panel.querySelector('[data-entities-results]');
  const changed = () => { render(); onChange({ entityIds: [...selected] }); };

  function render() {
    selectedRoot.innerHTML = selected.map((id, index) => {
      const entity = known.find((candidate) => candidate.entityId === id);
      const name = entity?.name ?? fallbackName(id);
      return `<div class="entities-editor-item" data-selected-entity="${esc(id)}"><div><strong>${esc(name)}</strong><small>${esc(id)}</small><span>${esc(entity ? currentValue(entity) : 'Missing/unavailable')}</span></div>
        <div class="actions"><button type="button" class="ghost" data-entity-move="-1" data-entity-index="${index}" aria-label="Move ${esc(name)} up" ${index === 0 ? 'disabled' : ''}>Up</button><button type="button" class="ghost" data-entity-move="1" data-entity-index="${index}" aria-label="Move ${esc(name)} down" ${index === selected.length - 1 ? 'disabled' : ''}>Down</button><button type="button" class="ghost" data-entity-remove="${index}" aria-label="Remove ${esc(name)}">Remove</button></div></div>`;
    }).join('') || '<p class="meta">No sensors selected.</p>';
    const query = input.value.trim().toLowerCase();
    const matches = known.filter((entity) => !selected.includes(entity.entityId)
      && `${entity.name} ${entity.entityId}`.toLowerCase().includes(query));
    panel.querySelector('[data-entities-count]').textContent = `${selected.length} / ${MAX_SENSORS} selected. ${matches.length > MAX_RESULTS ? `Showing first ${MAX_RESULTS} matches — refine your search.` : `${matches.length} matching sensors.`}`;
    resultsRoot.innerHTML = matches.slice(0, MAX_RESULTS).map((entity) => `<button type="button" class="entities-editor-result ghost" data-entity-add="${esc(entity.entityId)}" ${selected.length >= MAX_SENSORS ? 'disabled' : ''}><strong>${esc(entity.name)}</strong><small>${esc(entity.entityId)}</small><span>${esc(currentValue(entity))}</span></button>`).join('');
  }

  input.addEventListener('input', (event) => { event.stopPropagation(); render(); });
  input.addEventListener('change', (event) => event.stopPropagation());
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') event.preventDefault(); });
  resultsRoot.addEventListener('click', (event) => {
    const button = event.target.closest('[data-entity-add]');
    const id = button?.dataset.entityAdd;
    if (!id || selected.length >= MAX_SENSORS || selected.includes(id) || !known.some((entity) => entity.entityId === id)) return;
    selected.push(id); changed();
  });
  selectedRoot.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-entity-remove]');
    const move = event.target.closest('[data-entity-move]');
    if (remove) selected.splice(Number(remove.dataset.entityRemove), 1);
    else if (move) {
      const index = Number(move.dataset.entityIndex);
      const next = index + Number(move.dataset.entityMove);
      if (next < 0 || next >= selected.length) return;
      [selected[index], selected[next]] = [selected[next], selected[index]];
    } else return;
    changed();
  });
  render();
}
