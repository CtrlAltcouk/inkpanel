import type { PanelProfile } from '../panel/profile.ts';

/**
 * Only #000 and #fff are permitted. Thresholding a page that is already pure
 * black and white is lossless; any grey is a gamble on which side of the
 * threshold it lands. Anything that should read as dimmed uses a hatch.
 */
export function panelCss(profile: PanelProfile): string {
  return `
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:${profile.width}px;height:${profile.height}px;overflow:hidden;background:#fff;color:#000;}
body{font-family:"Inter",sans-serif;-webkit-font-smoothing:none;text-rendering:geometricPrecision;}
.disp{font-family:"Dela Gothic One",sans-serif;letter-spacing:-0.02em;}
.tnum{font-variant-numeric:tabular-nums;}

.banner{height:132px;padding:18px 26px;display:flex;justify-content:space-between;align-items:flex-start;}
.banner-date .d1{font-size:66px;line-height:0.92;}
.banner-date .d2{font-size:30px;line-height:1;}
.banner-wx{display:flex;gap:18px;align-items:flex-start;}
.banner-wx .detail{font-size:13px;line-height:1.65;text-align:right;padding-top:6px;}
.banner-wx .temp{font-size:72px;line-height:0.9;text-align:right;}
.banner-wx .cond{font-size:15px;font-weight:700;text-align:right;}

.rule{background:#000;height:3px;}
.grid{height:311px;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;}
.cell{padding:16px 24px;position:relative;}
.cell--tl{border-right:2px solid #000;border-bottom:2px solid #000;}
.cell--tr{border-bottom:2px solid #000;}
.cell--bl{border-right:2px solid #000;}

.label{font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:12px;}
.stale{font-size:10px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;border:1px solid #000;padding:1px 4px;margin-left:6px;}

.subhead{font-size:13px;font-weight:700;margin-bottom:10px;}
.events{display:flex;flex-direction:column;gap:11px;font-size:18px;}
.event{display:flex;gap:12px;align-items:baseline;}
.event .t{width:74px;font-weight:700;flex:none;}
.event .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}

.days{display:flex;gap:22px;font-size:14px;text-align:center;}
.days .w{font-weight:800;}
.days .t{font-size:30px;margin:6px 0;}
.sun{font-size:13px;margin-top:16px;}

/* Dimmed appearance without greys: a 45-degree hatch of pure black on white. */
.slot--empty{
  position:absolute;inset:14px 24px;border:2px solid #000;
  display:flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;
  background-image:repeating-linear-gradient(45deg,#000 0 1px,#fff 1px 7px);
}
.slot--empty span{background:#fff;padding:4px 10px;border:1px solid #000;}

.footer{height:34px;border-top:2px solid #000;padding:9px 26px;display:flex;justify-content:space-between;
  font-size:11px;letter-spacing:0.08em;text-transform:uppercase;}
`.trim();
}
