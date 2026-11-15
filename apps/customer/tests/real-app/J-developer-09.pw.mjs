// World: restart
import net from 'node:net';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { ORIGIN, restartWith } from './stack.mjs';
import { keyHolder, makeKey, withKey } from './developer.mjs';

// J-developer-09, in the running app (docs/roadmap/journeys.json): stream live data. One test per step, titled
// "J-developer-09 #<n>", written by an independent test-writer from the step's own words (OWNER 212); the builder makes
// them pass and may not weaken them. The streams are svc-ws on the local stack, reached as a developer's program reaches
// them: a WebSocket straight to the stream service (port 14523), from this machine's own addresses. The client is a
// small one written here, so a step can choose not to answer pings, and can leave from 127.0.0.x (CI runs on Linux,
// where every 127.x address is the machine's own) so the per-IP cap in #6 counts only this test's connections.
//
// Names this file asks the product for, where main has nothing yet (the builder implements them as written):
// - /developers/websocket: heading "WebSocket streams"; table "Stream endpoints", one row per endpoint
//   (data-endpoint="public" | "private" | "business"), each with a list of hosts whose items carry
//   data-role="primary" | "failover" and data-host-state="set" | "unset" (a set host in <code>, else "host not set");
//   table "Choosing a protocol", each row with a cell data-module="<owning module>" reading "Owned by <module>"; the
//   ping interval in developers-websocket-ping-interval (data-seconds); and the sentence "Unknown message types are
//   ignored."
// - a short-lived stream token: POST /api/v1/stream/token with the key, answering { token, expiresAt } (the stack's
//   TEST lifetime is at most 60 seconds); the private stream takes it as ?access_token=; on expiry the stream says
//   ws.token_expired (an error frame or the close reason), and a new connection with the spent token is refused so.
// - every ack carries the server's times: receivedAt and sentAt, epoch milliseconds.
// - the per-IP connection cap and the storm ban, published on svc-ws GET /policy as
//   perIp { maxConnections, stormsBeforeBan, banSeconds } (banSeconds null when blank); an extra connection closes with
//   reason ws.per_ip_cap, a banned address with ws.ip_banned; the ban time is the stack setting
//   LOCAL_STACK_WS_IP_BAN_SECONDS ("off" is blank), and while it is blank /policy says perIp.ban "unset" and the
//   endpoints page says "No ban time is set, so no address is banned."
const J = 'J-developer-09';
const WS_PORT = 14523;
const MARKET = 'BTC/USDT';
// A part main does not have yet fails at its first look, not after the default wait.
const UNBUILT = { timeout: 10_000 };

test.describe.configure({ mode: 'default' });

/**
 * One WebSocket connection, from `localAddress`. It answers pings unless told not to; it keeps every text frame
 * (parsed), every ping time, and the server's close code and reason.
 */
function connect(path, { localAddress, answerPings = true } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: WS_PORT, ...(localAddress ? { localAddress } : {}) });
    const conn = { status: null, body: '', frames: [], pings: [], closed: null, endedAt: null, openedAt: Date.now(), answerPings };
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const frame = (op, data = Buffer.alloc(0)) => {
      const mask = randomBytes(4);
      const len = data.length;
      let head;
      if (len < 126) head = Buffer.from([0x80 | op, 0x80 | len]);
      else if (len < 65536) {
        head = Buffer.alloc(4);
        head[0] = 0x80 | op;
        head[1] = 0x80 | 126;
        head.writeUInt16BE(len, 2);
      } else {
        head = Buffer.alloc(10);
        head[0] = 0x80 | op;
        head[1] = 0x80 | 127;
        head.writeBigUInt64BE(BigInt(len), 2);
      }
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
      if (!sock.destroyed) sock.write(Buffer.concat([head, mask, masked]));
    };
    conn.send = (value) => frame(1, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
    conn.drop = () => sock.destroy();
    conn.isOpen = () => conn.status === 101 && conn.endedAt === null && conn.closed === null;
    sock.on('connect', () => {
      sock.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${WS_PORT}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
          'Sec-WebSocket-Version: 13',
          `Origin: ${ORIGIN}`,
          '',
          '',
        ].join('\r\n'),
      );
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        conn.status = Number(buf.subarray(0, end).toString().split(' ')[1]);
        buf = buf.subarray(end + 4);
        upgraded = true;
        resolve(conn);
        if (conn.status !== 101) {
          conn.body += buf.toString();
          buf = Buffer.alloc(0);
          return;
        }
      } else if (conn.status !== 101) {
        conn.body += buf.toString();
        buf = Buffer.alloc(0);
        return;
      }
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (op === 1) {
          const text = payload.toString();
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* kept as null */
          }
          conn.frames.push({ at: Date.now(), text, json: parsed });
        } else if (op === 8) {
          conn.closed = {
            code: payload.length >= 2 ? payload.readUInt16BE(0) : null,
            reason: payload.subarray(2).toString(),
            at: Date.now(),
          };
        } else if (op === 9) {
          conn.pings.push(Date.now());
          if (conn.answerPings) frame(10, payload);
        }
      }
    });
    sock.on('close', () => {
      conn.endedAt = Date.now();
      if (!upgraded) reject(new Error(`the stream service closed ${path} before answering the upgrade`));
    });
    sock.on('error', (error) => {
      conn.error = error;
      if (!upgraded) reject(error);
    });
  });
}

