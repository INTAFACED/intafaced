import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import type { CurrentAuthorityInput } from '@intafaced/contracts';
import { streamTokenAudience } from '@intafaced/contracts/stream-token';
import type { LiveCredentialPort } from './live-credential.js';
import { eligibleAuthority } from '../test-support/authority.js';
import type { CurrentAuthorityPort } from './authority.js';
import { PrivateOrderHub } from './hub.js';
import {
  CLOSE_UNAUTHORIZED,
  createPrivateWebSocketGateway,
  PRIVATE_CHANNEL_NOT_OPEN,
  PRIVATE_STREAM_PATH,
  PRIVATE_SUBSCRIBE_CHANNELS_REQUIRED,
  privateSubscribeReply,
  TOKEN_EXPIRED_CODE,
  verifyStreamSeatToken,
  type PrivateWebSocketGateway,
} from './gateway.js';

// J-developer-09 #2 at the private door: a short-lived stream token (an access token cut from an API key's exchange,
// carrying its `kid`) is subscribed; at its end the stream names `ws.token_expired`; a new connection with the spent
// token is refused by that code; a fresh token works; a revoked key's token is refused and its open stream dropped.

const SECRET = 'test-access-secret-at-least-32-chars!!';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const tokens: TokenConfig = { secret: SECRET, issuer: 'intafaced', audience: 'intafaced.api', accessTtlSeconds: 900 };

/** Identity's current authority as the lease reads it: eligible until the key is revoked. */
function keyAuthority(): CurrentAuthorityPort & { revoked: boolean } {
  const state = { revoked: false };
  return {
    get revoked() {
      return state.revoked;
    },
    set revoked(v: boolean) {
      state.revoked = v;
    },
    async read(subject: CurrentAuthorityInput) {
      if (state.revoked && subject.credential.kind === 'api_key') throw new Error('auth.api_key_revoked');
      return eligibleAuthority(subject);
    },
  };
}

type Seat = { ws: WebSocket; frames: Array<Record<string, unknown>>; closed: { code: number; reason: string } | null };

