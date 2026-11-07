/**
 * How an alert reaches the person (J-charts-desk-10, C-alerts-scan-04): the channels it was set to, and the webhook adapter.
 *
 * - Every price alert writes its in-app row when it fires (the inbox, through the existing fan-out). The person may also
 *   choose a popup and a sound (played by the app while it is open), email and push (sent by the fan-out's channels, which
 *   refuse by name while their delivery service is not configured: nothing here reports a message as emailed or pushed), and
 *   a webhook.
 * - The webhook is our own adapter, needing no outside service: one HTTP POST of the alert's JSON body to the person's URL
 *   each time the alert fires. A failed POST is retried under the published policy (the owner's maximum attempts and the
 *   wait before each retry, `NOTIFY_ALERT_WEBHOOK_MAX_ATTEMPTS` and `NOTIFY_ALERT_WEBHOOK_BACKOFF_MS`); with either blank
 *   the webhook channel is refused, never given a default. Every attempt is logged with its HTTP status or error, and the
 *   log is the diagnostics the person reads.
 * - The URL must be https to a public address, checked when it is stored and again, pinned, when it is called. A local
 *   TEST receiver (http to this machine's loopback) is let through only when `NOTIFY_ALERT_WEBHOOK_LOCAL_TEST_RECEIVER=on`,
 *   which boot refuses unless APP_ENV is exactly dev or test: a live deployment keeps every address check.
 * - Each attempt is a row keyed by (alert, trigger number, attempt number), so a sweep that retries after a crash, or two
 *   delivery passes racing, never POST the same attempt twice; a delivered trigger is never sent again.
 */
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import type { Sql } from 'postgres';
import {
  pinnedPost,
  privateAddress,
  systemResolver,
  webhookTargetProblem,
  type Resolver,
  type WebhookPost,
} from '../status-page/webhook.js';
import type { PriceAlert } from './types.js';

export const ALERT_CHANNELS = ['inapp', 'popup', 'sound', 'email', 'push', 'webhook'] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

export type AlertChannelChoice = { readonly channels: readonly AlertChannel[]; readonly webhookUrl: string | null };
/** What an alert made before channels existed, or saved with none named, reaches: the in-app inbox alone. */
export const IN_APP_ONLY: AlertChannelChoice = { channels: ['inapp'], webhookUrl: null };

export type WebhookPolicy = { readonly maxAttempts: number; readonly backoffMs: readonly number[] };

export const NOTIFY_ALERT_WEBHOOK_POLICY_UNSET = 'notify.alert_webhook_policy_unset' as const;

export type AlertChannelCode =
  typeof NOTIFY_ALERT_WEBHOOK_POLICY_UNSET | 'alert.channel_unknown' | 'alert.webhook_url_missing' | 'alert.webhook_url_refused';

/** A choice of channels refused before anything is stored. */
export class AlertChannelError extends Error {
  constructor(
    readonly code: AlertChannelCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'AlertChannelError';
  }
}

/** The owner's retry policy, or null while either value is blank or they disagree (one wait for each retry). */
export function webhookPolicy(
  maxAttempts: number | null | undefined,
  backoffMs: readonly number[] | null | undefined,
): WebhookPolicy | null {
  if (!maxAttempts || !backoffMs) return null;
  if (backoffMs.length !== maxAttempts - 1 || backoffMs.some((ms) => !Number.isInteger(ms) || ms <= 0)) return null;
  return { maxAttempts, backoffMs: [...backoffMs] };
}

/** Parses the owner's comma-separated waits ("5000,15000"). Blank or malformed is null, never a default. */
export function parseBackoff(raw: string | undefined): number[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  const parts = raw.split(',').map((part) => part.trim());
  if (parts.some((part) => !/^\d+$/.test(part))) return null;
  return parts.map(Number);
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** Whether a URL names a local TEST receiver: http(s) to this machine's loopback, any port, no credentials. */
export function isLocalTestReceiver(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && LOOPBACK.has(host);
  } catch {
    return false;
  }
}

export type WebhookTargetCheck = (url: string) => Promise<string | null>;

/** The URL check: public https only, plus the local TEST receiver when the switch allows it. Null when it may be called. */
export function webhookTargetCheck(opts: { allowLocalTestReceiver: boolean; resolve?: Resolver }): WebhookTargetCheck {
  return async (url) => {
    if (opts.allowLocalTestReceiver && isLocalTestReceiver(url)) return null;
    return webhookTargetProblem(url, opts.resolve ?? systemResolver);
  };
}