/** Opens a stream that must upgrade; says what the service answered when it does not. */
async function open(path, options) {
  const conn = await connect(path, options);
  expect(conn.status, `the stream service upgrades ${path}: ${conn.status} ${conn.body.slice(0, 300)}`).toBe(101);
  return conn;
}

/** The first frame (after `from`) that matches, within `ms`. */
async function frameWhere(conn, match, ms = 10_000, from = 0) {
  let found;
  await expect
    .poll(
      () => {
        found = conn.frames.slice(from).find((f) => f.json && match(f.json));
        return Boolean(found);
      },
      { timeout: ms, message: `a frame arrives; got ${JSON.stringify(conn.frames.slice(-5).map((f) => f.text.slice(0, 200)))}` },
    )
    .toBe(true);
  return found;
}

/** svc-ws's published policy (GET /policy). */
function policy() {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: WS_PORT, path: '/policy' }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode, body: text });
          }
        });
      })
      .on('error', reject);
  });
}

const refusedWith = (conn, code) => conn.body.includes(code) || (conn.closed?.reason ?? '').includes(code);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(`${J} #1 reads the stream endpoints and the protocol choice guide: public, private and business endpoints with failover; hosts "not set" if blank; each guide row names its owning module`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto('/developers/websocket');
  await expect(page.getByRole('heading', { name: 'WebSocket streams', level: 1 })).toBeVisible(UNBUILT);
  const endpoints = page.getByRole('table', { name: 'Stream endpoints' });
  const row = (name) => endpoints.locator(`tbody tr[data-endpoint="${name}"]`);
  const hosts = (name) => row(name).getByRole('listitem');

  // Public, private and business, each with a primary host and a failover: a set host in code, else "host not set".
  for (const name of ['public', 'private', 'business']) {
    await expect(row(name), `the ${name} endpoint`).toHaveCount(1, UNBUILT);
    await expect(hosts(name).and(page.locator('[data-role="primary"]'))).toHaveCount(1);
    await expect(hosts(name).and(page.locator('[data-role="failover"]'))).toHaveCount(1);
    for (const item of await hosts(name).all()) {
      if ((await item.getAttribute('data-host-state')) === 'set') await expect(item.getByRole('code')).toHaveText(/^wss:\/\/\S+$/);
      else {
        await expect(item).toHaveAttribute('data-host-state', 'unset');
        await expect(item).toContainText('host not set');
        await expect(item.getByRole('code')).toHaveCount(0);
      }
    }
  }

  // Each row of the protocol choice guide names the module that owns it.
  const guide = page.getByRole('table', { name: 'Choosing a protocol' }).locator('tbody tr');
  expect(await guide.count()).toBeGreaterThan(0);
  for (const guideRow of await guide.all()) {
    const owner = guideRow.locator('[data-module]');
    await expect(owner).toHaveCount(1);
    const module = await owner.getAttribute('data-module');
    expect(module, 'the owning module is named').toMatch(/\S/);
    await expect(owner).toHaveText(`Owned by ${module}`);
  }

  // With the owner's hosts blank, every endpoint host reads "host not set", and none is written or guessed.
  restartWith('trade', 'LOCAL_STACK_TRADE_DEVELOPER_HOSTS', false);
  try {
    await page.reload();
    for (const name of ['public', 'private', 'business']) {
      await expect(hosts(name)).toHaveCount(2);
      for (const item of await hosts(name).all()) {
        await expect(item).toHaveAttribute('data-host-state', 'unset');
        await expect(item).toContainText('host not set');
        await expect(item.getByRole('code')).toHaveCount(0);
      }
    }
  } finally {
    restartWith('trade', 'LOCAL_STACK_TRADE_DEVELOPER_HOSTS', true);
  }
});

