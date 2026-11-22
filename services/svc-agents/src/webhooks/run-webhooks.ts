import { createHmac, randomBytes } from 'node:crypto';
import type { Queryable } from '@intafaced/db';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { pinnedPost, type WebhookTransport } from './webhook-pinned-post.js';
import {
  assertPublicWebhookUrl,
  publicDnsResolver,
  resolvePublicAddresses,
  systemResolver,
  WebhookUrlRefusal,
  type WebhookResolver,
} from './webhook-url-guard.js';

/**
 * Webhooks for the runs a person started in their own session (AG-sessions-04; J-agents-12 #5). A person's own code
 * registers an endpoint with their API key (agents:read: registering starts and changes no run); every run of theirs
 * that ends afterwards is delivered once to each endpoint they had when it ended, signed with that endpoint's secret.
 *
 * The delivery row is written in the transaction that ends the run (`enqueueRunFinished`), so a run never ends without
 * its delivery, and a crash after the commit leaves the delivery due for the next drain. Each post is claimed with a
 * lease, so two drains never post one at once, and carries its event id (`x-intafaced-event-id`, also its
 * `idempotency-key`), so a receiver keeps it once. One attempt per delivery: an endpoint that does not take it is marked
 * failed with its answer. The payload carries ids, the state, the reply, the cost and the refusal codes, never the prompt.
 * Nothing here moves value.
 */

/** Which kind of run ended: one `run.complete` (the room's run) or a background run of the session. */
export type FinishedRunKind = 'run' | 'background';

export interface FinishedRun {
  /** The event's business key: one per run ending (`agents.run.finished:<run id>:<event sequence>`). */
  readonly eventId: string;
  readonly kind: FinishedRunKind;
  readonly userId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly state: string;
  readonly reply: string | null;
  readonly cost: string | null;
  readonly assetId: string | null;
  readonly refusalCodes: readonly string[];
}

export interface RunWebhookEndpoint {
  readonly id: string;
  readonly url: string;
  readonly createdAt: string;
  /** The signing secret, shown once: on the register that made the endpoint, null on every other read. */
  readonly secret: string | null;
}

export interface RunWebhookDelivery {
  readonly eventId: string;
  readonly endpointId: string;
  readonly runId: string;
  readonly kind: FinishedRunKind;
  readonly runState: string;
  readonly state: 'pending' | 'delivered' | 'failed';
  readonly attempts: number;
  readonly lastStatus: number | null;
  readonly lastError: string | null;
  readonly deliveredAt: string | null;
}

/** A register the service refuses by name. */
export class RunWebhookConflict extends Error {
  readonly code = 'agents.webhook_endpoint_conflict' as const;
  constructor() {
    super('agents.webhook_endpoint_conflict');
    this.name = 'RunWebhookConflict';
  }
}

export interface RunWebhookOptions {
  /** dev/test only: an endpoint on loopback, over http, is allowed (the URL guard's hatch). */
  readonly allowLocalHttp?: boolean;
  readonly transport?: WebhookTransport;
  readonly resolver?: WebhookResolver;
  /** How long one delivery attempt may take. */
  readonly deliveryTimeoutMs?: number;
}

export const finishedEventId = (kind: FinishedRunKind, runId: string, sequence: number) =>
  `agents.${kind === 'run' ? 'run' : 'background_run'}.finished:${runId}:${sequence}`;

/**
 * Writes the ended run's delivery to every endpoint the person has now, in the caller's transaction. The same event
 * again writes nothing.
 */
export async function enqueueRunFinished(tx: Queryable, run: FinishedRun): Promise<void> {
  const payload = {
    id: run.eventId,
    type: 'agents.run.finished',
    kind: run.kind,
    runId: run.runId,
    sessionId: run.sessionId,
    agentId: run.agentId,
    state: run.state,
    reply: run.reply,
    cost: run.cost,
    assetId: run.assetId,
    refusalCodes: run.refusalCodes,
  };
  await tx`
    INSERT INTO agents.run_webhook_deliveries (event_id, endpoint_id, user_id, run_id, payload)
    SELECT ${run.eventId}, e.id, e.user_id, ${run.runId}::uuid, (${JSON.stringify(payload)}::text)::jsonb
      FROM agents.run_webhook_endpoints e
     WHERE e.user_id = ${run.userId} AND e.disabled_at IS NULL
    ON CONFLICT DO NOTHING
  `;
}