/** Checks a choice of channels and returns it as stored: in-app always, each channel once, a webhook with its checked URL. */
export async function assertChannelChoice(
  input: { readonly channels?: readonly string[] | undefined; readonly webhookUrl?: string | null | undefined },
  policy: WebhookPolicy | null,
  check: WebhookTargetCheck,
): Promise<AlertChannelChoice> {
  const named = input.channels ?? [];
  for (const channel of named) {
    if (!(ALERT_CHANNELS as readonly string[]).includes(channel)) throw new AlertChannelError('alert.channel_unknown', channel);
  }
  const channels = ALERT_CHANNELS.filter((channel) => channel === 'inapp' || named.includes(channel));
  const url = input.webhookUrl?.trim() || null;
  if (!channels.includes('webhook')) return { channels, webhookUrl: null };
  if (policy === null) throw new AlertChannelError(NOTIFY_ALERT_WEBHOOK_POLICY_UNSET, "the webhook channel needs the owner's retry policy");
  if (url === null) throw new AlertChannelError('alert.webhook_url_missing', 'a webhook needs its URL');
  if (url.length > 2048) throw new AlertChannelError('alert.webhook_url_refused', 'too_long');
  const problem = await check(url);
  if (problem !== null) throw new AlertChannelError('alert.webhook_url_refused', problem);
  return { channels, webhookUrl: url };
}

// ── Stores ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type WebhookAttempt = {
  readonly id: string;
  readonly alertId: string;
  readonly userId: string;
  /** Which trigger of the alert: 1 for a one-shot alert, the trigger number for a repeating one. */
  readonly seq: number;
  /** 1 for the first POST, then each retry. */
  readonly attempt: number;
  readonly url: string;
  readonly body: string;
  readonly status: 'pending' | 'delivered' | 'failed';
  readonly httpStatus: number | null;
  readonly error: string | null;
  readonly dueAt: Date;
  readonly attemptedAt: Date | null;
};

export interface AlertDeliveryStore {
  setChoice(userId: string, alertId: string, choice: AlertChannelChoice): Promise<void>;
  /** The choices of these alerts; an alert with none stored reaches the in-app inbox alone. */
  choices(alertIds: readonly string[]): Promise<ReadonlyMap<string, AlertChannelChoice>>;
  /** Queue an attempt. A second queue of the same (alert, trigger, attempt) is a no-op. */
  enqueue(row: Omit<WebhookAttempt, 'id' | 'status' | 'httpStatus' | 'error' | 'attemptedAt'>): Promise<void>;
  /** Take up to `limit` due pending attempts; a taken attempt is not given to another pass until it is recorded. */
  claimDue(now: Date, limit: number): Promise<readonly WebhookAttempt[]>;
  record(id: string, outcome: { status: 'delivered' | 'failed'; httpStatus: number | null; error: string | null; at: Date }): Promise<void>;
  /** The person's attempts, oldest first, for the alerts named or all of theirs. */
  attempts(userId: string, alertIds?: readonly string[]): Promise<readonly WebhookAttempt[]>;
}

export class MemoryAlertDeliveryStore implements AlertDeliveryStore {
  private readonly picks = new Map<string, AlertChannelChoice & { userId: string }>();
  private readonly rows = new Map<string, WebhookAttempt & { claimed: boolean }>();

  async setChoice(userId: string, alertId: string, choice: AlertChannelChoice) {
    this.picks.set(alertId, { ...choice, userId });
  }

  async choices(alertIds: readonly string[]) {
    const out = new Map<string, AlertChannelChoice>();
    for (const id of alertIds) {
      const pick = this.picks.get(id);
      if (pick) out.set(id, { channels: pick.channels, webhookUrl: pick.webhookUrl });
    }
    return out;
  }

  async enqueue(row: Omit<WebhookAttempt, 'id' | 'status' | 'httpStatus' | 'error' | 'attemptedAt'>) {
    const key = `${row.alertId}:${row.seq}:${row.attempt}`;
    if ([...this.rows.values()].some((r) => `${r.alertId}:${r.seq}:${r.attempt}` === key)) return;
    const id = randomUUID();
    this.rows.set(id, { ...row, id, status: 'pending', httpStatus: null, error: null, attemptedAt: null, claimed: false });
  }

  async claimDue(now: Date, limit: number) {
    const due = [...this.rows.values()]
      .filter((r) => r.status === 'pending' && !r.claimed && r.dueAt.getTime() <= now.getTime())
      .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
      .slice(0, limit);
    for (const row of due) this.rows.set(row.id, { ...row, claimed: true });
    return due.map(({ claimed: _claimed, ...row }) => row);
  }

  async record(id: string, outcome: { status: 'delivered' | 'failed'; httpStatus: number | null; error: string | null; at: Date }) {
    const row = this.rows.get(id);
    if (row)
      this.rows.set(id, { ...row, status: outcome.status, httpStatus: outcome.httpStatus, error: outcome.error, attemptedAt: outcome.at });
  }