test(`${J} #2 authenticates with a short-lived stream token: subscribed; after the lifetime the typed expiry error returns and a refreshed token works`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { page } = await keyHolder(browser, 'jd9t');
  try {
    const key = await makeKey(page, { name: 'bot-stream' });
    const streamToken = async () => {
      const reply = await withKey(key, { method: 'POST', path: '/api/v1/stream/token', body: {} });
      expect(reply.status, `the key gets a stream token: ${JSON.stringify(reply.body).slice(0, 300)}`).toBe(200);
      const { token, expiresAt } = reply.body;
      expect(token, 'a stream token').toMatch(/\S{20,}/);
      expect(token).not.toBe(key);
      const life = Date.parse(expiresAt) - Date.now();
      expect(life, `short-lived: it ends within the stack's TEST lifetime (${expiresAt})`).toBeGreaterThan(0);
      expect(life).toBeLessThanOrEqual(60_000);
      return { token, expiresAt: Date.parse(expiresAt) };
    };
    const subscribed = async (token) => {
      const conn = await open(`/private/stream?access_token=${encodeURIComponent(token)}&channel=orders`);
      const id = `jd9-2-${randomBytes(4).toString('hex')}`;
      conn.send({ op: 'subscribe', id, channels: [{ ch: 'orders' }] });
      const ack = await frameWhere(conn, (f) => f.op === 'ack' && f.id === id);
      expect(ack.json.for).toBe('subscribe');
      return conn;
    };

    // Subscribed with the stream token.
    const first = await streamToken();
    const live = await subscribed(first.token);

    // After its lifetime, the open stream says so by its typed code.
    await pause(Math.max(0, first.expiresAt - Date.now()) + 2_000);
    await expect
      .poll(
        () => live.frames.some((f) => f.json?.code === 'ws.token_expired') || (live.closed?.reason ?? '').includes('ws.token_expired'),
        {
          timeout: 15_000,
          message: 'the stream names the expired token',
        },
      )
      .toBe(true);
    // A new connection with the spent token is refused by the same code.
    const spent = await connect(`/private/stream?access_token=${encodeURIComponent(first.token)}&channel=orders`);
    await expect.poll(() => refusedWith(spent, 'ws.token_expired'), { timeout: 10_000 }).toBe(true);

    // A refreshed token works.
    const refreshed = await streamToken();
    expect(refreshed.token).not.toBe(first.token);
    const again = await subscribed(refreshed.token);
    expect(again.isOpen()).toBe(true);
    for (const conn of [live, spent, again]) conn.drop();
  } finally {
    await page.context().close();
  }
});

