import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { pinnedPost } from './webhook-pinned-post.js';
import {
  assertPublicWebhookUrl,
  isPublicIpAddress,
  resolvePublicAddress,
  resolvePublicAddresses,
  type WebhookResolver,
} from './webhook-url-guard.js';

/** Throws `pay.webhook_url_invalid` — and says nothing was attempted. */
function refused(url: string, opts: { allowLocalHttp?: boolean } = {}): void {
  try {
    assertPublicWebhookUrl(url, opts);
  } catch (err) {
    expect(err).toMatchObject({ code: 'pay.webhook_url_invalid' });
    expect((err as Error).message).toContain('NOTHING WAS ATTEMPTED');
    return;
  }
  expect.unreachable(`${url} should have been refused`);
}

describe('assertPublicWebhookUrl — syntax (SSRF)', () => {
  it('accepts public https receivers', () => {
    for (const url of [
      'https://merchant.example/hooks/pay',
      'https://hooks.shop.example.com:8443/a?b=c',
      'https://8.8.8.8/hook',
      'https://[2606:4700:4700::1111]/hook',
      'https://MERCHANT.example./hook',
    ]) {
      expect(() => assertPublicWebhookUrl(url)).not.toThrow();
    }
  });

  const privateLiterals: Array<[string, string]> = [
    ['loopback', 'https://127.0.0.1/hook'],
    ['loopback /8', 'https://127.1.2.3/hook'],
    ['loopback short form', 'https://127.1/hook'],
    ['10/8', 'https://10.0.0.5/hook'],
    ['172.16/12 low', 'https://172.16.0.1/hook'],
    ['172.16/12 high', 'https://172.31.255.255/hook'],
    ['192.168/16', 'https://192.168.1.1/hook'],
    ['cloud metadata', 'https://169.254.169.254/latest/meta-data/'],
    ['link-local', 'https://169.254.1.1/hook'],
    ['CGNAT 100.64/10', 'https://100.64.0.1/hook'],
    ['CGNAT top', 'https://100.127.255.254/hook'],
    ['unspecified', 'https://0.0.0.0/hook'],
    ['this-network', 'https://0.1.2.3/hook'],
    ['multicast', 'https://224.0.0.1/hook'],
    ['reserved 240/4', 'https://240.0.0.1/hook'],
    ['broadcast', 'https://255.255.255.255/hook'],
    ['TEST-NET-1', 'https://192.0.2.1/hook'],
    ['benchmarking 198.18/15', 'https://198.19.0.1/hook'],
    ['decimal spelling of 127.0.0.1', 'https://2130706433/hook'],
    ['decimal spelling of 169.254.169.254', 'https://2852039166/hook'],
    ['hex spelling of 127.0.0.1', 'https://0x7f000001/hook'],
    ['dotted hex spelling', 'https://0x7f.0x0.0x0.0x1/hook'],
    ['octal spelling of 127.0.0.1', 'https://0177.0.0.1/hook'],
    ['octal spelling of 10.0.0.1', 'https://012.0.0.1/hook'],
    ['IPv6 loopback', 'https://[::1]/hook'],
    ['IPv6 unspecified', 'https://[::]/hook'],
    ['IPv6 ULA fc00::/7', 'https://[fc00::1]/hook'],
    ['IPv6 ULA fd', 'https://[fd12:3456:789a::1]/hook'],
    ['IPv6 link-local', 'https://[fe80::1]/hook'],
    ['IPv6 multicast', 'https://[ff02::1]/hook'],
    ['IPv4-mapped loopback', 'https://[::ffff:127.0.0.1]/hook'],
    ['IPv4-mapped metadata', 'https://[::ffff:169.254.169.254]/hook'],
    ['IPv4-mapped 10/8 (hex form)', 'https://[::ffff:a00:1]/hook'],
    ['NAT64 of 10.0.0.1', 'https://[64:ff9b::a00:1]/hook'],
    ['NAT64 of metadata, dotted', 'https://[64:ff9b::169.254.169.254]/hook'],
    ['6to4 of 127.0.0.1', 'https://[2002:7f00:1::1]/hook'],
    ['IPv4-compatible ::a.b.c.d', 'https://[::7f00:1]/hook'],
    ['documentation 2001:db8::/32', 'https://[2001:db8::1]/hook'],
  ];
  it.each(privateLiterals)('refuses %s', (_label, url) => refused(url));

  const internalNames: Array<[string, string]> = [
    ['localhost', 'https://localhost/hook'],
    ['localhost trailing dot', 'https://localhost./hook'],
    ['sub.localhost', 'https://app.localhost/hook'],
    ['svc-ledger', 'https://svc-ledger/hook'],
    ['svc-ledger with port', 'https://svc-ledger:4001/hook'],
    ['svc- prefix', 'https://svc-identity.example.com/hook'],
    ['postgres', 'https://postgres/hook'],
    ['nats', 'https://nats/hook'],
    ['redis', 'https://redis/hook'],
    ['single label', 'https://intranet-box/hook'],
    ['.internal', 'https://metadata.google.internal/hook'],
    ['.local', 'https://printer.local/hook'],
    ['.lan', 'https://nas.lan/hook'],
    ['.home', 'https://router.home/hook'],
    ['.corp', 'https://wiki.corp/hook'],
    ['.intranet', 'https://wiki.intranet/hook'],
    ['.localdomain', 'https://host.localdomain/hook'],
    ['k8s .svc', 'https://svc-ledger.default.svc/hook'],
    ['k8s cluster.local', 'https://svc-ledger.default.svc.cluster.local/hook'],
    ['.internal with trailing dot', 'https://a.internal./hook'],
  ];
  it.each(internalNames)('refuses internal name: %s', (_label, url) => refused(url));

  it('refuses http, credentials, bad URLs and non-URLs', () => {
    refused('http://merchant.example/hook');
    refused('http://8.8.8.8/hook');
    refused('ftp://merchant.example/hook');
    refused('https://user:pw@merchant.example/hook');
    refused('https://user@merchant.example/hook');
    refused('not a url');
    refused('/relative/path');
    refused('');
    refused('javascript:alert(1)');
  });

  it('port rule: 443 and >=1024 are fine; infra ports and low ports are refused', () => {
    expect(() => assertPublicWebhookUrl('https://merchant.example:443/h')).not.toThrow();
    expect(() => assertPublicWebhookUrl('https://merchant.example:1024/h')).not.toThrow();
    expect(() => assertPublicWebhookUrl('https://merchant.example:8443/h')).not.toThrow();
    for (const port of [5432, 6379, 4222, 8222, 9090, 3100, 22, 25, 80, 1023]) {
      refused(`https://merchant.example:${port}/hook`);
    }
  });

  it('http + localhost is accepted ONLY with allowLocalHttp; production posture refuses it', () => {
    for (const url of ['http://localhost:4000/h', 'http://127.0.0.1:4000/h', 'http://[::1]:4000/h', 'https://localhost:4000/h']) {
      expect(() => assertPublicWebhookUrl(url, { allowLocalHttp: true })).not.toThrow();
      refused(url);
      refused(url, { allowLocalHttp: false });
    }
  });

  it('allowLocalHttp admits loopback only — not other private ranges, not http to a public host', () => {
    refused('http://10.0.0.1/h', { allowLocalHttp: true });
    refused('https://10.0.0.1/h', { allowLocalHttp: true });
    refused('https://169.254.169.254/h', { allowLocalHttp: true });
    refused('http://merchant.example/h', { allowLocalHttp: true });
    refused('https://svc-ledger/h', { allowLocalHttp: true });
  });
});

