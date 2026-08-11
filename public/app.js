import { getJson } from './api.js';
import { renderPanels, setSelectedPanel } from './panels.js';
import { renderSettings, renderUpdates } from './settings.js';
import { renderFlash } from './flash.js';
import { esc } from './components.js';
import { resolveRouteName } from './router.js';

const view = document.getElementById('view');
const sidebarPanels = document.getElementById('sidebar-panels');
const sidebar = document.getElementById('app-sidebar');
const mobileButton = document.getElementById('mobile-sidebar-button');
const mobileBackdrop = document.getElementById('mobile-sidebar-backdrop');

const ROUTES = {
  panels: renderPanels,
  settings: renderSettings,
  updates: renderUpdates,
  flash: renderFlash,
};
const FALLBACK_ROUTE = 'panels';

let generation = 0;
let shellSelectedPanelId = null;

function panelButton(device) {
  const selected = device.id === shellSelectedPanelId ? ' on' : '';
  const sleeping = device.lastSeenAt ? '' : ' sidebar-panel-dot--sleeping';
  return `<button class="sidebar-panel${selected}" type="button" data-sidebar-panel="${esc(device.id)}">
    <span class="sidebar-panel-dot${sleeping}" aria-hidden="true"></span>
    <span class="sidebar-panel-name">${esc(device.name)}</span>
  </button>`;
}

function updateSidebarPanelSelection() {
  sidebarPanels.querySelectorAll('[data-sidebar-panel]').forEach((button) => {
    button.classList.toggle('on', button.dataset.sidebarPanel === shellSelectedPanelId);
  });
}

async function refreshSidebarPanels() {
  const { devices } = await getJson('/api/devices');
  if (!devices.some((device) => device.id === shellSelectedPanelId)) {
    shellSelectedPanelId = devices[0]?.id ?? null;
    if (shellSelectedPanelId) setSelectedPanel(shellSelectedPanelId);
  }

  sidebarPanels.innerHTML = devices.length
    ? devices.map(panelButton).join('')
    : '<span class="meta">No panels yet</span>';

  sidebarPanels.querySelectorAll('[data-sidebar-panel]').forEach((button) => {
    button.addEventListener('click', () => {
      shellSelectedPanelId = button.dataset.sidebarPanel;
      setSelectedPanel(shellSelectedPanelId);
      updateSidebarPanelSelection();
      closeMobileSidebar();
      if (location.hash !== '#panels') {
        location.hash = '#panels';
      } else {
        void route();
      }
    });
  });
}

function setMobileSidebar(open) {
  sidebar.classList.toggle('open', open);
  mobileBackdrop.classList.toggle('on', open);
  mobileButton.setAttribute('aria-expanded', String(open));
}
function closeMobileSidebar() { setMobileSidebar(false); }

mobileButton.addEventListener('click', () => setMobileSidebar(!sidebar.classList.contains('open')));
mobileBackdrop.addEventListener('click', closeMobileSidebar);
document.querySelectorAll('.sidebar-link, .sidebar-brand').forEach((link) => {
  link.addEventListener('click', closeMobileSidebar);
});

window.addEventListener('inkpanel:panel-selected', (event) => {
  shellSelectedPanelId = event.detail?.id ?? null;
  updateSidebarPanelSelection();
});
window.addEventListener('inkpanel:devices-changed', () => {
  void refreshSidebarPanels().catch(() => undefined);
});

async function route() {
  const myGeneration = ++generation;
  const name = resolveRouteName(location.hash, ROUTES, FALLBACK_ROUTE);
  const render = ROUTES[name];

  document.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.classList.toggle('on', tab.dataset.tab === name);
  });

  view.innerHTML = '<p class="empty">Loading…</p>';

  const scratch = document.createElement('div');
  try {
    await render(scratch);
  } catch (err) {
    if (myGeneration !== generation) return;
    if (err?.status !== 401) {
      view.innerHTML = `<div class="card"><p class="error">${esc(err.message)}</p></div>`;
    }
    return;
  }

  if (myGeneration !== generation) return;
  view.replaceChildren(scratch);
}

window.addEventListener('hashchange', () => {
  closeMobileSidebar();
  void route();
});

try {
  await refreshSidebarPanels();
} catch (err) {
  if (err?.status !== 401) sidebarPanels.innerHTML = '<span class="meta">Panels unavailable</span>';
}
await route();
