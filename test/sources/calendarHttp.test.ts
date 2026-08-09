import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LookupAddress } from 'node:dns';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  classifyCalendarAddress,
  createCalendarTextFetcher,
  createPinnedLookup,
  isCalendarAddressAllowed,
  parseCalendarAllowPrivateNetworks,
  requestPinnedCalendar,
  type CalendarHttpResponse,
  type CalendarResolver,
  type CalendarTransport,
} from '../../src/sources/calendarHttp.ts';
import { parseCalendarUrl } from '../../src/sources/calendarUrl.ts';
import { defaultDeviceV1, deviceStoreV1Schema } from '../../src/devices/schema.ts';
import { SINGLE_TIMED } from '../fixtures/ics.ts';

function response(
  statusCode: number,
  body: string | string[] = '',
  headers: Record<string, string> = {},
  onDestroy: () => void = () => {},
): CalendarHttpResponse {
  const chunks = Array.isArray(body) ? body : [body];
  return {
    statusCode,
    headers,
    body: (async function* () {
      for (const chunk of chunks) yield Buffer.from(chunk);
    })(),
    destroy: onDestroy,
  };
}

const publicAddress: LookupAddress = { address: '93.184.216.34', family: 4 };

test('calendar URL policy accepts HTTP/HTTPS and rejects schemes and credentials', () => {
  assert.equal(parseCalendarUrl('http://calendar.example/feed.ics').protocol, 'http:');
  assert.equal(parseCalendarUrl('https://calendar.example/feed.ics').protocol, 'https:');
  for (const url of [
    'ftp://calendar.example/feed.ics',
    'file:///etc/passwd',
    'data:text/calendar,BEGIN:VCALENDAR',
    'http://user:password@calendar.example/private.ics',
    'http://?missing-host',
  ]) assert.throws(() => parseCalendarUrl(url), /calendar URL/);
});

test('frozen V1 persistence still accepts historically generic URL schemes', () => {
  const stored = deviceStoreV1Schema.parse({
    schemaVersion: 1,
    devices: [{ ...defaultDeviceV1('panel-v1'), calendarUrls: ['ftp://legacy.example/feed.ics'] }],
  });
  assert.deepEqual(stored.devices[0]?.calendarUrls, ['ftp://legacy.example/feed.ics']);
});

test('address policy blocks non-public IPv4 and IPv6 classes', () => {
  const strict = { allowPrivateNetworks: false };
  for (const address of [
    '127.0.0.1', '0.0.0.0', '169.254.169.254', '100.64.0.1',
    '10.0.0.1', '172.16.0.1', '192.168.1.1', '192.0.2.1', '224.0.0.1',
    '::', '::1', 'fe80::1', 'fc00::1', '2001:db8::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:192.168.1.1',
  ]) assert.equal(isCalendarAddressAllowed(address, strict), false, address);
  assert.equal(isCalendarAddressAllowed('8.8.8.8', strict), true);
  assert.equal(isCalendarAddressAllowed('2606:4700:4700::1111', strict), true);
});

test('private LAN opt-in permits only deliberate private ranges', () => {
  const enabled = { allowPrivateNetworks: true };
  for (const address of ['10.0.0.1', '172.16.1.2', '192.168.1.3', 'fc00::1234']) {
    assert.equal(isCalendarAddressAllowed(address, enabled), true, address);
  }
  for (const address of ['127.0.0.1', '169.254.1.1', '::1', 'fe80::1', 'ff02::1']) {
    assert.equal(isCalendarAddressAllowed(address, enabled), false, address);
  }
  assert.equal(classifyCalendarAddress('::ffff:192.168.1.10'), 'private');
  assert.equal(classifyCalendarAddress('::ffff:127.0.0.1'), 'blocked');
  assert.equal(parseCalendarAllowPrivateNetworks('1'), true);
  for (const value of [undefined, '', '0', 'true', 'yes', ' 1 ']) {
    assert.equal(parseCalendarAllowPrivateNetworks(value), false);
  }
});