describe('isPublicIpAddress', () => {
  it('classifies representative addresses', () => {
    expect(isPublicIpAddress('8.8.8.8')).toBe(true);
    expect(isPublicIpAddress('1.1.1.1')).toBe(true);
    expect(isPublicIpAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicIpAddress('::ffff:8.8.8.8')).toBe(true);
    expect(isPublicIpAddress('127.0.0.1')).toBe(false);
    expect(isPublicIpAddress('127.0.0.1', { allowLoopback: true })).toBe(true);
    expect(isPublicIpAddress('::1', { allowLoopback: true })).toBe(true);
    expect(isPublicIpAddress('10.0.0.1', { allowLoopback: true })).toBe(false);
    expect(isPublicIpAddress('not-an-ip')).toBe(false);
    expect(isPublicIpAddress('')).toBe(false);
  });
});

describe('resolvePublicAddress — DNS', () => {
  const answers = (...addrs: string[]): WebhookResolver => {
    return async () => addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };

  it('returns the vetted public address', async () => {
    await expect(resolvePublicAddress('merchant.example', answers('93.184.216.34'))).resolves.toEqual({
      address: '93.184.216.34',
      family: 4,
    });
    await expect(resolvePublicAddress('merchant.example', answers('2606:4700:4700::1111'))).resolves.toEqual({
      address: '2606:4700:4700::1111',
      family: 6,
    });
  });

  it('refuses when ANY answer is private, even if the first is public', async () => {
    for (const bad of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
      await expect(resolvePublicAddress('merchant.example', answers('93.184.216.34', bad))).rejects.toMatchObject({
        code: 'pay.webhook_url_invalid',
      });
      await expect(resolvePublicAddress('merchant.example', answers(bad, '93.184.216.34'))).rejects.toMatchObject({
        code: 'pay.webhook_url_invalid',
      });
    }
  });

  it('fails closed on a resolver error or an empty answer', async () => {
    const boom: WebhookResolver = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(resolvePublicAddress('merchant.example', boom)).rejects.toMatchObject({ code: 'pay.webhook_url_invalid' });
    await expect(resolvePublicAddress('merchant.example', answers())).rejects.toMatchObject({ code: 'pay.webhook_url_invalid' });
  });

  it('vets an IP literal without asking DNS', async () => {
    const never: WebhookResolver = async () => {
      throw new Error('resolver must not be called for a literal');
    };
    await expect(resolvePublicAddress('8.8.8.8', never)).resolves.toEqual({ address: '8.8.8.8', family: 4 });
    await expect(resolvePublicAddress('[::1]', never)).rejects.toMatchObject({ code: 'pay.webhook_url_invalid' });
  });

  it('allowLoopback admits loopback answers only', async () => {
    await expect(resolvePublicAddress('localhost', answers('127.0.0.1'), { allowLoopback: true })).resolves.toMatchObject({
      address: '127.0.0.1',
    });
    await expect(resolvePublicAddress('localhost', answers('127.0.0.1'))).rejects.toBeTruthy();
    await expect(resolvePublicAddress('x.example', answers('10.0.0.1'), { allowLoopback: true })).rejects.toBeTruthy();
  });
});

