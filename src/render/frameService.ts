import { createHash } from 'node:crypto';
import type {
  DashboardData,
  DashboardSectionData,
  MiniDashboardData,
  ProfileDashboardData,
  SourceHealth,
  WeatherData,
} from '../model/dashboard.ts';
import { contentHash } from '../model/hash.ts';
import { PROFILES, WFT0583, type PanelProfile } from '../panel/profile.ts';
import { quantisePng } from '../panel/quantise.ts';
import { batteryPercent } from '../devices/battery.ts';
import type { DeviceRecord } from '../devices/types.ts';
import type { IcalFeedConfig } from '../sources/ical.ts';
import { runCalendars } from '../sources/calendarRunner.ts';
import { openMeteoSource } from '../sources/openMeteo.ts';
import { binsSource } from '../sources/bins.ts';
import { runLiveSource, runSource } from '../sources/runner.ts';
import type { RunOutcome } from '../sources/runner.ts';
import type { SourceCache } from '../sources/cache.ts';
import type { Source } from '../sources/types.ts';
import type { TrainSourceConfig } from '../sources/nationalRailTrain.ts';
import type { TrainData } from '../sources/train.ts';
import type { BusData, BusSourceConfig } from '../sources/transportApiBus.ts';
import type { TrafficData, TrafficSourceConfig } from '../sources/googleTraffic.ts';
import {
  cheapestUpcomingOctopus,
  octopusAgileSource,
  type OctopusAgileConfig,
  type OctopusRateWindow,
} from '../sources/octopusAgile.ts';
import type { Renderer } from './browser.ts';
import { renderEnrolmentHtml } from './enrolment.ts';
import { renderProfileHtml } from './profileTemplate.ts';
import { loadFontCss } from './fonts.ts';
import type { TodoStore } from '../todo/store.ts';
import { offlinePrinter, type MoonrakerClient } from '../printers/moonraker.ts';
import type { PrinterConnectionStore } from '../printers/store.ts';

const SOURCE_TIMEOUT_MS = 8000;

export interface SourceBundle {
  headerWeather: RunOutcome<WeatherData>;
  /** Profile validation decides whether there must be one or four entries. */
  sections: DashboardSectionData[];
}

export interface FrameDeps {
  renderer: Renderer;
  cache: SourceCache;
  /** Overridable so tests never touch the network. */
  fetchData?: (device: DeviceRecord) => Promise<SourceBundle>;
  /** Injected once at startup so calendar network policy is explicit/testable. */
  calendarSource?: Source<IcalFeedConfig, string>;
  weatherSource?: typeof openMeteoSource;
  binsSource?: typeof binsSource;
  trainSource?: Source<TrainSourceConfig, TrainData>;
  busSource?: Source<BusSourceConfig, BusData>;
  /** Google Routes data is live-only and never persisted to SourceCache. */
  trafficSource?: Source<TrafficSourceConfig, TrafficData>;
  octopusSource?: Source<OctopusAgileConfig, OctopusRateWindow>;
  /** Local shared-list persistence. To Do deliberately bypasses SourceCache. */
  todoStore?: TodoStore;
  /** Shared LAN connection registry and live-only Moonraker client. */
  printerStore?: PrinterConnectionStore;
  moonrakerClient?: MoonrakerClient;
}

export interface Frame {
  buffer: Buffer;
  etag: string;
  renderedAt: string;
  /**
   * When the visible content last genuinely changed, ISO instant. Set on
   * frames produced by frameFor/renderNow; absent on enrolment frames, which
   * have no such concept. Exposed on the frame (rather than only internally)
   * so callers — and tests — can observe when useful content last changed
   * even though that metadata is not printed on the dashboard.
   */
  contentChangedAt?: string;
}

interface Memo {
  hash: string;
  frame: Frame;
  contentChangedAt: string;
  health: DiagnosticHealth[];
}

interface DiagnosticHealth {
  sourceId: string;
  status: SourceHealth['status'];
  error: string | null;
}

export class FrameService {
  private readonly memo = new Map<string, Memo>();
  /**
   * Enrolment frames depend only on the device id and the server URL, neither
   * of which changes. Without this an unclaimed device — which polls every 60
   * seconds — would trigger a full Chromium render every single time.
   */
  private readonly enrolmentMemo = new Map<string, Frame>();
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

