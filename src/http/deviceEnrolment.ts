import { z } from 'zod';

export const DEVICE_ENROLMENT_WINDOW_MS = 60 * 60 * 1000;
export const DEVICE_ENROLMENT_PER_IP_LIMIT = 5;
export const DEVICE_ENROLMENT_GLOBAL_LIMIT = 20;

/** Runtime-only policy for IDs that unauthenticated firmware may auto-create. */
export const firmwareAutoEnrolmentIdSchema = z
  .string()
  .regex(/^esp32-[0-9a-f]{6}$/, 'invalid firmware enrolment id');

type LimitBucket = { count: number; resetAt: number };

export interface EnrolmentReservation {
  /** Keep the reservation only when this operation actually created a record. */
  complete(created: boolean): void;
}

export type EnrolmentReservationResult =
  | { allowed: true; reservation: EnrolmentReservation }
  | { allowed: false; retryAfterSeconds: number };

export interface DeviceEnrolmentLimiterOptions {
  now?: () => number;
  windowMs?: number;
  perIpLimit?: number;
  globalLimit?: number;
}

/**
 * Bounds unauthenticated persistent device creation without affecting known
 * devices. Reservations close the check/create race; failed or duplicate
 * creations refund their slot.
 */
export class DeviceEnrolmentLimiter {
  private readonly clients = new Map<string, LimitBucket>();
  private global: LimitBucket | null = null;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly perIpLimit: number;
  private readonly globalLimit: number;

  constructor(options: DeviceEnrolmentLimiterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.windowMs = options.windowMs ?? DEVICE_ENROLMENT_WINDOW_MS;
    this.perIpLimit = options.perIpLimit ?? DEVICE_ENROLMENT_PER_IP_LIMIT;
    this.globalLimit = options.globalLimit ?? DEVICE_ENROLMENT_GLOBAL_LIMIT;
  }

  private prune(now: number): void {
    for (const [ip, bucket] of this.clients) {
      if (bucket.resetAt <= now) this.clients.delete(ip);
    }
    if (this.global?.resetAt !== undefined && this.global.resetAt <= now) this.global = null;
  }

  reserve(ip: string): EnrolmentReservationResult {
    const now = this.now();
    this.prune(now);
    const client = this.clients.get(ip);
    const global = this.global;
    const retryAt = Math.max(
      client && client.count >= this.perIpLimit ? client.resetAt : now,
      global && global.count >= this.globalLimit ? global.resetAt : now,
    );
    if (retryAt > now) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000)) };
    }

    const clientBucket = client ?? { count: 0, resetAt: now + this.windowMs };
    const globalBucket = global ?? { count: 0, resetAt: now + this.windowMs };
    clientBucket.count += 1;
    globalBucket.count += 1;
    this.clients.set(ip, clientBucket);
    this.global = globalBucket;

    let active = true;
    return {
      allowed: true,
      reservation: {
        complete: (created) => {
          if (!active) return;
          active = false;
          if (created) return;
          clientBucket.count -= 1;
          globalBucket.count -= 1;
          if (this.clients.get(ip) === clientBucket && clientBucket.count === 0) {
            this.clients.delete(ip);
          }
          if (this.global === globalBucket && globalBucket.count === 0) this.global = null;
        },
      },
    };
  }
}