const LEASE_MS = 60_000;
const DRAIN_BATCH = 20;

const DeliveryRow = z.object({
  event_id: z.string(),
  endpoint_id: z.string(),
  run_id: z.string(),
  payload: z.object({ kind: z.enum(['run', 'background']), state: z.string() }).passthrough(),
  state: z.enum(['pending', 'delivered', 'failed']),
  attempts: z.number().int(),
  last_status: z.number().int().nullable(),
  last_error: z.string().nullable(),
  delivered_at: z.date().nullable(),
});
type DeliveryRow = z.infer<typeof DeliveryRow>;
const EndpointRow = z.object({ id: z.string(), url: z.string(), created_at: z.date() });
const OwnedEndpointRow = EndpointRow.extend({ user_id: z.string() });
const ClaimedRow = z.object({ event_id: z.string(), endpoint_id: z.string(), payload: z.unknown(), url: z.string(), secret: z.string() });
type ClaimedRow = z.infer<typeof ClaimedRow>;

const deliveryView = (d: DeliveryRow): RunWebhookDelivery => ({
  eventId: d.event_id,
  endpointId: d.endpoint_id,
  runId: d.run_id,
  kind: d.payload.kind,
  runState: d.payload.state,
  state: d.state,
  attempts: d.attempts,
  lastStatus: d.last_status,
  lastError: d.last_error,
  deliveredAt: d.delivered_at ? d.delivered_at.toISOString() : null,
});

export class RunWebhooks {
  private readonly allowLocalHttp: boolean;
  private readonly transport: WebhookTransport;
  private readonly resolver: WebhookResolver;
  private readonly timeoutMs: number;
  private draining: Promise<number> | null = null;

  constructor(
    private readonly sql: Sql,
    options: RunWebhookOptions = {},
  ) {
    this.allowLocalHttp = options.allowLocalHttp === true;
    this.transport = options.transport ?? pinnedPost;
    this.resolver = options.resolver ?? (this.allowLocalHttp ? systemResolver : publicDnsResolver);
    this.timeoutMs = options.deliveryTimeoutMs ?? 10_000;
  }

  /** Adds an endpoint, once per `endpointId`; its signing secret is shown on the register that made it, and never again. */
  async register(userId: string, input: { endpointId: string; url: string }): Promise<RunWebhookEndpoint> {
    const url = assertPublicWebhookUrl(input.url, { allowLocalHttp: this.allowLocalHttp }).toString();
    const secret = `whsec_${randomBytes(32).toString('hex')}`;
    const made = EndpointRow.array().parse(
      await this.sql`
      INSERT INTO agents.run_webhook_endpoints (id, user_id, url, secret) VALUES (${input.endpointId}::uuid, ${userId}, ${url}, ${secret})
      ON CONFLICT (id) DO NOTHING
      RETURNING id::text AS id, url, created_at
    `,
    );
    if (made[0]) return { id: made[0].id, url: made[0].url, createdAt: made[0].created_at.toISOString(), secret };
    const [prior] = OwnedEndpointRow.array().parse(
      await this.sql`
      SELECT id::text AS id, user_id, url, created_at FROM agents.run_webhook_endpoints WHERE id = ${input.endpointId}::uuid
    `,
    );
    // Someone else's id, or the same id for another address: refused, and nothing about the other endpoint is told.
    if (!prior || prior.user_id !== userId || prior.url !== url) throw new RunWebhookConflict();
    return { id: prior.id, url: prior.url, createdAt: prior.created_at.toISOString(), secret: null };
  }

