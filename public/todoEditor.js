import { esc } from './components.js';
import { switchProviderDraft } from './providerDrafts.js';

export function todoProviderHtml(config, discovery = {}) {
  const provider = config.provider ?? 'local';
  return discovery.supported || provider === 'home-assistant'
    ? `<label>Provider</label><select data-todo-provider><option value="local" ${provider === 'local' ? 'selected' : ''}>InkPanel list</option><option value="home-assistant" ${provider === 'home-assistant' ? 'selected' : ''} ${discovery.supported ? '' : 'disabled'}>Home Assistant</option></select>` : '';
}

export function homeAssistantTodoControlsHtml(config, discovery = {}) {
  const known = discovery.lists ?? [];
  const lists = [...known];
  if (config.entityId && !known.some((list) => list.entityId === config.entityId)) {
    lists.push({ entityId: config.entityId, name: `${config.entityId} (missing/unavailable)` });
  }
  const status = !discovery.available ? 'Home Assistant To Do lists are unavailable. Saved selection is retained.'
    : known.length === 0 ? 'No Home Assistant To Do lists found.' : '';
  return `<label>Home Assistant To Do list</label><select data-ha-todo-list><option value="">Choose a list</option>${lists.map(({ entityId, name }) => `<option value="${esc(entityId)}" ${entityId === config.entityId ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select>${status ? `<p class="meta">${status}</p>` : ''}<p class="meta">Read only in InkPanel. Manage tasks in Home Assistant, then select a list here and click Save changes.</p>`;
}

export function rememberTodoConfig(panel, slot) {
  if (slot.drafts.todo.provider === 'home-assistant') {
    return { provider: 'home-assistant', entityId: panel.querySelector('[data-ha-todo-list]').value };
  }
  const listId = panel.querySelector('[data-todo-list]')?.value ?? '';
  return slot.versions.todo === 2 ? { provider: 'local', listId } : { listId };
}

export function switchTodoProvider(slot, provider) {
  if (!['local', 'home-assistant'].includes(provider)) return;
  switchProviderDraft(slot, 'todo', provider, provider === 'local' ? { listId: '' } : { entityId: '' });
}