    const runOptions = { deviceId: device.id, timeoutMs: SOURCE_TIMEOUT_MS };
    const headerWeatherPromise = runSource(
      this.deps.weatherSource ?? openMeteoSource,
      { latitude: device.latitude, longitude: device.longitude, timezone: device.timezone },
      this.deps.cache,
      runOptions,
    );
    const requests = new Map<string, Promise<DashboardSectionData>>();

    const sectionRequest = (widget: DeviceRecord['dashboardSections'][number]): Promise<DashboardSectionData> => {
      const key = `${widget.type}:${JSON.stringify(widget.config)}`;
      const existing = requests.get(key);
      if (existing) return existing;

      let request: Promise<DashboardSectionData>;
      switch (widget.type) {
        case 'calendar':
          request = runCalendars(
            widget.config.calendarUrls,
            device.timezone,
            this.deps.cache,
            { ...runOptions, source: this.deps.calendarSource },
          ).then((outcome) => ({ type: 'calendar', data: outcome.data, health: outcome.health }));
          break;
        case 'weather':
          request = headerWeatherPromise.then((outcome) => ({
            type: 'weather', data: outcome.data, health: outcome.health,
          }));
          break;
        case 'bins':
          request = widget.config.uprn
            ? runSource(this.deps.binsSource ?? binsSource, { uprn: widget.config.uprn }, this.deps.cache, runOptions)
              .then((outcome) => ({ type: 'bins', data: outcome.data, health: outcome.health }))
            : Promise.resolve({ type: 'bins', data: null, health: null });
          break;
        case 'trains': {
          const configured = Boolean(widget.config.originCrs && widget.config.destinationCrs);
          if (!configured) {
            request = Promise.resolve({ type: 'trains', data: null, health: null });
          } else if (!this.deps.trainSource) {
            request = Promise.resolve({
              type: 'trains', data: null,
              health: { id: 'trains', status: 'error', fetchedAt: null, error: 'National Rail live departures are not configured on this server' },
            });
          } else {
            request = runSource(
              this.deps.trainSource,
              { originCrs: widget.config.originCrs, destinationCrs: widget.config.destinationCrs },
              this.deps.cache,
              runOptions,
            ).then((outcome) => ({ type: 'trains', data: outcome.data, health: outcome.health }));
          }
          break;
        }
        case 'bus': {
          if (!widget.config.stopCode) {
            request = Promise.resolve({ type: 'bus', data: null, health: null });
          } else if (!this.deps.busSource) {
            request = Promise.resolve({
              type: 'bus', data: null,
              health: { id: 'bus', status: 'error', fetchedAt: null, error: 'Bus live departures are not configured on this server' },
            });
          } else {
            request = runSource(
              this.deps.busSource,
              {
                stopCode: widget.config.stopCode,
                stopLabel: widget.config.stopLabel,
                routeFilter: widget.config.routeFilter,
              },
              this.deps.cache,
              runOptions,
            ).then((outcome) => ({ type: 'bus', data: outcome.data, health: outcome.health }));
          }
          break;
        }
        case 'traffic': {
          const configured = Boolean(widget.config.origin.trim() && widget.config.destination.trim());
          if (!configured) {
            request = Promise.resolve({ type: 'traffic', data: null, health: null });
          } else if (!this.deps.trafficSource) {
            request = Promise.resolve({
              type: 'traffic', data: null,
              health: { id: 'traffic', status: 'error', fetchedAt: null, error: 'Google traffic is not configured on this server' },
            });
          } else {
            // Deliberately bypass SourceCache: Google Maps Content must not be
            // persisted through InkPanel's normal stale-data cache.
            request = runLiveSource(
              this.deps.trafficSource,
              { origin: widget.config.origin, destination: widget.config.destination },
              runOptions,
            ).then((outcome) => ({ type: 'traffic', data: outcome.data, health: outcome.health }));
          }
          break;
        }
        case 'octopus': {
          if (!widget.config.tariffCode) {
            request = Promise.resolve({ type: 'octopus', data: null, health: null });
          } else {
            request = runSource(
              this.deps.octopusSource ?? octopusAgileSource,
              { tariffCode: widget.config.tariffCode },
              this.deps.cache,
              runOptions,
            ).then((outcome) => ({
              type: 'octopus',
              data: outcome.data ? cheapestUpcomingOctopus(outcome.data) : null,
              health: outcome.health,
            }));
          }
          break;
        }
        case 'todo': {
          if (!widget.config.listId || !this.deps.todoStore) {
            request = Promise.resolve({ type: 'todo', data: null, configured: false, health: null });
          } else {
            request = this.deps.todoStore.get(widget.config.listId).then((list) => ({
              type: 'todo' as const,
              data: list ? {
                items: list.items
                  .filter((item) => !item.completed)
                  .slice(0, 5)
                  .map((item) => item.text),
              } : null,
              configured: list !== null,
              health: null,
            }));
          }
          break;
        }
        case 'printers': {
          if (widget.config.printerIds.length === 0 || !this.deps.printerStore || !this.deps.moonrakerClient) {
            request = Promise.resolve({ type: 'printers', data: null, configured: false, health: null });
          } else {
            request = Promise.all(widget.config.printerIds.map(async (id) => {
              const connection = await this.deps.printerStore!.get(id);
              if (!connection) return null;
              try { return await this.deps.moonrakerClient!.query(connection); }
              catch { return offlinePrinter(connection.name); }
            })).then((results) => {
              const printers = results.filter((result) => result !== null);
              const offline = printers.some((printer) => printer.state === 'offline');
              return {
                type: 'printers' as const,
                data: printers.length ? { printers } : null,
                configured: printers.length === widget.config.printerIds.length,
                health: {
                  id: 'moonraker', status: offline ? 'error' as const : 'ok' as const,
                  fetchedAt: new Date().toISOString(),
                  error: offline ? 'one or more selected printers are offline' : null,
                },
              };
            });
          }
          break;
        }
        case 'empty':
          request = Promise.resolve({ type: 'empty' });
          break;
      }
      requests.set(key, request);
      return request;
    };

