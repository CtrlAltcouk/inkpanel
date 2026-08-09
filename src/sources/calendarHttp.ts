import type { LookupAddress } from 'node:dns';
import { lookup as nodeLookup } from 'node:dns/promises';
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { calendarHostDescription, parseCalendarUrl } from './calendarUrl.ts';

export const MAX_CALENDAR_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_CALENDAR_REDIRECTS = 3;

export interface CalendarNetworkPolicy {
  allowPrivateNetworks: boolean;
}

export interface CalendarResolverOptions {
  all: true;
  order: 'verbatim';
}

export type CalendarResolver = (
  hostname: string,
  options: CalendarResolverOptions,
) => Promise<readonly LookupAddress[]>;

export interface CalendarHttpResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: AsyncIterable<Uint8Array>;
  destroy(error?: Error): void;
}

export type CalendarTransport = (
  url: URL,
  addresses: readonly LookupAddress[],
  signal: AbortSignal,
) => Promise<CalendarHttpResponse>;

export interface CalendarHttpOptions extends CalendarNetworkPolicy {
  resolver?: CalendarResolver;
  transport?: CalendarTransport;
  maxBodyBytes?: number;
  maxRedirects?: number;
}

export type CalendarTextFetcher = (url: string, signal: AbortSignal) => Promise<string>;

const alwaysBlocked = new BlockList();
const privateBlocked = new BlockList();

function addIpv4Subnet(list: BlockList, address: string, prefix: number): void {
  list.addSubnet(address, prefix, 'ipv4');
  // Validate mapped forms with the same policy rather than letting IPv4 hide
  // inside an IPv6 literal/result.
  list.addSubnet(`::ffff:${address}`, 96 + prefix, 'ipv6');
}

for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) addIpv4Subnet(alwaysBlocked, address, prefix);

for (const [address, prefix] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) addIpv4Subnet(privateBlocked, address, prefix);