test(`${J} #3 subscribes with a request id: the ack echoes the id and carries server times; an unknown message type is ignored, as documented`, async ({
  page,
}) => {
  const conn = await open('/stream');
  try {
    const id = `jd9-3-${randomBytes(4).toString('hex')}`;
    const sent = Date.now();
    conn.send({ op: 'subscribe', id, channels: [{ ch: 'ticker', market: MARKET }] });
    const ack = (await frameWhere(conn, (f) => f.op === 'ack' && f.id === id)).json;
    const back = Date.now();
    expect(ack.for).toBe('subscribe');
    expect(ack.id).toBe(id);
    // The server's times: when it received the subscribe and when it sent the ack, on this machine's clock.
    for (const field of ['receivedAt', 'sentAt']) {
      expect(typeof ack[field], `the ack carries ${field}: ${JSON.stringify(ack).slice(0, 300)}`).toBe('number');
      expect(ack[field]).toBeGreaterThanOrEqual(sent - 1_000);
      expect(ack[field]).toBeLessThanOrEqual(back + 1_000);
    }
    expect(ack.receivedAt).toBeLessThanOrEqual(ack.sentAt);

    // An unknown message type is ignored: no answer to it, the connection stays open, and the next request is answered.
    const before = conn.frames.length;
    conn.send({ op: 'jd9-no-such-type', id: `${id}-x` });
    await pause(3_000);
    const answered = conn.frames.slice(before).filter((f) => f.json?.op === 'error' || f.json?.id === `${id}-x`);
    expect(
      answered.map((f) => f.text),
      'nothing answers an unknown message type',
    ).toEqual([]);
    expect(conn.isOpen(), 'the connection stays open').toBe(true);
    const next = `${id}-2`;
    conn.send({ op: 'unsubscribe', id: next, channels: [{ ch: 'ticker', market: MARKET }] });
    await frameWhere(conn, (f) => f.op === 'ack' && f.id === next);

    // And the documentation says so.
    await page.goto('/developers/websocket');
    await expect(page.getByRole('main')).toContainText('Unknown message types are ignored.', UNBUILT);
  } finally {
    conn.drop();
  }
});

test(`${J} #4 stops answering pings: the server ends the connection after the interval`, async ({ page }) => {
  test.setTimeout(240_000);
  // The interval the person reads on the stream page.
  await page.goto('/developers/websocket');
  const seconds = Number(await page.getByTestId('developers-websocket-ping-interval').getAttribute('data-seconds', UNBUILT));
  expect(Number.isInteger(seconds) && seconds > 0, `a published ping interval (${seconds})`).toBe(true);

  // A client that never answers a ping. It holds a subscription, so no idle rule ends it first.
  const conn = await open('/stream', { answerPings: false });
  try {
    const id = `jd9-4-${randomBytes(4).toString('hex')}`;
    conn.send({ op: 'subscribe', id, channels: [{ ch: 'ticker', market: MARKET }] });
    await frameWhere(conn, (f) => f.op === 'ack' && f.id === id);
    await expect.poll(() => conn.endedAt !== null, { timeout: (2 * seconds + 10) * 1_000, intervals: [1_000] }).toBe(true);
    expect(conn.pings.length, 'the server pinged').toBeGreaterThan(0);
    const lived = conn.endedAt - conn.openedAt;
    expect(lived, `ended after the ${seconds}-second interval, not before`).toBeGreaterThanOrEqual(seconds * 1_000 - 1_000);
    expect(lived, `ended within two intervals of ${seconds} seconds`).toBeLessThanOrEqual((2 * seconds + 5) * 1_000);
  } finally {
    conn.drop();
  }
});

test(`${J} #5 reconnects after a gap: a snapshot first, then sequence numbers continue from it`, async () => {
  test.setTimeout(120_000);
  const isBook = (f) => f.ch === 'book' && f.data && (f.data.type === 'snapshot' || f.data.type === 'delta');
  const subscribeBook = async (conn) => {
    const id = `jd9-5-${randomBytes(4).toString('hex')}`;
    conn.send({ op: 'subscribe', id, channels: [{ ch: 'book', market: MARKET }] });
    await frameWhere(conn, (f) => f.op === 'ack' && f.id === id);
  };

  // Before the gap: the book, and the last sequence seen.
  const first = await open('/stream');
  await subscribeBook(first);
  await frameWhere(first, (f) => isBook(f) && f.data.type === 'snapshot', 15_000);
  const seenBefore = Math.max(...first.frames.filter((f) => f.json && isBook(f.json)).map((f) => f.json.data.sequence));
  first.drop();

  // The gap, then a new connection.
  await pause(3_000);
  const again = await open('/stream');
  try {
    await subscribeBook(again);
    // A snapshot first: the first book frame is a snapshot, at or past where the book was before the gap.
    const firstBook = await frameWhere(again, isBook, 15_000);
    expect(firstBook.json.data.type, 'the first book frame after reconnecting').toBe('snapshot');
    const snapshot = firstBook.json.data;
    expect(snapshot.sequence).toBeGreaterThanOrEqual(seenBefore);

    // Then sequence numbers continue from it: each delta starts where the one before it ended.
    await expect
      .poll(() => again.frames.filter((f) => f.json && isBook(f.json) && f.json.data.type === 'delta').length, {
        timeout: 60_000,
        message: 'two book deltas arrive after the snapshot',
      })
      .toBeGreaterThanOrEqual(2);
    let cursor = snapshot.sequence;
    const after = again.frames.slice(again.frames.indexOf(firstBook) + 1).filter((f) => f.json && isBook(f.json));
    for (const f of after) {
      if (f.json.data.type === 'snapshot') {
        cursor = f.json.data.sequence;
        continue;
      }
      expect(f.json.data.fromSequence, 'a delta continues from the sequence before it').toBe(cursor);
      expect(f.json.data.sequence).toBeGreaterThan(cursor);
      cursor = f.json.data.sequence;
    }
  } finally {
    again.drop();
  }
});

