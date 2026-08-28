import { esc } from './components.js';
import { switchProviderDraft } from './providerDrafts.js';

export function calendarControlsHtml(config, discovery = {}) {
  const provider = config.provider ?? 'ical';
  const selector = discovery.supported || provider === 'home-assistant'
    ? `<label>Provider</label><select data-calendar-provider><option value="ical" ${provider === 'ical' ? 'selected' : ''}>iCal URLs</option><option value="home-assistant" ${provider === 'home-assistant' ? 'selected' : ''} ${discovery.supported ? '' : 'disabled'}>Home Assistant</option></select>` : '';
  if (provider === 'ical') return `${selector}<label>Secret iCal URLs, one per line</label><textarea data-calendar-urls rows="3" placeholder="https://calendar.example/private.ics">${esc((config.calendarUrls ?? []).join('\n'))}</textarea><p class="meta">For Google Calendar, <a href="https://support.google.com/calendar/answer/37648?hl=en-GB" target="_blank" rel="noreferrer">find your Secret address in iCal format</a>. Treat that URL like a password.</p>`;
  const selected = config.entityIds ?? [];
  const known = discovery.calendars ?? [];
  const missing = selected.filter((id) => !known.some((calendar) => calendar.entityId === id));
  const calendars = [...known, ...missing.map((entityId) => ({ entityId, name: `${entityId} (missing/unavailable)` }))];
  const status = !discovery.available ? '<p class="meta">Home Assistant calendars are unavailable. Saved selections are retained.</p>'
    : known.length === 0 ? '<p class="meta">No Home Assistant calendars found.</p>' : '';
  return `${selector}<label>Home Assistant calendars</label>${status}<div data-ha-calendars>${calendars.map(({ entityId, name }) => `<label class="checkbox"><input type="checkbox" data-ha-calendar value="${esc(entityId)}" ${selected.includes(entityId) ? 'checked' : ''}> ${esc(name)}</label>`).join('')}</div><p class="meta">Select up to 10 calendars, then click Save changes.</p><p class="error" data-calendar-error hidden></p>`;
}

export function rememberCalendarConfig(panel, slot) {
  const current = slot.drafts.calendar;
  if (current.provider === 'home-assistant') {
    return { provider: 'home-assistant', entityIds: [...panel.querySelectorAll('[data-ha-calendar]:checked')].map((input) => input.value) };
  }
  const calendarUrls = panel.querySelector('[data-calendar-urls]').value.split('\n').map((value) => value.trim()).filter(Boolean);
  return slot.versions?.calendar === 2 ? { provider: 'ical', calendarUrls } : { calendarUrls };
}

/** Provider switches upgrade explicitly; loading a V1 widget never does. */
export function switchCalendarProvider(slot, provider) {
  if (!['ical', 'home-assistant'].includes(provider)) return;
  switchProviderDraft(slot, 'calendar', provider, provider === 'ical' ? { calendarUrls: [] } : { entityIds: [] });
}
