import { createHash } from 'node:crypto';
import type { CalendarData, DashboardData, SourceHealth, WeatherData } from '../model/dashboard.ts';
import { contentHash } from '../model/hash.ts';
import { PROFILES, WFT0583, type PanelProfile } from '../panel/profile.ts';
import { quantisePng } from '../panel/quantise.ts';
import { batteryPercent } from '../devices/battery.ts';
import type { DeviceRecord } from '../devices/types.ts';
import { icalSource } from '../sources/ical.ts';
import { openMeteoSource } from '../sources/openMeteo.ts';
import { runSource } from '../sources/runner.ts';
import type { SourceCache } from '../sources/cache.ts';
import type { Renderer } from './browser.ts';
import { renderEnrolmentHtml } from './enrolment.ts';
import { renderHtml } from './template.ts';
import { loadFontCss } from './fonts.ts';

const SOURCE_TIMEOUT_MS = 8000;

export interface SourceBundle {
  calendar: CalendarData | null;
  weather: WeatherData | null;
  sourceHealth: SourceHealth[];
}

export interface FrameDeps {
  renderer: Renderer;
  cache: SourceCache;
  /** Overridable so tests never touch the network. */
  fetchData?: (device: DeviceRecord) => Promise<SourceBundle>;
}

export interface Frame {
  buffer: Buffer;
  etag: string;
  renderedAt: string;
}

interface Memo {
  hash: string;
  frame: Frame;
  contentChangedAt: string;
}

export class FrameService {
  private readonly memo = new Map<string, Memo>();
  private fontCssPromise: Promise<string> | null = null;

  constructor(private readonly deps: FrameDeps) {}

  private fontCss(): Promise<string> {
    this.fontCssPromise ??= loadFontCss();
    return this.fontCssPromise;
  }

  private profileFor(device: DeviceRecord): PanelProfile {
    return PROFILES[device.panelProfileId] ?? WFT0583;
  }

  private async fetchAll(device: DeviceRecord): Promise<SourceBundle> {
    if (this.deps.fetchData) return this.deps.fetchData(device);

    const [calendar, weather] = await Promise.all([
      runSource(
        icalSource,
        { urls: device.calendarUrls, timezone: device.timezone },
        this.deps.cache,
        SOURCE_TIMEOUT_MS,
      ),
      runSource(
        openMeteoSource,
        { latitude: device.latitude, longitude: device.longitude, timezone: device.timezone },
        this.deps.cache,
        SOURCE_TIMEOUT_MS,
      ),
    ]);

    return {
      calendar: calendar.data,
      weather: weather.data,
      sourceHealth: [calendar.health, weather.health],
    };
  }

  private buildData(
    device: DeviceRecord,
    bundle: SourceBundle,
    batteryVolts: number | null,
    contentChangedAt: string,
  ): DashboardData {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: device.timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).formatToParts(now);
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';

    // Local date, not UTC: at 23:30 in London during BST these differ, and the
    // panel must agree with the calendar about which day it is.
    const isoParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: device.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const isoPart = (type: string) => isoParts.find((p) => p.type === type)?.value ?? '';

    return {
      generatedAt: now.toISOString(),
      contentChangedAt,
      timezone: device.timezone,
      today: {
        iso: `${isoPart('year')}-${isoPart('month')}-${isoPart('day')}`,
        weekdayLong: part('weekday'),
        dayOfMonth: Number(part('day')),
        monthLong: part('month'),
      },
      calendar: bundle.calendar,
      weather: bundle.weather,
      sourceHealth: bundle.sourceHealth,
      battery: { volts: batteryVolts, percent: batteryPercent(batteryVolts) },
    };
  }

  private async rasterise(html: string, profile: PanelProfile): Promise<Frame> {
    const png = await this.deps.renderer.screenshot(html, profile);
    const buffer = await quantisePng(png, profile);
    return {
      buffer,
      etag: createHash('sha256').update(buffer).digest('hex').slice(0, 32),
      renderedAt: new Date().toISOString(),
    };
  }

  /** Build the device's frame, re-rendering only when visible content changed. */
  async frameFor(device: DeviceRecord, batteryVolts: number | null): Promise<Frame> {
    const bundle = await this.fetchAll(device);
    const previous = this.memo.get(device.id);
    const provisional = this.buildData(
      device,
      bundle,
      batteryVolts,
      previous?.contentChangedAt ?? new Date().toISOString(),
    );
    const hash = contentHash(provisional);

    if (previous && previous.hash === hash) return previous.frame;

    const contentChangedAt = new Date().toISOString();
    const data = { ...provisional, contentChangedAt };
    const profile = this.profileFor(device);
    const frame = await this.rasterise(renderHtml(data, profile, await this.fontCss()), profile);

    this.memo.set(device.id, { hash, frame, contentChangedAt });
    return frame;
  }

  async enrolmentFrame(device: DeviceRecord, baseUrl: string): Promise<Frame> {
    const profile = this.profileFor(device);
    return this.rasterise(
      renderEnrolmentHtml(device, baseUrl, profile, await this.fontCss()),
      profile,
    );
  }

  /** The HTML behind /preview, for iterating on layout in a browser. */
  async previewHtml(device: DeviceRecord): Promise<string> {
    const bundle = await this.fetchAll(device);
    const data = this.buildData(device, bundle, device.lastBatteryVolts, new Date().toISOString());
    return renderHtml(data, this.profileFor(device), await this.fontCss());
  }
}
