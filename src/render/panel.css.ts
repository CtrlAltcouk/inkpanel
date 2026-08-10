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

.banner{height:132px;padding:18px 26px;display:flex;justify-content:space-between;align-items:flex-start;position:relative;}
.battery{position:absolute;top:7px;left:50%;transform:translateX(-50%);font-size:11px;font-weight:800;
  letter-spacing:0.08em;text-transform:uppercase;white-space:nowrap;}
.banner-date .d1{font-size:66px;line-height:0.92;}
.banner-date .d2{font-size:30px;line-height:1;}
.banner-wx{display:flex;gap:18px;align-items:flex-start;}
.banner-wx .detail{font-size:13px;line-height:1.65;text-align:right;padding-top:6px;}
.banner-wx .temp{font-size:72px;line-height:0.9;text-align:right;}
.banner-wx .cond{font-size:15px;font-weight:700;text-align:right;}

.rule{background:#000;height:3px;}
.grid{height:345px;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;}
.cell{padding:16px 24px;position:relative;}
.cell--tl{border-right:2px solid #000;border-bottom:2px solid #000;}
.cell--tr{border-bottom:2px solid #000;}
.cell--bl{border-right:2px solid #000;}

.label{font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
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

.dep{display:flex;gap:12px;align-items:baseline;margin-bottom:7px;}
.dep-time{font-size:21px;font-weight:700;width:62px;font-variant-numeric:tabular-nums;}
.dep-status{font-size:12px;}
.dep-platform{font-size:12px;margin-left:auto;font-variant-numeric:tabular-nums;}
.dep-was{text-decoration:line-through;}

.bus-rows{display:flex;flex-direction:column;gap:6px;padding-bottom:17px;}
.bus-row{display:grid;grid-template-columns:42px 55px minmax(0,1fr);gap:8px;align-items:baseline;}
.bus-line{font-size:16px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.bus-time{font-size:17px;font-weight:700;font-variant-numeric:tabular-nums;}
.bus-dest{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.provider{position:absolute;left:24px;bottom:8px;font-size:8px;font-weight:700;letter-spacing:0.04em;}
.provider--google{font-size:9px;letter-spacing:0;}

.traffic-time{font-size:43px;line-height:0.95;margin-top:2px;}
.traffic-delay{font-size:17px;font-weight:800;margin-top:8px;}
.traffic-route{font-size:11px;line-height:1.2;margin-top:6px;max-height:27px;overflow:hidden;}

/* Dimmed appearance without greys: a 45-degree hatch of pure black on white. */
.slot--empty{
  position:absolute;inset:14px 24px;border:2px solid #000;
  display:flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;
  background-image:repeating-linear-gradient(45deg,#000 0 1px,#fff 1px 7px);
}
.slot--empty span{background:#fff;padding:4px 10px;border:1px solid #000;}

.bin-date{font-size:30px;line-height:1;margin-bottom:8px;}
.bin-row{display:flex;align-items:center;gap:9px;font-size:15px;margin-bottom:6px;}
.bin-swatch{width:13px;height:13px;border:2px solid #000;flex:none;}

/* Bin types are told apart by pattern, not colour — the panel has no colour.
   Each pattern is built only from pure black and white so thresholding is
   exact rather than a judgement call. */
.bin--general{background:#000;}
.bin--recycling{background:linear-gradient(90deg,#000 0 50%,#fff 50% 100%);}
.bin--food{background-image:radial-gradient(#000 40%,#fff 40%);background-size:4px 4px;}
.bin--garden{background-image:repeating-linear-gradient(45deg,#000 0 2px,#fff 2px 5px);}

`.trim();
}
