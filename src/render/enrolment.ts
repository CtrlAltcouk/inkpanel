import type { DeviceRecord } from '../devices/types.ts';
import type { PanelProfile } from '../panel/profile.ts';

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMiniEnrolmentHtml(
  device: DeviceRecord,
  baseUrl: string,
  profile: PanelProfile,
  fontCss: string,
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${fontCss}
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:${profile.width}px;height:${profile.height}px;background:#fff;color:#000;overflow:hidden;}
body{font-family:"Inter",sans-serif;-webkit-font-smoothing:none;}
.card{width:200px;height:200px;border:3px solid #000;padding:13px;text-align:center;display:flex;flex-direction:column;justify-content:center;}
h1{font-family:"Dela Gothic One",sans-serif;font-size:25px;line-height:1.05;letter-spacing:-0.03em;margin-bottom:12px;}
p{font-size:11px;line-height:1.25;}
.url{font-size:12px;font-weight:800;margin:10px 0;border-top:2px solid #000;border-bottom:2px solid #000;padding:8px 2px;overflow-wrap:anywhere;}
.id{font-size:8px;letter-spacing:0.05em;text-transform:uppercase;}
</style></head><body>
<div class="card">
  <h1>NEW MINI</h1>
  <p>Open InkPanel to set me up</p>
  <div class="url">${esc(baseUrl)}</div>
  <p class="id">${esc(device.id)}</p>
</div>
</body></html>`;
}

/** Setup instructions rendered onto the panel itself. Black and white only. */
export function renderEnrolmentHtml(
  device: DeviceRecord,
  baseUrl: string,
  profile: PanelProfile,
  fontCss: string,
): string {
  if (profile.dashboardSlots === 1) {
    return renderMiniEnrolmentHtml(device, baseUrl, profile, fontCss);
  }

  // Existing 800×480 enrolment markup is intentionally unchanged.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${fontCss}
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:${profile.width}px;height:${profile.height}px;background:#fff;color:#000;overflow:hidden;}
body{font-family:"Inter",sans-serif;-webkit-font-smoothing:none;display:flex;align-items:center;justify-content:center;}
.card{border:4px solid #000;padding:44px 56px;text-align:center;}
h1{font-family:"Dela Gothic One",sans-serif;font-size:52px;letter-spacing:-0.02em;margin-bottom:18px;}
p{font-size:22px;line-height:1.5;}
.url{font-size:30px;font-weight:700;margin:22px 0;border-top:2px solid #000;border-bottom:2px solid #000;padding:14px 0;}
.id{font-size:16px;letter-spacing:0.1em;text-transform:uppercase;}
</style></head><body>
<div class="card">
  <h1>NEW PANEL</h1>
  <p>Open this address to set me up</p>
  <div class="url">${esc(baseUrl)}</div>
  <p class="id">Device ID: ${esc(device.id)}</p>
</div>
</body></html>`;
}
