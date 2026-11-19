/**
 * Alert webhooks (J-charts-desk-10 #3 #4; C-alerts-scan-04): one HTTP POST to the person's own endpoint each time an alert fires,
 * retried on the owner's schedule, with every attempt kept so the alerts page can say what happened.
 *
 * This is our own adapter: no vendor stands behind it. The endpoint is the person's, so the server that posts to it must never be
 * turned against our own network. A URL is checked when it is saved and again, on the address it resolves to, when it is sent to:
 *
 *   - https only;
 *   - a port the owner allows (`NOTIFY_ALERT_WEBHOOK_PORTS`, 443 when the URL names none); blank refuses every save;
 *   - no loopback, private, link-local, shared, documentation, multicast or reserved address, IPv4 or IPv6;
 *   - the connection goes to the address that was checked (the lookup is pinned), so a name that answers differently a second
 *     time (DNS rebinding) cannot slip a private address in between the check and the send;
 *   - redirects are not followed.
 *
 * A LOCAL TEST stack has no public endpoint to post to, so `NOTIFY_ALERT_WEBHOOK_TEST_LOOPBACK=on`, refused at boot unless APP_ENV is
 * exactly dev or test, lets a loopback address through, over http as well as https. Nothing else changes.
 *
 * RETRIES. The owner's schedule (`NOTIFY_ALERT_WEBHOOK_RETRY_SECONDS`, e.g. `5,5,5`) says how long to wait before each resend. Only an
 * answer that says the endpoint could not take it right now is resent: a 5xx other than 504, or no connection at all. A 504 or a
 * timeout is not resent, because the endpoint may have acted on it; a 2xx is delivered; a 3xx or 4xx is the endpoint refusing,
 * and resending the same body would be refused the same way. A blank schedule resends nothing, and the attempt says so.
 *
 * DURABILITY. A firing writes its delivery row in the database before anything is sent, keyed by (alert, firing number), so a
 * firing replayed after a crash posts nothing new. A worker claims due rows with a lease and posts; a crash mid-post leaves the
 * lease to expire and the row is tried again, which is why every request carries `idempotency-key: alert:<alertId>:<n>`.
 */

import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { Sql } from 'postgres';

export const NOTIFY_ALERT_WEBHOOK_PORTS_UNSET = 'notify.alert_webhook_ports_unset' as const;

export type AlertWebhookRefusal =
  | typeof NOTIFY_ALERT_WEBHOOK_PORTS_UNSET
  | 'alert.webhook_invalid_url'
  | 'alert.webhook_not_https'
  | 'alert.webhook_port_not_allowed'
  | 'alert.webhook_private_address'
  | 'alert.webhook_unresolvable';

/** A webhook URL refused when it is saved. Nothing is stored. */
export class AlertWebhookError extends Error {
  readonly code: AlertWebhookRefusal;
  constructor(code: AlertWebhookRefusal, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'AlertWebhookError';
    this.code = code;
  }
}

export type AlertWebhookPolicy = {
  /** Ports an endpoint may use. `null` (blank) refuses every save. */
  readonly ports: readonly number[] | null;
  /** Seconds to wait before each resend. `null` (blank): nothing is resent. */
  readonly retrySeconds: readonly number[] | null;
  /** LOCAL TEST only: a loopback endpoint is allowed, over http too. */
  readonly testLoopback: boolean;
  /** How long one attempt may take before it is given up as a timeout. */
  readonly timeoutMs: number;
};

export const NO_WEBHOOK_POLICY: AlertWebhookPolicy = { ports: null, retrySeconds: null, testLoopback: false, timeoutMs: 5_000 };

/** Parse a comma list of whole numbers; blank is `null`, never a default. A bad entry refuses at boot. */
export function parseNumberList(raw: string | undefined, name: string, min: number, max: number): number[] | null {
  const text = raw?.trim() ?? '';
  if (text === '') return null;
  return text.split(',').map((part) => {
    const n = Number(part.trim());
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`${name}: "${part.trim()}" is not a whole number from ${min} to ${max}`);
    return n;
  });
}

/** The TEST loopback switch is honoured only on a dev or test stack; anywhere else it stops the boot. */
export function webhookTestLoopback(raw: string | undefined, appEnv: string | undefined): boolean {
  const on = (raw?.trim() ?? '') === 'on';
  if (on && appEnv !== 'dev' && appEnv !== 'test') {
    throw new Error('NOTIFY_ALERT_WEBHOOK_TEST_LOOPBACK=on is allowed only when APP_ENV is exactly dev or test');
  }
  return on;
}

