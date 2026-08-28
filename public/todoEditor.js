import { esc } from './components.js';
import { switchProviderDraft } from './providerDrafts.js';

export function todoProviderHtml(config, discovery = {}) {
  const provider = config.provider ?? 'local';
  return discovery.supported || provider === 'home-assistant'
    ? `<label>Provider</label><select data-todo-provider><option value="local" ${provider === 'local' ? 'selected' : ''}>InkPanel list</option><option value="home-assistant" ${provider === 'home-assistant' ? 'selected' : ''} ${discovery.supported ? '' : 'disabled'}>Home Assistant</option></select>` : '';
}

export function homeAssistantTodoControlsHtml(config, discovery = {}) {
  const personal = 'ownerUserId' in config;
  const users = discovery.users ?? [];
  const owner = users.find((user) => user.userId === config.ownerUserId);
  const candidates = personal && config.ownerUserId === discovery.currentUser?.id && discovery.personalLists
    ? discovery.personalLists : discovery.lists ?? [];
  const known = personal ? candidates.filter((list) => owner?.todoEntityIds.includes(list.entityId)) : candidates;
  const lists = [...known];
  if (personal) for (const entityId of owner?.todoEntityIds ?? []) {
    if (!lists.some((list) => list.entityId === entityId)) lists.push({ entityId, name: `${entityId} (missing/unavailable)` });
  }
  if (config.entityId && !lists.some((list) => list.entityId === config.entityId)) {
    lists.push({ entityId: config.entityId, name: `${config.entityId} (missing/unavailable)` });
  }
  const status = !discovery.available ? 'Home Assistant To Do lists are unavailable. Saved selection is retained.'
    : !personal && known.length === 0 ? 'No Home Assistant To Do lists found.' : '';
  const ownerChoices = [...users];
  if (personal && config.ownerUserId && !owner) ownerChoices.push({ userId: config.ownerUserId, displayName: 'Missing/unavailable owner' });
  const ownership = personal
    ? `<label>Owner</label><select data-ha-todo-owner><option value="">Choose an observed Home Assistant user</option>${ownerChoices.map((user) => `<option value="${esc(user.userId)}" ${user.userId === config.ownerUserId ? 'selected' : ''}>${esc(user.displayName || user.username || user.userId)}</option>`).join('')}</select><p class="meta">This panel always displays the saved owner's list, regardless of who opens Studio.</p>${!owner?.todoEntityIds.length ? '<p class="meta">No personal To Do lists assigned. Manage assignments in Settings.</p>' : ''}`
    : `<p class="meta">Legacy shared Home Assistant To Do</p>${discovery.personalSupported ? '<button type="button" class="ghost" data-todo-make-personal>Make personal</button>' : ''}`;
  return `${ownership}<label>Home Assistant To Do list</label><select data-ha-todo-list><option value="">Choose a list</option>${lists.map(({ entityId, name }) => `<option value="${esc(entityId)}" ${entityId === config.entityId ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select>${status ? `<p class="meta">${status}</p>` : ''}<p class="meta">Read only in InkPanel. Manage tasks in Home Assistant, then select a list here and click Save changes.</p>`;
}

export function rememberTodoConfig(panel, slot) {
  if (slot.drafts.todo.provider === 'home-assistant') {
    return { provider: 'home-assistant', ...('ownerUserId' in slot.drafts.todo
      ? { ownerUserId: panel.querySelector('[data-ha-todo-owner]')?.value ?? slot.drafts.todo.ownerUserId } : {}),
      entityId: panel.querySelector('[data-ha-todo-list]').value };
  }
  const listId = panel.querySelector('[data-todo-list]')?.value ?? '';
  return slot.versions.todo >= 2 ? { provider: 'local', listId } : { listId };
}

export function makeTodoPersonal(slot, discovery = {}) {
  slot.versions.todo = 3;
  // Explicit conversion never guesses an assignment from the legacy entity/name.
  slot.drafts.todo = { provider: 'home-assistant', ownerUserId: discovery.currentUser?.id ?? '', entityId: '' };
}

export function switchTodoProvider(slot, provider, discovery = {}) {
  if (!['local', 'home-assistant'].includes(provider)) return;
  const remembered = slot.providerDrafts?.todo?.[provider];
  switchProviderDraft(slot, 'todo', provider, provider === 'local' ? { listId: '' } : { entityId: '' });
  if (remembered?.version === 3) slot.versions.todo = 3;
  else if (provider === 'home-assistant' && !remembered && discovery.personalSupported) makeTodoPersonal(slot, discovery);
}
