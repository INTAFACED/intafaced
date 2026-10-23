/** Postgres store for status subscriptions (SP-status-04), on the tables of 0028_notify_status_subscriptions.sql. */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { StatusSubscriberState } from '@intafaced/contracts';
import type { Delivery, DeliveryStatus, Subscriber, SubscriberSummary, SubscriptionStore } from './subscriptions.js';

type SubscriberRow = {
  id: string;
  email: string;
  state: StatusSubscriberState;
  component_ids: string[] | null;
  webhook_url: string | null;
  revision: number;
  source: string | null;
};

type DeliveryRow = {
  key: string;
  subscriber_id: string;
  event: string;
  channel: 'email' | 'webhook';
  status: DeliveryStatus;
  refusal_code: string | null;
  attempts: number;
};

const COLUMNS = 'id, email, state, component_ids, webhook_url, revision, source';

const fromRow = (row: SubscriberRow): Subscriber => ({
  id: row.id,
  email: row.email,
  state: row.state,
  componentIds: row.component_ids,
  webhookUrl: row.webhook_url,
  revision: row.revision,
  source: row.source,
});

const fromDelivery = (row: DeliveryRow): Delivery => ({
  key: row.key,
  subscriberId: row.subscriber_id,
  event: row.event,
  channel: row.channel,
  status: row.status,
  refusalCode: row.refusal_code,
  attempts: row.attempts,
});

export class SqlSubscriptionStore implements SubscriptionStore {
  constructor(private readonly sql: Sql) {}