// ── Addresses ────────────────────────────────────────────────────────────────

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/**
 * IPv4 carried in IPv6 (compatible, mapped, translated). Kept apart from `blocked`, because a BlockList also matches a plain IPv4
 * address against these: it is checked only for an IPv6 address embeddedIpv4 could not unwrap, which is refused.
 */
const carriesIpv4 = new BlockList();
carriesIpv4.addSubnet('::', 96, 'ipv6');
carriesIpv4.addSubnet('::ffff:0:0', 96, 'ipv6');
carriesIpv4.addSubnet('::ffff:0:0:0', 96, 'ipv6');

const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

/** An IPv4 address carried inside IPv6 (`::ffff:10.0.0.1`, `::ffff:0:10.0.0.1`, `::10.0.0.1`), or null. */
function embeddedIpv4(address: string): string | null {
  const m = /^::(?:ffff:(?:0:)?)?(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (m) return m[1]!;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return null;
  const hi = parseInt(hex[1]!, 16);
  const lo = parseInt(hex[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** Whether an endpoint may be posted to at this address. */
export function addressAllowed(address: string, testLoopback: boolean): boolean {
  const v4 = isIP(address) === 6 ? embeddedIpv4(address) : null;
  const ip = v4 ?? address;
  const family = isIP(ip) === 4 ? 'ipv4' : isIP(ip) === 6 ? 'ipv6' : null;
  if (family === null) return false;
  if (family === 'ipv6' && carriesIpv4.check(ip, 'ipv6') && !loopback.check(ip, 'ipv6')) return false;
  if (testLoopback && loopback.check(ip, family)) return true;
  return !blocked.check(ip, family);
}

export type Resolve = (host: string) => Promise<readonly { address: string; family: number }[]>;

export const systemResolve: Resolve = (host) =>
  new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });

function hostOf(url: URL): string {
  // `new URL('https://[::1]/')` keeps the brackets on the hostname.
  return url.hostname.replace(/^\[(.*)\]$/, '$1');
}

/**
 * The address this endpoint is posted to: every address its name resolves to must be allowed, so a name that answers with one
 * public and one private address is refused rather than raced. Throws `alert.webhook_private_address` or `.._unresolvable`.
 */
export async function resolveAllowed(url: URL, policy: AlertWebhookPolicy, resolve: Resolve): Promise<{ address: string; family: 4 | 6 }> {
  const host = hostOf(url);
  const literal = isIP(host);
  let addresses: readonly { address: string; family: number }[];
  if (literal) addresses = [{ address: host, family: literal }];
  else {
    try {
      addresses = await resolve(host);
    } catch {
      throw new AlertWebhookError('alert.webhook_unresolvable', `${host} does not resolve`);
    }
  }
  if (addresses.length === 0) throw new AlertWebhookError('alert.webhook_unresolvable', `${host} does not resolve`);
  for (const a of addresses) {
    if (!addressAllowed(a.address, policy.testLoopback)) {
      throw new AlertWebhookError('alert.webhook_private_address', `${host} resolves to an address that is not public`);
    }
  }
  const first = addresses[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

/**
 * Check a webhook URL before it is saved. Returns the URL as it will be stored. Blank (`null`, `''`) is no webhook and is returned
 * as `null`.
 */
export async function checkWebhookUrl(
  raw: string | null | undefined,
  policy: AlertWebhookPolicy,
  resolve: Resolve = systemResolve,
): Promise<string | null> {
  const text = raw?.trim() ?? '';
  if (text === '') return null;
  if (policy.ports === null)
    throw new AlertWebhookError(NOTIFY_ALERT_WEBHOOK_PORTS_UNSET, 'the owner has not set which ports a webhook may use');
  if (text.length > 2048) throw new AlertWebhookError('alert.webhook_invalid_url', 'the URL is longer than 2048 characters');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new AlertWebhookError('alert.webhook_invalid_url', 'not a URL');
  }
  if (url.username !== '' || url.password !== '')
    throw new AlertWebhookError('alert.webhook_invalid_url', 'a URL may not carry a user name or password');
  if (url.protocol !== 'https:') {
    const loopbackHttp = url.protocol === 'http:' && policy.testLoopback && isLoopbackHost(hostOf(url));
    if (!loopbackHttp) throw new AlertWebhookError('alert.webhook_not_https', 'a webhook must use https');
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!policy.ports.includes(port)) throw new AlertWebhookError('alert.webhook_port_not_allowed', `port ${port} is not allowed`);
  await resolveAllowed(url, policy, resolve);
  return url.toString();
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost') return true;
  const family = isIP(host);
  return family !== 0 && loopback.check(host, family === 4 ? 'ipv4' : 'ipv6');
}

// ── One attempt ──────────────────────────────────────────────────────────────

/**
 * Why an attempt ended as it did. The page explains each one in words; the code is what is stored.
 *
 *   ok             2xx: the endpoint took it.
 *   redirect       3xx: redirects are not followed; the URL should name the final address.
 *   refused        4xx: the endpoint refused the request (its path, method or credentials). Not resent.
 *   unavailable    5xx other than 504: the endpoint could not take it now. Resent on the schedule.
 *   gateway_timeout 504: something in front of the endpoint gave up; it may still have acted, so it is not resent.
 *   timeout        no answer in time; it may still have acted, so it is not resent.
 *   unreachable    no connection was made. Resent on the schedule.
 *   private_address the name resolved to an address that is not public when it was sent to. Not resent.
 */
export type WebhookCause =
  'ok' | 'redirect' | 'refused' | 'unavailable' | 'gateway_timeout' | 'timeout' | 'unreachable' | 'private_address';

export type WebhookAttempt = {
  readonly n: number;
  /** ISO time the attempt started. */
  readonly at: string;
  /** The HTTP status, or null when no answer came. */
  readonly status: number | null;
  readonly cause: WebhookCause;
  readonly durationMs: number;
};

export function causeOfStatus(status: number): WebhookCause {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 400) return 'redirect';
  if (status === 504) return 'gateway_timeout';
  if (status >= 500) return 'unavailable';
  return 'refused';
}

export const isResendable = (cause: WebhookCause): boolean => cause === 'unavailable' || cause === 'unreachable';

export type PostWebhook = (url: string, body: string, idempotencyKey: string) => Promise<{ status: number | null; cause: WebhookCause }>;

/** The real sender: node http(s), the lookup pinned to the checked address, no redirects, a hard timeout, the answer discarded. */
export function httpPostWebhook(policy: AlertWebhookPolicy, resolve: Resolve = systemResolve): PostWebhook {
  return async (raw, body, idempotencyKey) => {
    const url = new URL(raw);
    let target: { address: string; family: 4 | 6 };
    try {
      target = await resolveAllowed(url, policy, resolve);
    } catch (err) {
      if (err instanceof AlertWebhookError && err.code === 'alert.webhook_private_address')
        return { status: null, cause: 'private_address' };
      return { status: null, cause: 'unreachable' };
    }
    const client = url.protocol === 'https:' ? https : http;
    return new Promise((resolveOut) => {
      let settled = false;
      const done = (out: { status: number | null; cause: WebhookCause }) => {
        if (settled) return;
        settled = true;
        resolveOut(out);
      };
      const req = client.request(
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'user-agent': 'INTAFACED-alerts/1',
            'idempotency-key': idempotencyKey,
          },
          // Connect to the address that was checked, never to whatever the name answers next.
          lookup: (_host, options, cb) => {
            if (options.all) cb(null, [target]);
            else cb(null, target.address, target.family);
          },
          timeout: policy.timeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          // The answer's body is not read into memory or stored: only the status is evidence.
          res.resume();
          done({ status, cause: causeOfStatus(status) });
        },
      );
      req.on('timeout', () => {
        req.destroy();
        done({ status: null, cause: 'timeout' });
      });
      req.on('error', () => done({ status: null, cause: 'unreachable' }));
      req.end(body);
    });
  };
}

