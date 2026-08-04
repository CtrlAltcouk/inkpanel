import { renderPanels } from './panels.js';
import { renderSettings } from './settings.js';
import { esc } from './components.js';
import { resolveRouteName } from './router.js';

const view = document.getElementById('view');

const ROUTES = {
  panels: renderPanels,
  settings: renderSettings,
};
const FALLBACK_ROUTE = 'panels';

// Bumped on every route() entry so a slow, stale render can recognise it has
// been superseded and discard its result instead of overwriting a newer
// render's DOM. Today both tabs are synchronous placeholders so renders
// never overlap in practice, but Tasks 9/11 add real getJson() calls on this
// exact path, where a fast reload during a slow fetch would otherwise let
// the stale response win the race.
let generation = 0;

async function route() {
  const myGeneration = ++generation;

  const name = resolveRouteName(location.hash, ROUTES, FALLBACK_ROUTE);
  const render = ROUTES[name];

  document.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.classList.toggle('on', tab.dataset.tab === name);
  });

  view.innerHTML = '<p class="empty">Loading…</p>';

  // Render into a detached element rather than `view` directly. render()
  // implementations set `root.innerHTML` themselves, so without this
  // indirection a stale render would already have written to the live DOM
  // before there was any chance to check whether it was still current.
  const scratch = document.createElement('div');
  try {
    await render(scratch);
  } catch (err) {
    if (myGeneration !== generation) return; // superseded — discard
    // ApiError with status 401 already redirected; anything else is worth showing.
    if (err?.status !== 401) {
      view.innerHTML = `<div class="card"><p class="error">${esc(err.message)}</p></div>`;
    }
    return;
  }

  if (myGeneration !== generation) return; // superseded — discard
  view.innerHTML = scratch.innerHTML;
}

window.addEventListener('hashchange', route);
await route();
