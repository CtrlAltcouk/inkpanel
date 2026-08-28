import { getJson, sendJson } from './api.js';
import { esc } from './components.js';

export function homeAssistantUsersHtml(users, lists, currentUser) {
  return `<div class="studio-card" data-ha-users><h2>Home Assistant To Do users</h2>
    <p class="meta">Personal To Do lists can be assigned to Home Assistant users. Other InkPanel data remains shared.</p>
    ${currentUser ? `<p class="meta">Signed in through Home Assistant as ${esc(currentUser.displayName || currentUser.username || currentUser.id)}.</p>` : ''}
    ${!users.length ? '<p class="meta">Open InkPanel through Home Assistant Ingress using the account you want to register.</p>' : ''}
    ${users.map((user) => {
      const choices = [...lists];
      for (const entityId of user.todoEntityIds) if (!choices.some((list) => list.entityId === entityId)) choices.push({ entityId, name: 'Missing/unavailable' });
      return `<details data-ha-user="${esc(user.userId)}"><summary>${esc(user.displayName || user.username || user.userId)} — Manage</summary>
        <p class="meta">Home Assistant user · ${esc(user.userId)}</p><p class="meta">${user.todoEntityIds.length ? `${user.todoEntityIds.length} To Do list(s) assigned` : 'No personal To Do lists assigned.'}</p>
        <h3>Personal To Do lists for ${esc(user.displayName || user.username || user.userId)}</h3>
        ${choices.map((list) => {
          const elsewhere = users.some((other) => other.userId !== user.userId && other.todoEntityIds.includes(list.entityId));
          return `<label class="checkbox"><input type="checkbox" value="${esc(list.entityId)}" ${user.todoEntityIds.includes(list.entityId) ? 'checked' : ''} ${elsewhere ? 'disabled' : ''}>${esc(list.name)} <span class="meta">${esc(list.entityId)}${elsewhere ? ' (assigned to another user)' : ''}</span></label>`;
        }).join('')}
        <div class="actions"><button type="button" data-save-assignments>Save assignments</button><button type="button" class="ghost" data-remove-user>Remove stale mapping</button></div><p class="error" data-user-error hidden></p>
      </details>`;
    }).join('')}</div>`;
}

export async function renderHomeAssistantUsers(root) {
  try {
    // Registration must finish before the admin list is read.
    const identity = await getJson('/api/home-assistant/current-user');
    const [{ users }, discovery] = await Promise.all([getJson('/api/home-assistant/users'), getJson('/api/home-assistant/todo-lists')]);
    root.innerHTML = homeAssistantUsersHtml(users, discovery.lists, identity.user);
    for (const card of root.querySelectorAll('[data-ha-user]')) {
      const act = async (button, action) => {
        button.disabled = true;
        try { await action(); await renderHomeAssistantUsers(root); }
        catch (error) { const message = card.querySelector('[data-user-error]'); message.textContent = error.message; message.hidden = false; button.disabled = false; }
      };
      card.querySelector('[data-save-assignments]').addEventListener('click', (event) => act(event.currentTarget, () =>
        sendJson('PUT', `/api/home-assistant/users/${encodeURIComponent(card.dataset.haUser)}`, { todoEntityIds: [...card.querySelectorAll('input:checked')].map((input) => input.value) })));
      card.querySelector('[data-remove-user]').addEventListener('click', (event) => {
        if (!confirm('Remove this InkPanel mapping and its assignments? This does not delete the Home Assistant user.')) return;
        act(event.currentTarget, () => sendJson('DELETE', `/api/home-assistant/users/${encodeURIComponent(card.dataset.haUser)}`));
      });
    }
  } catch { root.innerHTML = '<div class="studio-card"><h2>Home Assistant To Do users</h2><p class="error">Home Assistant ownership is unavailable. Existing mappings have not been changed.</p></div>'; }
}