// ── The delivery record ──────────────────────────────────────────────────────

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed';

export type WebhookDelivery = {
  readonly alertId: string;
  readonly seq: number;
  readonly userId: string;
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly status: WebhookDeliveryStatus;
  readonly attempts: readonly WebhookAttempt[];
  readonly nextAttemptAt: Date | null;
  readonly createdAt: Date;
};

export interface AlertWebhookStore {
  /** Write the delivery for one firing, due now. A firing that already has its row keeps it: nothing new is sent. */
  enqueue(input: { alertId: string; seq: number; userId: string; url: string; body: Record<string, unknown>; at: Date }): Promise<void>;
  /** Due rows, each leased until `leaseUntil` so no other worker takes it meanwhile. */
  claimDue(at: Date, limit: number, leaseUntil: Date): Promise<readonly WebhookDelivery[]>;
  /** Record one attempt and what follows: due again at `nextAttemptAt`, or finished. Clears the lease. */
  settle(alertId: string, seq: number, attempt: WebhookAttempt, status: WebhookDeliveryStatus, nextAttemptAt: Date | null): Promise<void>;
  /** The person's deliveries for these firings. */
  listFor(userId: string, firings: readonly { alertId: string; seq: number }[]): Promise<readonly WebhookDelivery[]>;
}

