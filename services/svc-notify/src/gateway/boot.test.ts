import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';

const entry = fileURLToPath(new URL('../../dist/gateway/index.js', import.meta.url));
const bearer = 'synthetic-independent-relay-private-bearer';
const upstreamToken = 'synthetic-distinct-upstream-private-token';
const sendUrl = 'https://not-contacted.example.invalid/send';
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}
function start(databaseUrl: string, port: number, overrides: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      DATABASE_URL: undefined,
      NOTIFY_RELAY_DATABASE_URL: databaseUrl,
      NOTIFY_RELAY_HOST: '127.0.0.1',
      NOTIFY_RELAY_PORT: String(port),
      NOTIFY_RELAY_TOKEN: bearer,
      NOTIFY_RELAY_SEND_URL: sendUrl,
      NOTIFY_RELAY_SEND_TOKEN: upstreamToken,
      NOTIFY_RELAY_TIMEOUT_MS: '1000',
      ...overrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (value) => (output += value));
  child.stderr.on('data', (value) => (output += value));
  const exited = once(child, 'exit');
  return { child, exited, output: () => output, origin: `http://127.0.0.1:${port}` };
}
async function stop(child: ChildProcess, exited: Promise<unknown>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const ended = await Promise.race([exited.then(() => true), pause(3000).then(() => false)]);
  if (!ended) {
    child.kill('SIGKILL');
    await exited;
    throw new Error('Synthetic relay did not terminate cleanly');
  }
}
async function ready(process: ReturnType<typeof start>) {
  for (let i = 0; i < 100; i++) {
    if (process.child.exitCode !== null) throw new Error('Synthetic relay exited before readiness');
    try {
      const response = await fetch(process.origin + '/ready', { headers: { authorization: `Bearer ${bearer}` } });
      if (response.status === 200) return response;
    } catch {
      /* Only the owned loopback listener is polled. */
    }
    await pause(25);
  }
  throw new Error('Synthetic relay did not become ready');
}

describe('compiled independent relay boot and reboot (actual SQL/HTTP)', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase({ service: 'notify' });
  }, 30000);
  afterAll(async () => {
    await database?.drop();
  });

  it('refuses invalid configuration without printing credentials', async () => {
    const invalid = start(database.url, await freePort(), { NOTIFY_RELAY_SEND_URL: `http://invalid.test/${upstreamToken}` });
    try {
      const [code] = (await Promise.race([
        invalid.exited,
        pause(15000).then(() => {
          throw new Error('Configuration failure did not terminate');
        }),
      ])) as [number];
      expect(code).toBe(1);
      expect(invalid.output().trim()).toBe('notify.relay.startup_unavailable');
      expect(invalid.output()).not.toContain(upstreamToken);
      expect(invalid.output()).not.toContain(database.url);
    } finally {
      await stop(invalid.child, invalid.exited);
    }
  }, 30000);

  it('boots only independent receipt storage, authenticates readiness and closes on SIGTERM', async () => {
    const running = start(database.url, await freePort());
    try {
      expect(await (await ready(running)).json()).toEqual({ configured: true, upstream: 'unprobed' });
      expect((await fetch(running.origin + '/ready')).status).toBe(401);
      const tables = await database.sql`SELECT tablename FROM pg_tables WHERE schemaname='notify' ORDER BY tablename`;
      expect(tables.map((row) => row.tablename)).toEqual(['mailbox_relay_receipts']);
      expect(running.output().trim()).toBe('notify.relay.listening');
      await stop(running.child, running.exited);
      await expect(fetch(running.origin + '/ready')).rejects.toThrow();
    } finally {
      await stop(running.child, running.exited);
    }
  });

  it('reboots with the original synthetic accepted receipt and never calls the unreachable upstream', async () => {
    const key = `synthetic-reboot:${randomUUID()}`;
    const gatewayId = randomUUID();
    const delivery = {
      to: ['synthetic@example.invalid'],
      displayName: 'INTAFACED',
      subject: 'Synthetic receipt',
      text: 'Synthetic local verification.',
    };
    const fingerprint = createHmac('sha256', key)
      .update(JSON.stringify({ sender: sendUrl, ...delivery }))
      .digest('hex');
    await database.sql`INSERT INTO notify.mailbox_relay_receipts(key_hash,envelope_hash,gateway_id,status,attempted_at,deadline_at,settled_at)
      VALUES (${createHash('sha256').update(key).digest('hex')},${fingerprint},${gatewayId},'accepted',clock_timestamp(),clock_timestamp()+interval '1 minute',clock_timestamp())`;
    const running = start(database.url, await freePort());
    try {
      await ready(running);
      const response = await fetch(running.origin + '/send', {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({
          channel: 'email',
          notificationId: randomUUID(),
          to: delivery.to[0],
          locale: 'en',
          severity: 'info',
          kind: 'enquiry_acknowledgement',
          subject: delivery.subject,
          text: delivery.text,
          href: null,
          titleKey: 'notify.outreach.enquiry_acknowledgement.title',
          bodyKey: 'notify.outreach.enquiry_acknowledgement.body',
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: `relay:${gatewayId}` });
      expect((await database.sql`SELECT status FROM notify.mailbox_relay_receipts WHERE gateway_id=${gatewayId}`)[0]?.status).toBe(
        'accepted',
      );
      expect(running.output().trim()).toBe('notify.relay.listening');
    } finally {
      await stop(running.child, running.exited);
    }
  });
});