for (const [address, prefix] of [
  ['::', 96],
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) alwaysBlocked.addSubnet(address, prefix, 'ipv6');

privateBlocked.addSubnet('fc00::', 7, 'ipv6');

export function isCalendarAddressAllowed(address: string, policy: CalendarNetworkPolicy): boolean {
  const normalized = address.replace(/^\[|\]$/g, '');
  const family = isIP(normalized);
  if (family === 0) return false;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (alwaysBlocked.check(normalized, type)) return false;
  return policy.allowPrivateNetworks || !privateBlocked.check(normalized, type);
}

export function parseCalendarAllowPrivateNetworks(value: string | undefined): boolean {
  return value === '1';
}

function abortedError(): Error {
  return new Error('calendar fetch aborted');
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortedError();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedError());
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

const defaultResolver: CalendarResolver = (hostname, options) =>
  nodeLookup(hostname, options);

export function createPinnedLookup(addresses: readonly LookupAddress[]): LookupFunction {
  type Callback = (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void;

  return ((
    _hostname: string,
    options: number | { all?: boolean },
    callback: Callback,
  ) => {
    if (typeof options === 'object' && options.all) {
      callback(null, addresses.map(({ address, family }) => ({ address, family })));
      return;
    }
    const first = addresses[0];
    if (!first) {
      const error = Object.assign(new Error('no validated calendar address'), { code: 'ENOTFOUND' });
      callback(error, '', 0);
      return;
    }
    callback(null, first.address, first.family);
  }) as LookupFunction;
}

export const requestPinnedCalendar: CalendarTransport = (url, addresses, signal) =>
  new Promise<IncomingMessage>((resolve, reject) => {
    const hostname = calendarHostDescription(url);
    const options: RequestOptions & { servername?: string } = {
      protocol: url.protocol,
      hostname,
      port: url.port || undefined,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers: {
        accept: 'text/calendar, text/plain;q=0.9',
        'accept-encoding': 'identity',
        'user-agent': 'InkPanel calendar fetcher',
      },
      lookup: createPinnedLookup(addresses),
      signal,
    };
    if (url.protocol === 'https:' && isIP(hostname) === 0) options.servername = hostname;

    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(options, resolve);
    req.once('error', reject);
    req.end();
  }).then((response) => ({
    statusCode: response.statusCode ?? 0,
    headers: response.headers,
    body: response,
    destroy: (error?: Error) => response.destroy(error),
  }));

async function validatedAddresses(
  url: URL,
  policy: CalendarNetworkPolicy,
  resolver: CalendarResolver,
  signal: AbortSignal,
): Promise<readonly LookupAddress[]> {
  const hostname = calendarHostDescription(url);
  const literalFamily = isIP(hostname);
  const addresses = literalFamily === 0
    ? await withAbort(resolver(hostname, { all: true, order: 'verbatim' }), signal)
    : [{ address: hostname, family: literalFamily as 4 | 6 }];

  if (addresses.length === 0) throw new Error(`calendar host ${hostname} has no addresses`);
  for (const candidate of addresses) {
    if (candidate.family !== isIP(candidate.address) ||
        !isCalendarAddressAllowed(candidate.address, policy)) {
      throw new Error(`calendar host ${hostname} resolves to a blocked address`);
    }
  }
  return addresses;
}

function redirectLocation(headers: IncomingHttpHeaders): string | null {
  const value = headers.location;
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readBoundedBody(
  response: CalendarHttpResponse,
  limit: number,
  signal: AbortSignal,
  hostname: string,
): Promise<string> {
  const encoding = response.headers['content-encoding'];
  if (encoding && encoding !== 'identity') {
    response.destroy();
    throw new Error(`calendar feed from ${hostname} used unsupported content encoding`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const onAbort = () => response.destroy(abortedError());
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const chunk of response.body) {
      if (signal.aborted) throw abortedError();
      const buffer = Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > limit) {
        response.destroy();
        throw new Error(`calendar feed from ${hostname} exceeded ${limit} bytes`);
      }
      chunks.push(buffer);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Fetch one calendar through validated, pinned DNS with bounded redirects/body. */
export function createCalendarTextFetcher(options: CalendarHttpOptions): CalendarTextFetcher {
  const resolver = options.resolver ?? defaultResolver;
  const transport = options.transport ?? requestPinnedCalendar;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_CALENDAR_BODY_BYTES;
  const maxRedirects = options.maxRedirects ?? MAX_CALENDAR_REDIRECTS;
  const policy = { allowPrivateNetworks: options.allowPrivateNetworks };

  return async (rawUrl, signal) => {
    let current = parseCalendarUrl(rawUrl);
    for (let redirects = 0; ; redirects += 1) {
      const hostname = calendarHostDescription(current);
      let response: CalendarHttpResponse;
      try {
        const addresses = await validatedAddresses(current, policy, resolver, signal);
        response = await transport(current, addresses, signal);
      } catch (err) {
        if (signal.aborted || (err instanceof Error && err.message === 'calendar fetch aborted')) {
          throw abortedError();
        }
        if (err instanceof Error && err.message.startsWith('calendar host ')) throw err;
        throw new Error(`calendar feed from ${hostname} could not be fetched`);
      }

      if (isRedirect(response.statusCode)) {
        const location = redirectLocation(response.headers);
        response.destroy();
        if (!location) throw new Error(`calendar feed from ${hostname} returned a redirect without a location`);
        if (redirects >= maxRedirects) throw new Error('calendar redirect limit exceeded');

        let redirected: URL;
        try {
          redirected = parseCalendarUrl(new URL(location, current).href);
        } catch {
          throw new Error(`calendar feed from ${hostname} returned an invalid redirect`);
        }
        if (current.protocol === 'https:' && redirected.protocol === 'http:') {
          throw new Error(`calendar feed from ${hostname} attempted an HTTPS to HTTP redirect`);
        }
        current = redirected;
        continue;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.destroy();
        throw new Error(`calendar feed from ${hostname} responded with HTTP ${response.statusCode}`);
      }
      return readBoundedBody(response, maxBodyBytes, signal, hostname);
    }
  };
}