export class MemoryAlertWebhookStore implements AlertWebhookStore {
  readonly rows = new Map<string, WebhookDelivery & { leaseUntil: Date | null }>();

  async enqueue(input: {
    alertId: string;
    seq: number;
    userId: string;
    url: string;
    body: Record<string, unknown>;
    at: Date;
  }): Promise<void> {
    const key = `${input.alertId}:${input.seq}`;
    if (this.rows.has(key)) return;
    this.rows.set(key, {
      alertId: input.alertId,
      seq: input.seq,
      userId: input.userId,
      url: input.url,
      body: input.body,
      status: 'pending',
      attempts: [],
      nextAttemptAt: input.at,
      createdAt: input.at,
      leaseUntil: null,
    });
  }

  async claimDue(at: Date, limit: number, leaseUntil: Date): Promise<readonly WebhookDelivery[]> {
    const due = [...this.rows.values()]
      .filter(
        (r) => r.status === 'pending' && r.nextAttemptAt !== null && r.nextAttemptAt <= at && (r.leaseUntil === null || r.leaseUntil <= at),
      )
      .sort((a, b) => a.nextAttemptAt!.getTime() - b.nextAttemptAt!.getTime())
      .slice(0, limit);
    for (const r of due) r.leaseUntil = leaseUntil;
    return due.map(({ leaseUntil: _lease, ...row }) => row);
  }

  async settle(
    alertId: string,
    seq: number,
    attempt: WebhookAttempt,
    status: WebhookDeliveryStatus,
    nextAttemptAt: Date | null,
  ): Promise<void> {
    const row = this.rows.get(`${alertId}:${seq}`);
    if (!row || row.status !== 'pending' || row.attempts.some((a) => a.n === attempt.n)) return;
    this.rows.set(`${alertId}:${seq}`, { ...row, attempts: [...row.attempts, attempt], status, nextAttemptAt, leaseUntil: null });
  }

  async listFor(userId: string, firings: readonly { alertId: string; seq: number }[]): Promise<readonly WebhookDelivery[]> {
    const out: WebhookDelivery[] = [];
    for (const f of firings) {
      const row = this.rows.get(`${f.alertId}:${f.seq}`);
      if (row && row.userId === userId) {
        const { leaseUntil: _lease, ...rest } = row;
        out.push(rest);
      }
    }
    return out;
  }
}

type DeliveryRow = {
  alert_id: string;
  seq: number;
  user_id: string;
  url: string;
  body: Record<string, unknown>;
  status: WebhookDeliveryStatus;
  attempts: WebhookAttempt[];
  next_attempt_at: Date | null;
  created_at: Date;
};

const mapDelivery = (r: DeliveryRow): WebhookDelivery => ({
  alertId: r.alert_id,
  seq: r.seq,
  userId: r.user_id,
  url: r.url,
  body: r.body,
  status: r.status,
  attempts: r.attempts ?? [],
  nextAttemptAt: r.next_attempt_at,
  createdAt: r.created_at,
});

export class PostgresAlertWebhookStore implements AlertWebhookStore {
  constructor(private readonly sql: Sql) {}

  async enqueue(input: {
    alertId: string;
    seq: number;
    userId: string;
    url: string;
    body: Record<string, unknown>;
    at: Date;
  }): Promise<void> {
    await this.sql`
      INSERT INTO notify.alert_webhook_deliveries (alert_id, seq, user_id, url, body, status, next_attempt_at, created_at, updated_at)
      VALUES (${input.alertId}, ${input.seq}, ${input.userId}, ${input.url}, ${this.sql.json(input.body as never)}, 'pending', ${input.at}, ${input.at}, ${input.at})
      ON CONFLICT (alert_id, seq) DO NOTHING
    `;
  }

