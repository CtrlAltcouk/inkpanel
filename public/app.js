import { renderPanels } from './panels.js';
import { renderSettings } from './settings.js';

const view = document.getElementById('view');

const ROUTES = {
  panels: renderPanels,
  settings: renderSettings,
};

async function route() {
  const name = location.hash.replace('#', '') || 'panels';
  const render = ROUTES[name] ?? renderPanels;

  document.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.classList.toggle('on', tab.dataset.tab === name);
  });

  view.innerHTML = '<p class="empty">Loading…</p>';
  try {
    await render(view);
  } catch (err) {
    // ApiError with status 401 already redirected; anything else is worth showing.
    if (err?.status !== 401) {
      view.innerHTML = `<div class="card"><p class="error">${err.message}</p></div>`;
    }
  }
}

window.addEventListener('hashchange', route);
await route();