test('literal blocked destinations never reach the transport', async () => {
  for (const allowPrivateNetworks of [false, true]) {
    for (const url of [
      'http://127.0.0.1/feed.ics',
      'http://2130706433/feed.ics',
      'http://0x7f000001/feed.ics',
      'http://[::1]/feed.ics',
      'http://169.254.169.254/latest/meta-data',
      'http://[fe80::1]/feed.ics',
      'http://[::ffff:127.0.0.1]/feed.ics',
    ]) {
      let transported = false;
      const fetchText = createCalendarTextFetcher({
        allowPrivateNetworks,
        transport: async () => { transported = true; return response(200, SINGLE_TIMED); },
      });
      await assert.rejects(fetchText(url, new AbortController().signal), /blocked address/);
      assert.equal(transported, false, url);
    }
  }

  const privateCalls: string[] = [];
  const privateFetcher = createCalendarTextFetcher({
    allowPrivateNetworks: true,
    transport: async (url) => { privateCalls.push(url.hostname); return response(200, SINGLE_TIMED); },
  });
  await privateFetcher('http://192.168.1.20/feed.ics', new AbortController().signal);
  assert.deepEqual(privateCalls, ['192.168.1.20']);
});

test('mixed public and private DNS answers fail closed regardless of private opt-in', async () => {
  const answers = [publicAddress, { address: '10.0.0.4', family: 4 }] satisfies LookupAddress[];
  for (const allowPrivateNetworks of [false, true]) {
    let transported = false;
    const fetchText = createCalendarTextFetcher({
      allowPrivateNetworks,
      resolver: async () => answers,
      transport: async () => { transported = true; return response(200, SINGLE_TIMED); },
    });
    await assert.rejects(fetchText('https://calendar.example/secret/token.ics', new AbortController().signal),
      /calendar host calendar\.example resolves across public and private network scopes/);
    assert.equal(transported, false);
  }
});

test('only homogeneous allowed DNS answers are pinned into the request', async () => {
  const publicAnswers = [
    publicAddress,
    { address: '1.1.1.1', family: 4 },
  ] satisfies LookupAddress[];
  const privateAnswers = [
    { address: '192.168.1.10', family: 4 },
    { address: '10.0.0.4', family: 4 },
  ] satisfies LookupAddress[];

  for (const [answers, allowPrivateNetworks] of [
    [publicAnswers, false],
    [privateAnswers, true],
  ] as const) {
    let pinned: readonly LookupAddress[] = [];
    const fetchText = createCalendarTextFetcher({
      allowPrivateNetworks,
      resolver: async () => answers,
      transport: async (_url, addresses) => {
        pinned = addresses;
        return response(200, SINGLE_TIMED);
      },
    });
    assert.equal(
      await fetchText('https://calendar.example/feed.ics', new AbortController().signal),
      SINGLE_TIMED,
    );
    assert.deepEqual(pinned, answers);
  }

  let transported = false;
  const strictPrivate = createCalendarTextFetcher({
    allowPrivateNetworks: false,
    resolver: async () => privateAnswers,
    transport: async () => { transported = true; return response(200, SINGLE_TIMED); },
  });
  await assert.rejects(
    strictPrivate('https://calendar.example/feed.ics', new AbortController().signal),
    /blocked address/,
  );
  assert.equal(transported, false);
});

test('IPv4-mapped private answers cannot bypass homogeneous scope validation', async () => {
  let transported = false;
  const fetchText = createCalendarTextFetcher({
    allowPrivateNetworks: true,
    resolver: async () => [
      { address: '::ffff:192.168.1.10', family: 6 },
      { address: '2606:4700:4700::1111', family: 6 },
    ],
    transport: async () => { transported = true; return response(200, SINGLE_TIMED); },
  });
  await assert.rejects(
    fetchText('https://calendar.example/feed.ics', new AbortController().signal),
    /public and private network scopes/,
  );
  assert.equal(transported, false);
});