  async claimDue(at: Date, limit: number, leaseUntil: Date): Promise<readonly WebhookDelivery[]> {
    const rows = await this.sql<DeliveryRow[]>`
      UPDATE notify.alert_webhook_deliveries d
      SET lease_until = ${leaseUntil}
      FROM (
        SELECT alert_id, seq FROM notify.alert_webhook_deliveries
        WHERE status = 'pending' AND next_attempt_at <= ${at} AND (lease_until IS NULL OR lease_until <= ${at})
        ORDER BY next_attempt_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      ) due
      WHERE d.alert_id = due.alert_id AND d.seq = due.seq
      RETURNING d.alert_id, d.seq, d.user_id, d.url, d.body, d.status, d.attempts, d.next_attempt_at, d.created_at
    `;
    return rows.map(mapDelivery);
  }

  async settle(
    alertId: string,
    seq: number,
    attempt: WebhookAttempt,
    status: WebhookDeliveryStatus,
    nextAttemptAt: Date | null,
  ): Promise<void> {
    // An attempt number already on the row (a lease that ran out while this one was posting) is not written twice.
    await this.sql`
      UPDATE notify.alert_webhook_deliveries
      SET attempts = attempts || ${this.sql.json([attempt] as never)}::jsonb, status = ${status}, next_attempt_at = ${nextAttemptAt},
          lease_until = NULL, updated_at = now()
      WHERE alert_id = ${alertId} AND seq = ${seq} AND status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(attempts) a WHERE (a->>'n')::int = ${attempt.n})
    `;
  }

  async listFor(userId: string, firings: readonly { alertId: string; seq: number }[]): Promise<readonly WebhookDelivery[]> {
    if (firings.length === 0) return [];
    const keys = firings.map((f) => `${f.alertId}:${f.seq}`);
    const rows = await this.sql<DeliveryRow[]>`
      SELECT alert_id, seq, user_id, url, body, status, attempts, next_attempt_at, created_at
      FROM notify.alert_webhook_deliveries
      WHERE user_id = ${userId} AND (alert_id::text || ':' || seq::text) = ANY(${keys})
    `;
    return rows.map(mapDelivery);
  }
}

// ── The worker ───────────────────────────────────────────────────────────────

/** How often the worker looks for due deliveries. A constant: the owner sets the schedule, not the polling. */
export const ALERT_WEBHOOK_TICK_MS = 1_000;
const LEASE_MS = 60_000;
const BATCH = 20;

/**
 * One pass: claim what is due, post each, write the attempt. What follows an attempt:
 *   ok                       delivered.
 *   resendable, schedule left due again after the next delay of the schedule.
 *   anything else            failed: not resendable, the schedule is used up, or there is no schedule.
 */
export async function runWebhookTick(
  store: AlertWebhookStore,
  post: PostWebhook,
  policy: AlertWebhookPolicy,
  now: () => Date = () => new Date(),
): Promise<number> {
  const started = now();
  const due = await store.claimDue(started, BATCH, new Date(started.getTime() + LEASE_MS));
  for (const row of due) {
    const n = row.attempts.length + 1;
    const at = now();
    const out = await post(row.url, JSON.stringify(row.body), `alert:${row.alertId}:${row.seq}`);
    const end = now();
    const attempt: WebhookAttempt = {
      n,
      at: at.toISOString(),
      status: out.status,
      cause: out.cause,
      durationMs: Math.max(0, end.getTime() - at.getTime()),
    };
    if (out.cause === 'ok') {
      await store.settle(row.alertId, row.seq, attempt, 'delivered', null);
      continue;
    }
    // Attempt n is followed by resend n, which waits the n-th delay of the schedule.
    const delay = policy.retrySeconds?.[n - 1];
    if (isResendable(out.cause) && delay !== undefined) {
      await store.settle(row.alertId, row.seq, attempt, 'pending', new Date(end.getTime() + delay * 1000));
    } else {
      await store.settle(row.alertId, row.seq, attempt, 'failed', null);
    }
  }
  return due.length;
}