  async attempts(userId: string, alertIds?: readonly string[]) {
    return [...this.rows.values()]
      .filter((r) => r.userId === userId && (!alertIds || alertIds.includes(r.alertId)))
      .sort((a, b) => a.seq - b.seq || a.attempt - b.attempt)
      .map(({ claimed: _claimed, ...row }) => row);
  }
}

type AttemptRow = {
  id: string;
  alert_id: string;
  user_id: string;
  seq: number;
  attempt: number;
  url: string;
  body: string;
  status: 'pending' | 'delivered' | 'failed';
  http_status: number | null;
  error: string | null;
  due_at: Date;
  attempted_at: Date | null;
};
const ATTEMPT_COLUMNS = 'id, alert_id, user_id, seq, attempt, url, body, status, http_status, error, due_at, attempted_at';
const attemptOf = (r: AttemptRow): WebhookAttempt => ({
  id: r.id,
  alertId: r.alert_id,
  userId: r.user_id,
  seq: r.seq,
  attempt: r.attempt,
  url: r.url,
  body: r.body,
  status: r.status,
  httpStatus: r.http_status,
  error: r.error,
  dueAt: new Date(r.due_at),
  attemptedAt: r.attempted_at ? new Date(r.attempted_at) : null,
});

/** How long a taken attempt stays with its pass before another may take it (a pass that crashed mid-POST). */
const CLAIM_LEASE_MS = 60_000;

/** Postgres-backed. Migration `20261107092357_notify_alert_delivery.sql`. */
export class PostgresAlertDeliveryStore implements AlertDeliveryStore {
  constructor(private readonly sql: Sql) {}

  async setChoice(userId: string, alertId: string, choice: AlertChannelChoice) {
    await this.sql`
      INSERT INTO notify.alert_channels (alert_id, user_id, channels, webhook_url)
      VALUES (${alertId}, ${userId}, ${this.sql.json([...choice.channels] as never)}, ${choice.webhookUrl})
      ON CONFLICT (alert_id) DO UPDATE SET channels = EXCLUDED.channels, webhook_url = EXCLUDED.webhook_url
    `;
  }

  async choices(alertIds: readonly string[]) {
    const out = new Map<string, AlertChannelChoice>();
    if (alertIds.length === 0) return out;
    const rows = await this.sql<{ alert_id: string; channels: AlertChannel[]; webhook_url: string | null }[]>`
      SELECT alert_id, channels, webhook_url FROM notify.alert_channels WHERE alert_id = ANY(${[...alertIds]}::uuid[])
    `;
    for (const row of rows) out.set(row.alert_id, { channels: row.channels, webhookUrl: row.webhook_url });
    return out;
  }

  async enqueue(row: Omit<WebhookAttempt, 'id' | 'status' | 'httpStatus' | 'error' | 'attemptedAt'>) {
    await this.sql`
      INSERT INTO notify.alert_webhook_attempts (id, alert_id, user_id, seq, attempt, url, body, status, due_at)
      VALUES (${randomUUID()}, ${row.alertId}, ${row.userId}, ${row.seq}, ${row.attempt}, ${row.url}, ${row.body}, 'pending', ${row.dueAt})
      ON CONFLICT (alert_id, seq, attempt) DO NOTHING
    `;
  }

  async claimDue(now: Date, limit: number) {
    const lease = new Date(now.getTime() + CLAIM_LEASE_MS);
    const rows = await this.sql<AttemptRow[]>`
      UPDATE notify.alert_webhook_attempts SET claimed_until = ${lease}
      WHERE id IN (
        SELECT id FROM notify.alert_webhook_attempts
        WHERE status = 'pending' AND due_at <= ${now} AND (claimed_until IS NULL OR claimed_until < ${now})
        ORDER BY due_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
      )
      RETURNING ${this.sql.unsafe(ATTEMPT_COLUMNS)}
    `;
    return rows.map(attemptOf);
  }

  async record(id: string, outcome: { status: 'delivered' | 'failed'; httpStatus: number | null; error: string | null; at: Date }) {
    await this.sql`
      UPDATE notify.alert_webhook_attempts
      SET status = ${outcome.status}, http_status = ${outcome.httpStatus}, error = ${outcome.error}, attempted_at = ${outcome.at}
      WHERE id = ${id} AND status = 'pending'
    `;
  }