describe('private stream with a short-lived stream token', () => {
  let server: Server;
  let gateway: PrivateWebSocketGateway;
  let port = 0;

  afterEach(async () => {
    await gateway?.close('test done');
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function boot(authority: CurrentAuthorityPort, liveCredential?: LiveCredentialPort): Promise<void> {
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 });
    server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    port = addr.port;
    gateway = createPrivateWebSocketGateway({
      authority,
      server,
      hub,
      heartbeatMs: 60_000,
      log: { info: () => undefined, warn: () => undefined },
      enabled: () => true,
      tokens,
      ...(liveCredential ? { liveCredential } : {}),
    });
  }

  /** A stream token as identity mints it: the key's claims, the stream audience, a short life. */
  async function streamToken(seconds: number): Promise<{ token: string; expiresAt: Date }> {
    return issueAccessToken(
      { userId: USER, sessionId: SESSION, scopes: ['trade:read'], apiKeyId: KEY, keyEnv: 'live' },
      { ...tokens, audience: streamTokenAudience(tokens.audience), accessTtlSeconds: seconds },
    );
  }

  /** An access token cut from the key for the platform audience (what the edge's exchange makes internally). */
  async function platformKeyToken(): Promise<string> {
    return (await issueAccessToken({ userId: USER, sessionId: SESSION, scopes: ['trade:read'], apiKeyId: KEY, keyEnv: 'live' }, tokens))
      .token;
  }

  function connect(token: string): Seat {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${PRIVATE_STREAM_PATH}?access_token=${encodeURIComponent(token)}&channel=orders`);
    const seat: Seat = { ws, frames: [], closed: null };
    ws.on('message', (data) => seat.frames.push(JSON.parse(data.toString()) as Record<string, unknown>));
    ws.on('close', (code, reason) => {
      seat.closed = { code, reason: reason.toString() };
    });
    ws.on('error', () => undefined);
    return seat;
  }

  /** Waits for an outcome on the socket (a frame or the close), up to `ms`. */
  async function until(check: () => boolean, ms = 5_000): Promise<void> {
    await vi.waitFor(
      () => {
        if (!check()) throw new Error('not yet');
      },
      { timeout: ms, interval: 20 },
    );
  }

  async function subscribed(token: string, id: string): Promise<Seat> {
    const seat = connect(token);
    await new Promise<void>((resolve, reject) => {
      seat.ws.once('open', () => resolve());
      seat.ws.once('close', () => reject(new Error('closed before open')));
    });
    seat.ws.send(JSON.stringify({ op: 'subscribe', id, channels: [{ ch: 'orders' }] }));
    await until(() => seat.frames.some((f) => f.op === 'ack' && f.id === id));
    return seat;
  }

  /** The raw HTTP answer to an upgrade: its status and body. */
  function upgrade(token: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: `${PRIVATE_STREAM_PATH}?access_token=${encodeURIComponent(token)}&channel=orders`,
          method: 'GET',
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('upgrade', (_res, socket) => {
        socket.destroy();
        resolve({ status: 101, body: '' });
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('acks a subscribe, names ws.token_expired at the end, refuses the spent token by that code, and a fresh token works', async () => {
    await boot(keyAuthority());
    const first = await streamToken(2);
    const live = await subscribed(first.token, 'sub-1');
    const ack = live.frames.find((f) => f.op === 'ack')!;
    expect(ack).toMatchObject({ op: 'ack', for: 'subscribe', id: 'sub-1', channels: [{ ch: 'orders' }] });
    expect(typeof ack.receivedAt).toBe('number');
    expect(ack.receivedAt as number).toBeLessThanOrEqual(ack.sentAt as number);

    // The end of the token's lifetime: an error frame by the typed code, then the 4003 close.
    await until(() => live.closed !== null, Math.max(0, first.expiresAt.getTime() - Date.now()) + 3_000);
    expect(live.frames.some((f) => f.type === 'error' && f.code === TOKEN_EXPIRED_CODE)).toBe(true);
    expect(live.closed!.code).toBe(CLOSE_UNAUTHORIZED);

    // The spent token: refused before the upgrade, naming the code.
    const spent = await upgrade(first.token);
    expect(spent.status).toBe(401);
    expect(JSON.parse(spent.body)).toEqual({ code: TOKEN_EXPIRED_CODE });

    // A fresh token works again.
    const again = await subscribed((await streamToken(30)).token, 'sub-2');
    expect(again.ws.readyState).toBe(WebSocket.OPEN);
    again.ws.close();
  }, 15_000);

  it("refuses a revoked key's stream token and drops its open stream, without naming expiry", async () => {
    const authority = keyAuthority();
    await boot(authority);
    const { token } = await streamToken(60);
    const live = await subscribed(token, 'sub-r');

    authority.revoked = true;
    // The lease re-reads identity's authority within its five-second window; a refused read ends the seat.
    await until(() => live.closed !== null, 7_000);
    expect(live.frames.some((f) => f.code === TOKEN_EXPIRED_CODE)).toBe(false);

    const refused = await upgrade(token);
    expect(refused.status).toBe(401);
    expect(refused.body).not.toContain(TOKEN_EXPIRED_CODE);
  }, 15_000);

  it("a signing key's stream token opens the stream; the same key's platform token is still refused", async () => {
    // The key signs every request. A stream token could only be minted through a signed request, so it passes the
    // signed-key belt; a platform token cut from the same key never does.
    const signingKey: LiveCredentialPort = {
      async getSession() {
        return null;
      },
      async getApiKey() {
        return { id: KEY, userId: USER, revoked: false, requireSignature: true };
      },
    };
    await boot(keyAuthority(), signingKey);
    expect((await upgrade(await platformKeyToken())).status).toBe(401);
    const live = await subscribed((await streamToken(30)).token, 'sub-s');
    expect(live.ws.readyState).toBe(WebSocket.OPEN);
    live.ws.close();
  });

  it('a bad token is refused without a code: only a spent one is named', async () => {
    await boot(keyAuthority());
    const refused = await upgrade('not-a-jwt');
    expect(refused).toEqual({ status: 401, body: '' });
  });
});

describe('verifyStreamSeatToken', () => {
  it('takes a platform token as one and a stream token as one, and refuses a token for any other audience', async () => {
    const issue = (audience: string, accessTtlSeconds = 60) =>
      issueAccessToken(
        { userId: USER, sessionId: SESSION, scopes: ['trade:read'], apiKeyId: KEY },
        { ...tokens, audience, accessTtlSeconds },
      );
    expect((await verifyStreamSeatToken((await issue(tokens.audience)).token, tokens)).stream).toBe(false);
    expect((await verifyStreamSeatToken((await issue(streamTokenAudience(tokens.audience))).token, tokens)).stream).toBe(true);
    await expect(verifyStreamSeatToken((await issue('somewhere.else')).token, tokens)).rejects.toMatchObject({ code: 'token.invalid' });
  });
});

describe('privateSubscribeReply', () => {
  const times = { receivedAt: 1, sentAt: 2 };

  it('acks only channels the connection already carries', () => {
    expect(
      JSON.parse(privateSubscribeReply(JSON.stringify({ op: 'subscribe', id: 'a', channels: [{ ch: 'orders' }] }), ['orders'], times)!),
    ).toEqual({
      op: 'ack',
      for: 'subscribe',
      id: 'a',
      channels: [{ ch: 'orders' }],
      receivedAt: 1,
      sentAt: 2,
    });
    expect(
      JSON.parse(privateSubscribeReply(JSON.stringify({ op: 'subscribe', id: 'b', channels: [{ ch: 'fills' }] }), ['orders'], times)!),
    ).toMatchObject({
      op: 'error',
      id: 'b',
      code: PRIVATE_CHANNEL_NOT_OPEN,
    });
    expect(JSON.parse(privateSubscribeReply(JSON.stringify({ op: 'subscribe', id: 'c', channels: [] }), ['orders'], times)!)).toMatchObject(
      {
        code: PRIVATE_SUBSCRIBE_CHANNELS_REQUIRED,
      },
    );
  });

  it('leaves every other text alone, including the positions op', () => {
    expect(privateSubscribeReply('not json', ['orders'], times)).toBeNull();
    expect(privateSubscribeReply(JSON.stringify({ op: 'subscribe', channel: 'positions' }), ['positions'], times)).toBeNull();
    expect(privateSubscribeReply(JSON.stringify({ op: 'cod.arm' }), ['orders'], times)).toBeNull();
  });
});