test('validated DNS answers are pinned into the request without a second lookup', async () => {
  let resolverCalls = 0;
  let seenAddresses: readonly LookupAddress[] = [];
  const resolver: CalendarResolver = async () => {
    resolverCalls += 1;
    return [publicAddress];
  };
  const transport: CalendarTransport = async (_url, addresses) => {
    seenAddresses = addresses;
    return response(200, SINGLE_TIMED);
  };
  const fetchText = createCalendarTextFetcher({
    allowPrivateNetworks: false, resolver, transport,
  });
  assert.equal(await fetchText('https://calendar.example/private/token.ics', new AbortController().signal), SINGLE_TIMED);
  assert.equal(resolverCalls, 1);
  assert.deepEqual(seenAddresses, [publicAddress]);

  const lookup = createPinnedLookup(seenAddresses) as unknown as (
    host: string,
    options: { all: true },
    callback: (err: Error | null, addresses: LookupAddress[]) => void,
  ) => void;
  const pinned = await new Promise<LookupAddress[]>((resolve, reject) => {
    lookup('calendar.example', { all: true }, (err, addresses) => err ? reject(err) : resolve(addresses));
  });
  assert.deepEqual(pinned, [publicAddress]);
});

test('default transport connects through pinned answers while preserving the original host', async () => {
  let receivedHost = '';
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    receivedHost = req.headers.host ?? '';
    res.end(SINGLE_TIMED);
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const result = await requestPinnedCalendar(
      new URL(`http://calendar.invalid:${port}/private/token.ics`),
      [{ address: '127.0.0.1', family: 4 }],
      new AbortController().signal,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of result.body) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString('utf8'), SINGLE_TIMED);
    assert.equal(receivedHost, `calendar.invalid:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a DNS-rebinding-style second answer cannot replace the pinned public result', async () => {
  const possibleAnswers = [publicAddress, { address: '127.0.0.1', family: 4 } satisfies LookupAddress];
  let resolverCalls = 0;
  const fetchText = createCalendarTextFetcher({
    allowPrivateNetworks: false,
    resolver: async () => [possibleAnswers[resolverCalls++]!],
    transport: async (_url, addresses) => {
      assert.deepEqual(addresses, [publicAddress]);
      return response(200, SINGLE_TIMED);
    },
  });
  await fetchText('https://calendar.example/feed.ics', new AbortController().signal);
  assert.equal(resolverCalls, 1, 'transport receives pinned answers instead of resolving again');
});

test('redirect targets are resolved and independently revalidated', async () => {
  const resolvedHosts: string[] = [];
  const resolver: CalendarResolver = async (hostname) => {
    resolvedHosts.push(hostname);
    if (hostname === 'private.example') return [{ address: '127.0.0.1', family: 4 }];
    return [publicAddress];
  };
  const transport: CalendarTransport = async (url) => {
    if (url.pathname === '/start') return response(302, '', { location: '/middle' });
    if (url.pathname === '/middle') return response(302, '', { location: 'https://second.example/final' });
    return response(200, SINGLE_TIMED);
  };
  const fetchText = createCalendarTextFetcher({ allowPrivateNetworks: false, resolver, transport });
  assert.equal(await fetchText('https://first.example/start', new AbortController().signal), SINGLE_TIMED);
  assert.deepEqual(resolvedHosts, ['first.example', 'first.example', 'second.example']);

  for (const location of ['http://127.0.0.1/', 'http://169.254.169.254/', 'https://private.example/']) {
    let calls = 0;
    const blocked = createCalendarTextFetcher({
      allowPrivateNetworks: false,
      resolver,
      transport: async () => calls++ === 0
        ? response(302, '', { location })
        : response(200, SINGLE_TIMED),
    });
    await assert.rejects(blocked('http://first.example/start', new AbortController().signal), /blocked address/);
    assert.equal(calls, 1, 'blocked redirect target is never connected');
  }
});

test('redirects cannot cross the initial validated network scope', async () => {
  const answers = new Map<string, LookupAddress[]>([
    ['public-one.example', [publicAddress]],
    ['public-two.example', [{ address: '1.1.1.1', family: 4 }]],
    ['private-one.example', [{ address: '192.168.1.10', family: 4 }]],
    ['private-two.example', [{ address: '10.0.0.4', family: 4 }]],
  ]);
  const resolver: CalendarResolver = async (hostname) => answers.get(hostname) ?? [];

  async function follow(from: string, to: string, allowPrivateNetworks: boolean): Promise<{
    result?: string;
    error?: Error;
    connected: string[];
  }> {
    const connected: string[] = [];
    const fetchText = createCalendarTextFetcher({
      allowPrivateNetworks,
      resolver,
      transport: async (url) => {
        connected.push(url.hostname);
        return url.pathname === '/start'
          ? response(302, '', { location: `https://${to}/final` })
          : response(200, SINGLE_TIMED);
      },
    });
    try {
      return {
        result: await fetchText(`https://${from}/start`, new AbortController().signal),
        connected,
      };
    } catch (err) {
      return { error: err as Error, connected };
    }
  }

  for (const [from, to] of [
    ['public-one.example', 'private-one.example'],
    ['private-one.example', 'public-one.example'],
  ] as const) {
    const crossed = await follow(from, to, true);
    assert.match(crossed.error?.message ?? '', /calendar redirect from (public|private) to (private|public)/);
    assert.deepEqual(crossed.connected, [from], 'cross-scope target is validated but never connected');
  }

  for (const [from, to, allowPrivateNetworks] of [
    ['public-one.example', 'public-two.example', false],
    ['private-one.example', 'private-two.example', true],
  ] as const) {
    const sameScope = await follow(from, to, allowPrivateNetworks);
    assert.equal(sameScope.result, SINGLE_TIMED);
    assert.deepEqual(sameScope.connected, [from, to]);
  }
});

