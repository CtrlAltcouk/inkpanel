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
// render's DOM. Both tabs make real getJson() calls on this exact path, so a
// fast reload during a slow fetch would otherwise let the stale response win
// the race.
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
  // Adopt `scratch` itself into `view`, rather than round-tripping through
  // `scratch.innerHTML` (a string round-trip re-parses fresh elements and
  // silently drops every addEventListener a render attached — e.g.
  // panels.js's card-select, save and push handlers — leaving the live DOM
  // inert) and rather than moving just its children (render() closures such
  // as panels.js's push handler re-query `root` — i.e. `scratch` — *after*
  // this point, e.g. when the push response comes back; if only the
  // children were relocated, `scratch` would be left empty and those
  // lookups would silently return null). Moving `scratch` itself preserves
  // both the live listeners and `root` as the queryable container. #view
  // has no styling that depends on its children being unwrapped, so the
  // added layer costs nothing.
  view.replaceChildren(scratch);
}

window.addEventListener('hashchange', route);
await route();