  async subscribe(email: string, componentIds: readonly string[] | null, at: Date): Promise<Subscriber> {
    const ids = componentIds === null ? null : this.sql.json([...componentIds] as never);
    return this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO notify.status_subscribers (id, email, state, component_ids, revision, created_at, updated_at)
        VALUES (${randomUUID()}, ${email}, 'unconfirmed', ${ids}, 1, ${at}, ${at})
        ON CONFLICT (email) DO NOTHING
      `;
      const [row] = await tx<SubscriberRow[]>`
        SELECT ${tx.unsafe(COLUMNS)} FROM notify.status_subscribers WHERE email = ${email} FOR UPDATE
      `;
      if (row!.state === 'active') return fromRow(row!);
      const [next] = await tx<SubscriberRow[]>`
        UPDATE notify.status_subscribers
        SET component_ids = ${ids}, updated_at = ${at},
            webhook_url = CASE WHEN state = 'unsubscribed' THEN NULL ELSE webhook_url END,
            revision = CASE WHEN state = 'unsubscribed' THEN revision + 1 ELSE revision END,
            state = 'unconfirmed'
        WHERE id = ${row!.id}
        RETURNING ${tx.unsafe(COLUMNS)}
      `;
      return fromRow(next!);
    }) as Promise<Subscriber>;
  }

  async byId(id: string): Promise<Subscriber | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [row] = await this.sql<SubscriberRow[]>`SELECT ${this.sql.unsafe(COLUMNS)} FROM notify.status_subscribers WHERE id = ${id}`;
    return row ? fromRow(row) : null;
  }

  async byEmail(email: string): Promise<Subscriber | null> {
    const [row] = await this.sql<SubscriberRow[]>`SELECT ${this.sql.unsafe(COLUMNS)} FROM notify.status_subscribers WHERE email = ${email}`;
    return row ? fromRow(row) : null;
  }

  async update(id: string, change: Partial<Pick<Subscriber, 'state' | 'componentIds' | 'webhookUrl'>>, at: Date): Promise<Subscriber> {
    const [row] = await this.sql<SubscriberRow[]>`
      UPDATE notify.status_subscribers SET
        state = ${change.state === undefined ? this.sql`state` : change.state},
        component_ids = ${change.componentIds === undefined ? this.sql`component_ids` : change.componentIds === null ? null : this.sql.json([...change.componentIds] as never)},
        webhook_url = ${change.webhookUrl === undefined ? this.sql`webhook_url` : change.webhookUrl},
        updated_at = ${at}
      WHERE id = ${id}
      RETURNING ${this.sql.unsafe(COLUMNS)}
    `;
    return fromRow(row!);
  }

  async countAndRecordRequest(email: string, since: Date, at: Date): Promise<number> {
    return this.sql.begin(async (tx) => {
      // One address at a time, so two requests at once cannot both read the count below the limit.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`status-subscribe:${email}`}))`;
      const [counted] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM notify.status_subscribe_requests WHERE email = ${email} AND requested_at >= ${since}
      `;
      await tx`INSERT INTO notify.status_subscribe_requests (email, requested_at) VALUES (${email}, ${at})`;
      // Rows older than the window count for nothing.
      await tx`DELETE FROM notify.status_subscribe_requests WHERE email = ${email} AND requested_at < ${since}`;
      return counted!.n;
    }) as Promise<number>;
  }

  async useChallenge(tokenHash: string, at: Date, expiredBefore: Date): Promise<boolean> {
    // A challenge older than the link lifetime already fails its signature check, so its spent row can go.
    await this.sql`DELETE FROM notify.status_challenges_used WHERE used_at < ${expiredBefore}`;
    const rows = await this.sql`
      INSERT INTO notify.status_challenges_used (token_hash, used_at) VALUES (${tokenHash}, ${at}) ON CONFLICT DO NOTHING RETURNING token_hash
    `;
    return rows.length === 1;
  }

  async claimDelivery(row: Pick<Delivery, 'key' | 'subscriberId' | 'event' | 'channel'>, at: Date): Promise<Delivery> {
    await this.sql`
      INSERT INTO notify.status_deliveries (key, subscriber_id, event, channel, status, created_at, updated_at)
      VALUES (${row.key}, ${row.subscriberId}, ${row.event}, ${row.channel}, 'pending', ${at}, ${at})
      ON CONFLICT (key) DO NOTHING
    `;
    const [stored] = await this.sql<DeliveryRow[]>`SELECT * FROM notify.status_deliveries WHERE key = ${row.key}`;
    return fromDelivery(stored!);
  }

  async takeDelivery(key: string, at: Date, until: Date): Promise<boolean> {
    const rows = await this.sql`
      UPDATE notify.status_deliveries SET claimed_until = ${until}
      WHERE key = ${key} AND status IN ('pending', 'failed') AND (claimed_until IS NULL OR claimed_until <= ${at})
      RETURNING key
    `;
    return rows.length === 1;
  }

  async settleDelivery(key: string, status: DeliveryStatus, refusalCode: string | null, at: Date, lease?: Date): Promise<void> {
    await this.sql`
      UPDATE notify.status_deliveries
      SET status = ${status}, refusal_code = ${refusalCode}, attempts = attempts + 1, updated_at = ${at}, claimed_until = NULL
      WHERE key = ${key} AND status NOT IN ('accepted', 'refused')
        AND ${lease === undefined ? this.sql`TRUE` : this.sql`claimed_until = ${lease}`}
    `;
  }

  async unsettledDeliveries(event: string): Promise<readonly Delivery[]> {
    const rows = await this.sql<DeliveryRow[]>`
      SELECT * FROM notify.status_deliveries WHERE event = ${event} AND status IN ('pending', 'failed') ORDER BY created_at, key
    `;
    return rows.map(fromDelivery);
  }

  async eventDeliveries(event: string, limit: number): Promise<readonly (Delivery & { readonly email: string })[]> {
    const rows = await this.sql<(DeliveryRow & { email: string })[]>`
      SELECT d.*, s.email FROM notify.status_deliveries d JOIN notify.status_subscribers s ON s.id = d.subscriber_id
       WHERE d.event = ${event}
       ORDER BY s.email, d.channel
       LIMIT ${limit}
    `;
    return rows.map((row) => ({ ...fromDelivery(row), email: row.email }));
  }

  async list(state: Subscriber['state'] | null, limit: number): Promise<readonly SubscriberSummary[]> {
    const rows = await this.sql<
      (SubscriberRow & { created_at: Date; pending: number; accepted: number; failed: number; refused: number })[]
    >`
      WITH page AS (
        SELECT id, email, state, component_ids, webhook_url, revision, source, created_at
          FROM notify.status_subscribers
         WHERE ${state === null ? this.sql`TRUE` : this.sql`state = ${state}`}
         ORDER BY created_at DESC, id
         LIMIT ${limit}
      )
      SELECT s.*,
             count(d.key) FILTER (WHERE d.status = 'pending')::int AS pending,
             count(d.key) FILTER (WHERE d.status = 'accepted')::int AS accepted,
             count(d.key) FILTER (WHERE d.status = 'failed')::int AS failed,
             count(d.key) FILTER (WHERE d.status = 'refused')::int AS refused
        FROM page s LEFT JOIN notify.status_deliveries d ON d.subscriber_id = s.id
       GROUP BY s.id, s.email, s.state, s.component_ids, s.webhook_url, s.revision, s.source, s.created_at
       ORDER BY s.created_at DESC, s.id
    `;
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      state: row.state,
      componentIds: row.component_ids,
      source: row.source,
      webhook: row.webhook_url !== null,
      createdAt: row.created_at.toISOString(),
      deliveries: { pending: row.pending, accepted: row.accepted, failed: row.failed, refused: row.refused },
    }));
  }

  async importSubscriber(email: string, source: string, at: Date): Promise<{ subscriber: Subscriber; added: boolean }> {
    const inserted = await this.sql<SubscriberRow[]>`
      INSERT INTO notify.status_subscribers (id, email, state, component_ids, revision, source, created_at, updated_at)
      VALUES (${randomUUID()}, ${email}, 'unconfirmed', NULL, 1, ${source}, ${at}, ${at})
      ON CONFLICT (email) DO NOTHING
      RETURNING ${this.sql.unsafe(COLUMNS)}
    `;
    if (inserted[0]) return { subscriber: fromRow(inserted[0]), added: true };
    return { subscriber: (await this.byEmail(email))!, added: false };
  }

  async deliveries(subscriberId: string): Promise<readonly Delivery[]> {
    const rows = await this.sql<DeliveryRow[]>`
      SELECT * FROM notify.status_deliveries WHERE subscriber_id = ${subscriberId} ORDER BY created_at, key
    `;
    return rows.map(fromDelivery);
  }

  async active(): Promise<readonly Subscriber[]> {
    const rows = await this.sql<SubscriberRow[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM notify.status_subscribers WHERE state = 'active' ORDER BY created_at, id
    `;
    return rows.map(fromRow);
  }
}