test(`${J} #6 opens connections above the per-IP cap: the extra one closes with the typed reason; repeated storms are banned for the owner-set time, and a blank time refuses to enable the ban and says so`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const read = await policy();
  expect(read.status).toBe(200);
  const perIp = read.body?.perIp;
  expect(perIp, `svc-ws publishes its per-IP policy: ${JSON.stringify(read.body).slice(0, 300)}`).toBeTruthy();
  const { maxConnections: cap, stormsBeforeBan, banSeconds } = perIp;
  for (const [name, value] of Object.entries({ cap, stormsBeforeBan, banSeconds })) {
    expect(Number.isInteger(value) && value > 0, `${name} is published (${value})`).toBe(true);
  }
  expect(banSeconds, "the stack's TEST ban time is short enough to wait out").toBeLessThanOrEqual(60);

  /** One storm from `address`: cap connections stay, the one over the cap is closed with the typed reason. */
  const storm = async (address) => {
    const held = [];
    for (let i = 0; i < cap; i++) held.push(await open('/stream', { localAddress: address }));
    const extra = await connect('/stream', { localAddress: address });
    await expect
      .poll(() => refusedWith(extra, 'ws.per_ip_cap'), { timeout: 10_000, message: 'the extra connection names the cap' })
      .toBe(true);
    for (const conn of held) expect(conn.isOpen(), 'connections under the cap stay open').toBe(true);
    for (const conn of [...held, extra]) conn.drop();
    await pause(500);
  };

  // One storm: only the extra connection closes.
  await storm('127.0.0.3');
  // Repeated storms: the address is banned, another address is not.
  for (let i = 1; i < stormsBeforeBan; i++) await storm('127.0.0.3');
  const banned = await connect('/stream', { localAddress: '127.0.0.3' });
  await expect.poll(() => refusedWith(banned, 'ws.ip_banned'), { timeout: 10_000 }).toBe(true);
  banned.drop();
  const other = await open('/stream', { localAddress: '127.0.0.4' });
  other.drop();
  // For the owner-set time, then no longer.
  await pause(banSeconds * 1_000 - 5_000 > 0 ? banSeconds * 1_000 - 5_000 : 0);
  const stillBanned = await connect('/stream', { localAddress: '127.0.0.3' });
  await expect.poll(() => refusedWith(stillBanned, 'ws.ip_banned'), { timeout: 4_000 }).toBe(true);
  stillBanned.drop();
  await pause(7_000);
  const back = await open('/stream', { localAddress: '127.0.0.3' });
  back.drop();

  // With the ban time blank, the ban is not enabled and the service and the endpoints page say so; the cap still holds.
  restartWith('ws', 'LOCAL_STACK_WS_IP_BAN_SECONDS', false);
  try {
    const blank = await policy();
    expect(blank.body?.perIp?.ban, JSON.stringify(blank.body).slice(0, 300)).toBe('unset');
    expect(blank.body?.perIp?.banSeconds).toBeNull();
    await page.goto('/developers/websocket');
    await expect(page.getByRole('main')).toContainText('No ban time is set, so no address is banned.', UNBUILT);
    for (let i = 0; i < stormsBeforeBan + 1; i++) await storm('127.0.0.5');
    const notBanned = await open('/stream', { localAddress: '127.0.0.5' });
    notBanned.drop();
  } finally {
    restartWith('ws', 'LOCAL_STACK_WS_IP_BAN_SECONDS', true);
  }
});
