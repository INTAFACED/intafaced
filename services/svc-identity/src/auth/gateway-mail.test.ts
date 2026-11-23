import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GATEWAY_MAIL_TRANSPORT, MailTransportRefused, gatewayMailContent } from './gateway-mail.js';
import { openIdentityMail } from './local-mail.js';

type Seen = { method: string; auth: string | undefined; type: string | undefined; body: Record<string, string> };

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** A fake mail gateway on loopback: records each request and answers `status`. */
async function fakeGateway(status: number): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', auth: req.headers.authorization, type: req.headers['content-type'], body: JSON.parse(raw) });
      res.writeHead(status, { 'content-type': 'application/json' }).end('{"echo":"never read"}');
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/send`, seen };
}

const settings = (url: string) => ({
  url,
  key: 'gateway-test-key',
  from: 'no-reply@example.com',
  linkBase: 'https://app.example.com',
  consoleLinkBase: undefined,
});

describe('http-gateway mail transport', () => {
  it('sends the sign-up code through the gateway: one JSON POST with the bearer key', async () => {
    const gw = await fakeGateway(202);
    const mail = openIdentityMail({ appEnv: 'test', transport: GATEWAY_MAIL_TRANSPORT, outboxPath: undefined, gateway: settings(gw.url) });
    await mail!.send({
      email: ' person@example.com ',
      code: '482913',
      expiresAt: new Date('2026-11-24T10:00:00.000Z'),
      purpose: 'signup-code',
    });
    expect(gw.seen).toHaveLength(1);
    const [req] = gw.seen;
    expect(req!.method).toBe('POST');
    expect(req!.auth).toBe('Bearer gateway-test-key');
    expect(req!.type).toBe('application/json');
    expect(req!.body).toEqual({
      from: 'no-reply@example.com',
      to: 'person@example.com',
      subject: 'Your INTAFACED sign-up code',
      text: 'Valid until: 2026-11-24T10:00:00.000Z\nYour code: 482913\n\nIf you did not ask for this, you can ignore this mail.\n',
    });
  });

  it('throws on a refused handoff, naming the status and never the code or the key', async () => {
    const gw = await fakeGateway(500);
    const mail = openIdentityMail({ appEnv: 'test', transport: GATEWAY_MAIL_TRANSPORT, outboxPath: undefined, gateway: settings(gw.url) });
    const sent = mail!.send({ email: 'p@example.com', code: '111222', expiresAt: new Date(), purpose: 'login-code' });
    await expect(sent).rejects.toThrow('auth.mail_gateway_failed: the mail gateway answered 500');
    await sent.catch((err: Error) => {
      expect(err.message).not.toContain('111222');
      expect(err.message).not.toContain('gateway-test-key');
    });
  });

  it('throws when the gateway cannot be reached', async () => {
    const gw = await fakeGateway(200);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const mail = openIdentityMail({ appEnv: 'test', transport: GATEWAY_MAIL_TRANSPORT, outboxPath: undefined, gateway: settings(gw.url) });
    await expect(mail!.send({ email: 'p@example.com', code: '1', expiresAt: new Date(), purpose: 'login-code' })).rejects.toThrow(
      'auth.mail_gateway_failed: the mail gateway could not be reached',
    );
  });

  it('makes each link whole under the app address, freeze link and anti-phishing code included', () => {
    const content = gatewayMailContent(
      {
        email: 'p@example.com',
        code: 'tok/en',
        expiresAt: new Date('2026-11-24T10:00:00.000Z'),
        purpose: 'password-changed',
        freezeToken: 'fz',
        antiPhishingCode: 'Blue42',
      },
      { app: new URL('https://app.example.com/beta'), console: undefined },
    );
    expect(content.text).toContain('This was not me — freeze my account: https://app.example.com/beta/freeze/confirm#token=fz');
    expect(content.text).toContain('Your anti-phishing code: Blue42');
    const reset = gatewayMailContent(
      { email: 'p@example.com', code: 'tok/en', expiresAt: new Date(), purpose: 'password-reset' },
      { app: new URL('https://app.example.com'), console: undefined },
    );
    expect(reset.text).toContain('Open: https://app.example.com/completePasswordReset?code=tok%2Fen');
  });

  it('keeps a username’s underscores as written, and turns only word-joining underscores into spaces', () => {
    const app = { app: new URL('https://app.example.com'), console: undefined };
    const recovery = gatewayMailContent(
      { email: 'p@example.com', code: '', expiresAt: new Date(), purpose: 'handle-recovery', handle: 'john_doe' },
      app,
    );
    expect(recovery.text).toContain('Your username: john_doe\n');
    const factor = gatewayMailContent(
      { email: 'p@example.com', code: '', expiresAt: new Date(), purpose: 'factor-changed', detail: 'totp_added' },
      app,
    );
    expect(factor.text).toContain('change: totp added\n');
  });

  it('refuses a staff invite with no console address rather than linking to the app', () => {
    expect(() =>
      gatewayMailContent(
        { email: 's@example.com', code: 't', expiresAt: new Date(), purpose: 'staff-invite' },
        { app: new URL('https://app.example.com'), console: undefined },
      ),
    ).toThrow(MailTransportRefused);
  });
});

describe('mail transport at boot', () => {
  it('refuses a staging or prod start with no transport, with a typed error naming the setting', () => {
    for (const appEnv of ['staging', 'prod', 'production']) {
      let caught: unknown;
      try {
        openIdentityMail({ appEnv, transport: undefined, outboxPath: undefined });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MailTransportRefused);
      expect((caught as MailTransportRefused).code).toBe('auth.mail_transport_refused');
      expect((caught as MailTransportRefused).setting).toBe('IDENTITY_MAIL_TRANSPORT');
    }
  });

  it('leaves dev and test unwired with no transport, as before', () => {
    expect(openIdentityMail({ appEnv: 'dev', transport: undefined, outboxPath: undefined })).toBeUndefined();
    expect(openIdentityMail({ appEnv: 'test', transport: ' ', outboxPath: undefined })).toBeUndefined();
  });

  it('refuses a gateway start missing any setting, naming which', () => {
    const full = settings('https://mail.example.com/send');
    const cases: Array<[Partial<typeof full>, string]> = [
      [{ url: undefined }, 'IDENTITY_MAIL_GATEWAY_URL'],
      [{ url: 'not a url' }, 'IDENTITY_MAIL_GATEWAY_URL'],
      [{ url: 'http://mail.example.com/send' }, 'IDENTITY_MAIL_GATEWAY_URL'],
      [{ url: 'https://user:pw@mail.example.com/send' }, 'IDENTITY_MAIL_GATEWAY_URL'],
      [{ key: ' ' }, 'IDENTITY_MAIL_GATEWAY_KEY'],
      [{ from: 'not-an-address' }, 'IDENTITY_MAIL_FROM'],
      [{ linkBase: undefined }, 'IDENTITY_MAIL_LINK_BASE'],
      [{ linkBase: 'http://app.example.com' }, 'IDENTITY_MAIL_LINK_BASE'],
    ];
    for (const [change, setting] of cases) {
      expect(() =>
        openIdentityMail({ appEnv: 'staging', transport: GATEWAY_MAIL_TRANSPORT, outboxPath: undefined, gateway: { ...full, ...change } }),
      ).toThrow(setting);
    }
    expect(openIdentityMail({ appEnv: 'staging', transport: GATEWAY_MAIL_TRANSPORT, outboxPath: undefined, gateway: full })).toBeDefined();
  });

  it('keeps the local outbox refused on staging', () => {
    expect(() => openIdentityMail({ appEnv: 'staging', transport: 'local-outbox', outboxPath: '/tmp/x.log' })).toThrow(
      'local-outbox is allowed only when APP_ENV is exactly dev or test',
    );
  });
});