test('redirect limit and HTTPS downgrade policy are enforced', async () => {
  const resolver: CalendarResolver = async () => [publicAddress];
  const endless = createCalendarTextFetcher({
    allowPrivateNetworks: false,
    resolver,
    maxRedirects: 3,
    transport: async (url) => response(302, '', { location: `/next-${url.pathname.length}` }),
  });
  await assert.rejects(endless('http://calendar.example/start', new AbortController().signal), /redirect limit/);

  const downgrade = createCalendarTextFetcher({
    allowPrivateNetworks: false,
    resolver,
    transport: async () => response(302, '', { location: 'http://calendar.example/insecure' }),
  });
  await assert.rejects(downgrade('https://calendar.example/start', new AbortController().signal),
    /HTTPS to HTTP redirect/);
});

test('actual streamed bytes are bounded without trusting Content-Length', async () => {
  let destroyed = false;
  const fetchText = createCalendarTextFetcher({
    allowPrivateNetworks: false,
    maxBodyBytes: 8,
    resolver: async () => [publicAddress],
    transport: async () => response(200, ['1234', '5678', '9'], {}, () => { destroyed = true; }),
  });
  await assert.rejects(fetchText('https://calendar.example/secret.ics', new AbortController().signal),
    /exceeded 8 bytes/);
  assert.equal(destroyed, true);
});

test('abort signals stop pending DNS and response streaming work', async () => {
  const dnsController = new AbortController();
  const dnsFetch = createCalendarTextFetcher({
    allowPrivateNetworks: false,
    resolver: async () => new Promise<LookupAddress[]>(() => {}),
    transport: async () => response(200, SINGLE_TIMED),
  });
  const pendingDns = dnsFetch('https://calendar.example/feed.ics', dnsController.signal);
  dnsController.abort();
  await assert.rejects(pendingDns, /calendar fetch aborted/);

  let rejectRead: ((err: Error) => void) | null = null;
  const body: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<Uint8Array>>((_resolve, reject) => {
          rejectRead = reject;
        }),
      };
    },
  };
  const streamController = new AbortController();
  const streamFetch = createCalendarTextFetcher({
    allowPrivateNetworks: false,
    resolver: async () => [publicAddress],
    transport: async () => ({
      statusCode: 200,
      headers: {},
      body,
      destroy: (err?: Error) => rejectRead?.(err ?? new Error('destroyed')),
    }),
  });
  const pendingStream = streamFetch('https://calendar.example/feed.ics', streamController.signal);
  await new Promise((resolve) => setImmediate(resolve));
  streamController.abort();
  await assert.rejects(pendingStream, /calendar fetch aborted/);
});

test('normal errors reveal only the calendar hostname, never secret path/query values', async () => {
  const secret = 'private-secret-token';
  const fetchText = createCalendarTextFetcher({
    allowPrivateNetworks: false,
    resolver: async () => [publicAddress],
    transport: async () => response(500),
  });
  await assert.rejects(
    fetchText(`https://calendar.example/${secret}/basic.ics?key=${secret}`, new AbortController().signal),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /calendar\.example/);
      assert.doesNotMatch(message, new RegExp(secret));
      return true;
    },
  );
});