describe('resolvePublicAddresses — all vetted candidates, in connect order', () => {
  const answers = (...addrs: string[]): WebhookResolver => {
    return async () => addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };

  it('returns every vetted address, alternating families starting with the first answer', async () => {
    await expect(
      resolvePublicAddresses('m.example', answers('2606:4700:4700::1111', '93.184.216.34', '8.8.8.8', '2606:4700:4700::1001')),
    ).resolves.toEqual([
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1001', family: 6 },
      { address: '8.8.8.8', family: 4 },
    ]);
    await expect(resolvePublicAddresses('m.example', answers('93.184.216.34', '8.8.8.8'))).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '8.8.8.8', family: 4 },
    ]);
  });

  it('still refuses the whole set when any answer is private', async () => {
    await expect(resolvePublicAddresses('m.example', answers('93.184.216.34', '2606:4700:4700::1111', '10.0.0.1'))).rejects.toMatchObject({
      code: 'pay.webhook_url_invalid',
    });
  });
});

describe('pinnedPost — connect uses the vetted address', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it('connects to the pinned IP even though the hostname resolves nowhere, and sends the original Host', async () => {
    let seenHost = '';
    server = createServer((req, res) => {
      seenHost = String(req.headers.host);
      res.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');

    // `pinned.invalid` can never resolve (RFC 6761): reaching the server proves the
    // socket went to the vetted address and no DNS lookup of the name happened.
    const res = await pinnedPost({
      url: new URL(`http://pinned.invalid:${addr.port}/hook`),
      addresses: [{ address: '127.0.0.1', family: 4 }],
      headers: { 'content-type': 'application/json' },
      body: '{}',
      timeoutMs: 5_000,
    });
    expect(res.status).toBe(204);
    expect(seenHost).toBe(`pinned.invalid:${addr.port}`);
  });

  it('does not follow a 302 and does not read past the headers', async () => {
    let metadataHits = 0;
    server = createServer((_req, res) => {
      metadataHits += 1;
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const res = await pinnedPost({
      url: new URL(`http://127.0.0.1:${addr.port}/hook`),
      addresses: [{ address: '127.0.0.1', family: 4 }],
      headers: {},
      body: '{}',
      timeoutMs: 5_000,
    });
    expect(res.status).toBe(302);
    expect(metadataHits).toBe(1);
  });

  it('times out instead of hanging on a receiver that never answers', async () => {
    server = createServer(() => {
      /* never respond */
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    await expect(
      pinnedPost({
        url: new URL(`http://127.0.0.1:${addr.port}/hook`),
        addresses: [{ address: '127.0.0.1', family: 4 }],
        headers: {},
        body: '{}',
        timeoutMs: 100,
      }),
    ).rejects.toBeTruthy();
    server.closeAllConnections();
  });

  it('tries the next vetted address when the connect is refused, never an address it was not given', async () => {
    let hits = 0;
    server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    // ::1 refuses (nothing listens on the IPv6 loopback; hosts without IPv6 fail with a
    // connect-level error too); the second candidate answers.
    const res = await pinnedPost({
      url: new URL(`http://pinned.invalid:${addr.port}/hook`),
      addresses: [
        { address: '::1', family: 6 },
        { address: '127.0.0.1', family: 4 },
      ],
      headers: {},
      body: '{}',
      timeoutMs: 5_000,
    });
    expect(res.status).toBe(204);
    expect(hits).toBe(1);
  });

  it('rejects when every vetted address refuses the connect', async () => {
    server = createServer();
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const port = addr.port;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await expect(
      pinnedPost({
        url: new URL(`http://pinned.invalid:${port}/hook`),
        addresses: [
          { address: '127.0.0.1', family: 4 },
          { address: '::1', family: 6 },
        ],
        headers: {},
        body: '{}',
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/ECONNREFUSED|EADDRNOTAVAIL|ENETUNREACH|EHOSTUNREACH/) });
  });

  it('never moves to the next address after an HTTP response', async () => {
    let hits = 0;
    server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(500).end();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const res = await pinnedPost({
      url: new URL(`http://127.0.0.1:${addr.port}/hook`),
      addresses: [
        { address: '127.0.0.1', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      headers: {},
      body: '{}',
      timeoutMs: 5_000,
    });
    expect(res.status).toBe(500);
    expect(hits).toBe(1);
  });
});