  async list(userId: string, limit: number): Promise<RunWebhookEndpoint[]> {
    const rows = EndpointRow.array().parse(
      await this.sql`
      SELECT id::text AS id, url, created_at FROM agents.run_webhook_endpoints
       WHERE user_id = ${userId} AND disabled_at IS NULL ORDER BY created_at, id LIMIT ${limit}
    `,
    );
    return rows.map((r) => ({ id: r.id, url: r.url, createdAt: r.created_at.toISOString(), secret: null }));
  }

  /** The caller's deliveries, oldest first, each with its attempts and the endpoint's last answer. */
  async deliveries(userId: string, input: { endpointId?: string | undefined; runId?: string | undefined; limit: number }) {
    const rows = DeliveryRow.array().parse(
      await this.sql`
      SELECT event_id, endpoint_id::text AS endpoint_id, run_id::text AS run_id, payload, state, attempts, last_status,
             last_error, delivered_at, created_at
        FROM agents.run_webhook_deliveries
       WHERE user_id = ${userId}
         AND (${input.endpointId ?? null}::uuid IS NULL OR endpoint_id = ${input.endpointId ?? null}::uuid)
         AND (${input.runId ?? null}::uuid IS NULL OR run_id = ${input.runId ?? null}::uuid)
       ORDER BY created_at, event_id, endpoint_id
       LIMIT ${input.limit}
    `,
    );
    return rows.map(deliveryView);
  }

  /** Posts every delivery that is due; returns how many it posted. A drain already running is joined, not doubled. */
  async drain(limit = DRAIN_BATCH): Promise<number> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      let posted = 0;
      try {
        while (posted < limit) {
          const claimed = ClaimedRow.array().parse(
            await this.sql`
            WITH due AS (
              SELECT event_id, endpoint_id FROM agents.run_webhook_deliveries
               WHERE state = 'pending' AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until <= now())
               ORDER BY next_attempt_at
               LIMIT ${Math.min(DRAIN_BATCH, limit)}
               FOR UPDATE SKIP LOCKED
            )
            UPDATE agents.run_webhook_deliveries d SET lease_until = now() + ${`${LEASE_MS} milliseconds`}::interval
              FROM due, agents.run_webhook_endpoints w
             WHERE d.event_id = due.event_id AND d.endpoint_id = due.endpoint_id AND w.id = d.endpoint_id
            RETURNING d.event_id, d.endpoint_id::text AS endpoint_id, d.payload, w.url, w.secret
          `,
          );
          if (claimed.length === 0) break;
          for (const d of claimed) {
            await this.post(d);
            posted++;
          }
        }
        return posted;
      } finally {
        this.draining = null;
      }
    })();
    return this.draining;
  }

  private async post(d: ClaimedRow): Promise<void> {
    const body = JSON.stringify(d.payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', d.secret).update(`${timestamp}.${body}`).digest('hex');
    let status: number | null = null;
    let error: string | null = null;
    try {
      const url = assertPublicWebhookUrl(d.url, { allowLocalHttp: this.allowLocalHttp });
      const addresses = await resolvePublicAddresses(url.hostname, this.resolver, { allowLoopback: this.allowLocalHttp });
      status = (
        await this.transport({
          url,
          addresses,
          body,
          timeoutMs: this.timeoutMs,
          headers: {
            'content-type': 'application/json',
            'x-intafaced-event-id': d.event_id,
            'idempotency-key': d.event_id,
            'x-intafaced-timestamp': timestamp,
            'x-intafaced-signature': `v1=${signature}`,
          },
        })
      ).status;
    } catch (err) {
      error = err instanceof WebhookUrlRefusal ? err.code : 'unreachable';
    }
    const delivered = status !== null && status >= 200 && status < 300;
    await this.sql`
      UPDATE agents.run_webhook_deliveries
         SET attempts = attempts + 1, last_status = ${status}, last_error = ${error}, lease_until = NULL,
             state = ${delivered ? 'delivered' : 'failed'}, delivered_at = ${delivered ? new Date() : null}
       WHERE event_id = ${d.event_id} AND endpoint_id = ${d.endpoint_id}::uuid
    `;
  }
}
