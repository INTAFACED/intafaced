import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { SqlReconAlertFeedStore, type ReconAlertTransition } from './feed.js';

/** The reconciliation alert feed on the real table: concurrent deliveries of one transition store one row. Each run uses its own alert id. */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? process.env.TEST_DATABASE_URL;
const migrations = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const available = URL ? await postgresAvailable(URL) : false;
const client: Sql | null = URL && available ? postgres(URL, { max: 4, onnotice: () => undefined }) : null;

beforeAll(async () => {
  if (!client) return;
  const name = await client<{ db: string }[]>`SELECT current_database() AS db`;
  if (name[0]?.db !== 'test') await assertTestDatabase(client, 'svc-notify reconciliation alert feed.pg.test');
  await client.unsafe('CREATE SCHEMA IF NOT EXISTS notify');
  await client.unsafe(readFileSync(join(migrations, '20261118141504_notify_reconciliation_alert_feed.sql'), 'utf8'));
});

afterAll(async () => {
  await client?.end({ timeout: 1 }).catch(() => undefined);
});

if (!client) {
  describe.skip('reconciliation alert feed (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('reconciliation alert feed on the shared test database', () => {
    const transition = (
      alertId: string,
      sequence: number,
      eventKey = `ops:reconciliation-alert:${alertId}:${sequence}`,
    ): ReconAlertTransition => ({
      eventKey,
      alertId,
      sequence,
      kind: sequence === 1 ? 'opened' : 'reopened',
      team: sequence === 1 ? 'finance' : null,
      state: 'open',
      actor: 'auto',
      occurredAt: `2026-11-18T10:0${sequence}:00.000Z`,
    });

    it('stores a transition delivered three times at once as one row, and reads the alert in sequence order', async () => {
      const store = new SqlReconAlertFeedStore(client!);
      const alertId = randomUUID();
      const results = await Promise.all([1, 2, 3].map(() => store.record(transition(alertId, 2), new Date())));
      expect(results.filter((r) => r.inserted)).toHaveLength(1);
      expect((await store.record(transition(alertId, 1), new Date())).inserted).toBe(true);
      // The same alert and sequence under another key is the same transition: refused, not a second row.
      expect((await store.record(transition(alertId, 2, `ops:reconciliation-alert:${alertId}:2:again`), new Date())).inserted).toBe(false);
      const rows = await store.list(alertId);
      expect(rows.map((r) => [r.sequence, r.kind, r.team])).toEqual([
        [1, 'opened', 'finance'],
        [2, 'reopened', null],
      ]);
    });

    it('refuses a kind or team it does not know', async () => {
      const id = randomUUID();
      await expect(
        client!`INSERT INTO notify.reconciliation_alert_feed (event_key, alert_id, sequence, kind, state, actor, occurred_at)
                VALUES (${`k:${id}`}, ${id}, 1, 'deleted', 'open', 'auto', now())`,
      ).rejects.toThrow();
      await expect(
        client!`INSERT INTO notify.reconciliation_alert_feed (event_key, alert_id, sequence, kind, team, state, actor, occurred_at)
                VALUES (${`k:${id}`}, ${id}, 1, 'opened', 'sales', 'open', 'auto', now())`,
      ).rejects.toThrow();
    });
  });
}