  async attempts(userId: string, alertIds?: readonly string[]) {
    const rows = alertIds
      ? await this.sql<AttemptRow[]>`
          SELECT ${this.sql.unsafe(ATTEMPT_COLUMNS)} FROM notify.alert_webhook_attempts
          WHERE user_id = ${userId} AND alert_id = ANY(${[...alertIds]}::uuid[]) ORDER BY seq, attempt LIMIT 500
        `
      : await this.sql<AttemptRow[]>`
          SELECT ${this.sql.unsafe(ATTEMPT_COLUMNS)} FROM notify.alert_webhook_attempts
          WHERE user_id = ${userId} ORDER BY created_at DESC, seq, attempt LIMIT 500
        `;
    return rows.map(attemptOf);
  }
}

// ── Delivery ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** POSTs to the local TEST receiver (loopback, http or https), no redirects, returning the HTTP status. */
const localPost: WebhookPost = (raw, body, headers, timeoutMs) =>
  new Promise((settle, fail) => {
    const url = new URL(raw);
    const req = httpRequest(
      url,
      { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) }, timeout: timeoutMs },
      (res) => {
        res.resume();
        res.on('end', () => settle({ ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300, status: res.statusCode ?? 0 }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('webhook timeout')));
    req.on('error', fail);
    req.end(body);
  });

/** The alert's JSON body: what fired, at what price, when, with the person's own name and message. Nothing invented. */
export function webhookBody(
  alert: PriceAlert,
  input: { seq: number; markPrice: string; at: Date; market: string; message: string | null },
): string {
  return JSON.stringify({
    type: 'alert.triggered',
    alertId: alert.id,
    trigger: input.seq,
    market: input.market,
    marketId: alert.marketId,
    condition: alert.condition,
    targetPrice: alert.targetPrice,
    price: input.markPrice,
    name: alert.name,
    message: input.message,
    firedAt: input.at.toISOString(),
  });
}

export class AlertWebhookDelivery {
  private readonly publicPost: WebhookPost;
  constructor(
    private readonly store: AlertDeliveryStore,
    readonly policy: WebhookPolicy | null,
    private readonly opts: {
      readonly allowLocalTestReceiver: boolean;
      readonly timeoutMs: number;
      readonly post?: WebhookPost;
      readonly resolve?: Resolver;
    },
  ) {
    this.publicPost = opts.post ?? pinnedPost(opts.resolve ?? systemResolver);
  }

  /** Queue the first POST of one trigger. Idempotent: the same trigger queued twice is one attempt. */
  async queue(alert: PriceAlert, choice: AlertChannelChoice, seq: number, body: string, at: Date): Promise<void> {
    if (!choice.channels.includes('webhook') || !choice.webhookUrl || !this.policy) return;
    await this.store.enqueue({ alertId: alert.id, userId: alert.userId, seq, attempt: 1, url: choice.webhookUrl, body, dueAt: at });
  }

  /** One pass: every due attempt is POSTed once; a failure queues the next attempt after the policy's wait, until the last. */
  async tick(now: Date = new Date()): Promise<{ delivered: number; failed: number }> {
    if (!this.policy) return { delivered: 0, failed: 0 };
    let delivered = 0;
    let failed = 0;
    for (const attempt of await this.store.claimDue(now, 20)) {
      const outcome = await this.post(attempt);
      const at = new Date();
      await this.store.record(attempt.id, { ...outcome, at });
      if (outcome.status === 'delivered') {
        delivered += 1;
        continue;
      }
      failed += 1;
      if (attempt.attempt < this.policy.maxAttempts) {
        const wait = this.policy.backoffMs[attempt.attempt - 1]!;
        await this.store.enqueue({ ...attempt, attempt: attempt.attempt + 1, dueAt: new Date(at.getTime() + wait) });
      }
    }
    return { delivered, failed };
  }

  private async post(
    attempt: WebhookAttempt,
  ): Promise<{ status: 'delivered' | 'failed'; httpStatus: number | null; error: string | null }> {
    const local = this.opts.allowLocalTestReceiver && isLocalTestReceiver(attempt.url);
    // Checked again at send time: a stored public URL whose name now points somewhere private is refused, not called.
    if (!local) {
      const url = new URL(attempt.url);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (url.protocol !== 'https:' || (isIP(host) && privateAddress(host))) {
        return { status: 'failed', httpStatus: null, error: 'notify.alert_webhook_target_refused' };
      }
    }
    try {
      const answer = await (local ? localPost : this.publicPost)(
        attempt.url,
        attempt.body,
        { 'content-type': 'application/json', 'user-agent': 'intafaced-alerts/1', 'x-intafaced-alert-attempt': String(attempt.attempt) },
        this.opts.timeoutMs,
      );
      return answer.ok
        ? { status: 'delivered', httpStatus: answer.status ?? 200, error: null }
        : { status: 'failed', httpStatus: answer.status ?? null, error: `HTTP ${answer.status ?? 'error'}` };
    } catch (err) {
      return { status: 'failed', httpStatus: null, error: (err as Error).message.slice(0, 300) };
    }
  }
}