    const [headerWeather, sections] = await Promise.all([
      headerWeatherPromise,
      Promise.all(device.dashboardSections.map(sectionRequest)),
    ]);
    return { headerWeather, sections };
  }

  private buildData(
    device: DeviceRecord,
    bundle: SourceBundle,
    batteryVolts: number | null,
    contentChangedAt: string,
  ): ProfileDashboardData {
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

    const common = {
      generatedAt: now.toISOString(),
      contentChangedAt,
      timezone: device.timezone,
      today: {
        iso: `${isoPart('year')}-${isoPart('month')}-${isoPart('day')}`,
        weekdayLong: part('weekday'),
        dayOfMonth: Number(part('day')),
        monthLong: part('month'),
      },
      headerWeather: bundle.headerWeather.data,
      headerWeatherHealth: bundle.headerWeather.health,
      battery: { volts: batteryVolts, percent: batteryPercent(batteryVolts) },
    };

    const profile = this.profileFor(device);
    if (profile.dashboardSlots === 1) {
      if (bundle.sections.length !== 1) {
        throw new Error(`${profile.id} expected one dashboard section, got ${bundle.sections.length}`);
      }
      const mini: MiniDashboardData = { ...common, sections: [bundle.sections[0]!] };
      return mini;
    }

    if (bundle.sections.length !== 4) {
      throw new Error(`${profile.id} expected four dashboard sections, got ${bundle.sections.length}`);
    }
    const large: DashboardData = {
      ...common,
      sections: [bundle.sections[0]!, bundle.sections[1]!, bundle.sections[2]!, bundle.sections[3]!],
    };
    return large;
  }

  private diagnosticHealth(bundle: SourceBundle): DiagnosticHealth[] {
    return [
      {
        sourceId: `header:${bundle.headerWeather.health.id}`,
        status: bundle.headerWeather.health.status,
        error: bundle.headerWeather.health.error,
      },
      ...bundle.sections.flatMap((section, index) => section.type !== 'empty' && section.health
        ? [{
            sourceId: `section-${index}:${section.health.id}`,
            status: section.health.status,
            error: section.health.error,
          }]
        : []),
    ];
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

  /**
   * Shared implementation behind frameFor and renderNow.
   *
   * `force` controls only whether an unchanged hash still triggers a
   * re-rasterise — it never affects whether contentChangedAt moves. That
   * timestamp advances if and only if the content hash actually changed, so
   * Push (force: true) can make Chromium run again to prove something
   * happened without relabelling stale content as freshly changed.
   */
  private async renderInternal(
    device: DeviceRecord,
    batteryVolts: number | null,
    force: boolean,
  ): Promise<Frame> {
    const bundle = await this.fetchAll(device);
    const previous = this.memo.get(device.id);
    const provisional = this.buildData(
      device,
      bundle,
      batteryVolts,
      previous?.contentChangedAt ?? new Date().toISOString(),
    );
    const hash = contentHash(provisional);
    const unchanged = previous !== undefined && previous.hash === hash;
    const health = this.diagnosticHealth(bundle);

    if (unchanged && !force) {
      // Diagnostics are not part of the visible hash. Keep them current even
      // when identical pixels let us reuse the previous framebuffer.
      this.memo.set(device.id, { ...previous, health });
      return previous.frame;
    }

    const contentChangedAt = unchanged ? previous.contentChangedAt : new Date().toISOString();
    const data = { ...provisional, contentChangedAt } as ProfileDashboardData;
    const profile = this.profileFor(device);
    const rendered = await this.rasterise(
      renderProfileHtml(data, profile, await this.fontCss()),
      profile,
    );
    const frame: Frame = { ...rendered, contentChangedAt };

    this.memo.set(device.id, { hash, frame, contentChangedAt, health });
    return frame;
  }

  /** Build the device's frame, re-rendering only when visible content changed. */
  async frameFor(device: DeviceRecord, batteryVolts: number | null): Promise<Frame> {
    return this.renderInternal(device, batteryVolts, false);
  }

  /**
   * Render unconditionally, ignoring the memo.
   *
   * frameFor returns the cached frame when the content hash is unchanged, which
   * is exactly right for devices and exactly wrong for a user who has pressed
   * Push and expects to see something happen. Push therefore always
   * re-rasterises through Chromium — but when content has not genuinely
   * changed it keeps the existing internal contentChangedAt metadata, since
   * that timestamp is deliberately excluded from the content hash and must
   * only move when content actually changed, not merely because someone
   * pressed a button.
   */
  async renderNow(device: DeviceRecord, batteryVolts: number | null): Promise<Frame> {
    return this.renderInternal(device, batteryVolts, true);
  }

  /**
   * Sources not currently reporting ok, across every device rendered so far.
   *
   * Safe to read from the memo: diagnostics are refreshed after every source
   * load, including when visible content is unchanged and rasterisation is
   * skipped.
   */
  sourceIssues(): Array<{ deviceId: string; sourceId: string; status: string; error: string | null }> {
    const issues = [];
    for (const [deviceId, memo] of this.memo) {
      for (const source of memo.health) {
        if (source.status !== 'ok') {
          issues.push({ deviceId, sourceId: source.sourceId, status: source.status, error: source.error });
        }
      }
    }
    return issues;
  }

  /**
   * How many devices have actually been rendered at least once (and so have
   * an entry in the memo) — as opposed to the total number of devices known
   * to the store.
   *
   * `sourceIssues()` returns `[]` both when every rendered source is healthy
   * and when nothing has been rendered at all (a fresh restart, or a claimed
   * device that has not polled since). This count is what lets a caller tell
   * those two situations apart, the same way `checkForUpdate` reports
   * `'unknown'` rather than silently reading as `'current'`.
   */
  renderedDeviceCount(): number {
    return this.memo.size;
  }

  async enrolmentFrame(device: DeviceRecord, baseUrl: string): Promise<Frame> {
    const key = `${device.id}|${baseUrl}|${device.panelProfileId}`;
    const cached = this.enrolmentMemo.get(key);
    if (cached) return cached;

    const profile = this.profileFor(device);
    const frame = await this.rasterise(
      renderEnrolmentHtml(device, baseUrl, profile, await this.fontCss()),
      profile,
    );
    this.enrolmentMemo.set(key, frame);
    return frame;
  }

  /** Launch Chromium before any device asks for a frame. */
  async warmUp(): Promise<void> {
    await this.deps.renderer.warmUp();
  }

  /** The HTML behind /preview, for iterating on layout in a browser. */
  async previewHtml(device: DeviceRecord): Promise<string> {
    const bundle = await this.fetchAll(device);
    const data = this.buildData(device, bundle, device.lastBatteryVolts, new Date().toISOString());
    return renderProfileHtml(data, this.profileFor(device), await this.fontCss());
  }
}
