import type { EntitiesData, EntityDisplayItem } from '../model/dashboard.ts';

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** HA owns units/conversions; both physical profiles use the same formatting. */
export function formatEntityValue(item: EntityDisplayItem): string {
  const value = item.value.trim();
  if (!item.available || !value || /^(unknown|unavailable|undefined|null|nan)$/i.test(value)) return 'UNAVAILABLE';
  const unit = item.unit?.trim();
  if (!unit) return value;
  return `${value}${/^(%|°[CF]?)$/.test(unit) ? '' : ' '}${unit}`;
}

/** Additive widget markup: no selectors or geometry shared with older widgets. */
export function renderEntities(data: EntitiesData | null, configured: boolean, mini = false): string {
  const items = data?.items.slice(0, 4) ?? [];
  let content: string;
  if (!configured || !data || !items.length) {
    content = `<div class="entities-status">${configured ? 'Sensors unavailable' : 'Sensors — not set up'}</div>`;
  } else if (items.length === 1) {
    const item = items[0]!;
    const value = formatEntityValue(item);
    content = `<div class="entities-hero"><div class="entities-value disp tnum${value === 'UNAVAILABLE' ? ' entities-unavailable' : ''}${value.length > 9 ? ' entities-long' : ''}">${esc(value)}</div><div class="entities-name">${esc(item.name)}</div></div>`;
  } else {
    content = `<div class="entities-rows">${items.map((item) => {
      const value = formatEntityValue(item);
      return `<div class="entities-row"><span class="entities-name">${esc(item.name)}</span><span class="entities-value tnum${value === 'UNAVAILABLE' ? ' entities-unavailable' : ''}">${esc(value)}</span></div>`;
    }).join('')}</div>`;
  }
  return `${mini ? '<div class="mini-head">SENSORS</div>' : ''}<div class="entities-${mini ? 'mini' : 'full'}">${content}</div>`;
}

const SHARED_CSS = `.entities-full,.entities-mini{overflow:hidden}.entities-full .entities-value,.entities-mini .entities-value{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.entities-full .entities-hero,.entities-mini .entities-hero{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;height:100%;gap:10px}.entities-full .entities-hero>*,.entities-mini .entities-hero>*{max-width:100%}.entities-full .entities-rows,.entities-mini .entities-rows{height:100%;display:grid;grid-template-rows:repeat(4,minmax(0,1fr))}.entities-full .entities-row,.entities-mini .entities-row{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);align-items:center;gap:8px}.entities-full .entities-row .entities-value,.entities-mini .entities-row .entities-value{text-align:right;font-weight:800}.entities-full .entities-name,.entities-mini .entities-name{min-width:0;overflow:hidden;text-overflow:ellipsis}.entities-full .entities-row .entities-name,.entities-mini .entities-row .entities-name{white-space:nowrap}.entities-full .entities-hero .entities-name,.entities-mini .entities-hero .entities-name{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow-wrap:anywhere}.entities-full .entities-status,.entities-mini .entities-status{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;font-weight:700}`;

export const ENTITIES_CSS = `${SHARED_CSS}.entities-full{height:112px}.entities-full .entities-hero .entities-value{font-size:42px;line-height:1.15}.entities-full .entities-hero .entities-long{font-size:32px}.entities-full .entities-hero .entities-unavailable{font-size:24px}.entities-full .entities-hero .entities-name{font-size:15px;line-height:1.2;max-height:36px;font-weight:650}.entities-full .entities-row{font-size:13px;border-bottom:1px solid #000}.entities-full .entities-row:last-child{border:0}.entities-full .entities-row .entities-value{font-size:16px}.entities-full .entities-row .entities-unavailable{font-size:12px}.entities-full .entities-status{font-size:15px}`;

export const MINI_ENTITIES_CSS = `${SHARED_CSS}.entities-mini{height:144px;padding-top:5px}.entities-mini .entities-hero .entities-value{font-size:34px;line-height:1.15}.entities-mini .entities-hero .entities-long{font-size:27px}.entities-mini .entities-hero .entities-unavailable{font-size:18px}.entities-mini .entities-hero .entities-name{font-size:13px;font-weight:700;line-height:1.2;max-height:32px}.entities-mini .entities-row{font-size:10px;border-bottom:1px solid #000;gap:5px}.entities-mini .entities-row:last-child{border:0}.entities-mini .entities-row .entities-value{font-size:12px}.entities-mini .entities-row .entities-unavailable{font-size:8px}.entities-mini .entities-status{font-size:15px}`;
