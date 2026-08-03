import type { DeviceRecord } from '../devices/types.ts';
import type { PanelProfile } from '../panel/profile.ts';

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Setup instructions rendered onto the panel itself. Black and white only. */
export function renderEnrolmentHtml(
  device: DeviceRecord,
  baseUrl: string,
  profile: PanelProfile,
  fontCss: string,
): string {
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
