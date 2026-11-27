import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { PostgresTelegramStore } from './store.js';

/**
 * The Telegram desk's store on the real tables: a code links once, concurrently or not; a chat holds one person; an alert
 * key is raised once under concurrent sweeps; unlinking drops the unsent alerts. Each run uses its own ids.
 */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? process.env.TEST_DATABASE_URL;
const migrations = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const available = URL ? await postgresAvailable(URL) : false;
const client: Sql | null = URL && available ? postgres(URL, { max: 6, onnotice: () => undefined }) : null;
const digest = (code: string) => createHash('sha256').update(code).digest('hex');

beforeAll(async () => {
  if (!client) return;
  const name = await client<{ db: string }[]>`SELECT current_database() AS db`;
  if (name[0]?.db !== 'test') await assertTestDatabase(client, 'svc-notify telegram store.pg.test');
  await client.unsafe(readFileSync(join(migrations, '20261127102114_notify_telegram_desk.sql'), 'utf8'));
});

afterAll(async () => {
  await client?.end({ timeout: 1 }).catch(() => undefined);
});

if (!client) {
  describe.skip('telegram store (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('telegram store on the shared test database', () => {
    const store = new PostgresTelegramStore(client);
    const now = new Date('2026-11-25T10:00:00Z');

    it('a code links once, even when two chats send it at the same moment', async () => {
      const user = `u-${randomUUID()}`;
      const code = digest(randomUUID());
      await store.putCode(user, code, new Date(now.getTime() + 600_000));
      const chats = [`c-${randomUUID()}`, `c-${randomUUID()}`];
      const outs = await Promise.all(chats.map((c) => store.redeemCode(code, c, now)));
      expect(outs.filter((o) => o.ok)).toHaveLength(1);
      expect(outs.filter((o) => !o.ok)).toEqual([{ ok: false, reason: 'invalid' }]);
      expect((await store.linkByUser(user))?.linkedAt.toISOString()).toBe(now.toISOString());
    });

    it('an expired code and a replaced code link nothing', async () => {
      const user = `u-${randomUUID()}`;
      const first = digest(randomUUID());
      const second = digest(randomUUID());
      await store.putCode(user, first, new Date(now.getTime() + 600_000));
      await store.putCode(user, second, new Date(now.getTime() + 600_000));
      expect(await store.redeemCode(first, `c-${randomUUID()}`, now)).toEqual({ ok: false, reason: 'invalid' });
      expect(await store.redeemCode(second, `c-${randomUUID()}`, new Date(now.getTime() + 600_000))).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('a chat linked to one person is refused for another', async () => {
      const [a, b] = [`u-${randomUUID()}`, `u-${randomUUID()}`];
      const chat = `c-${randomUUID()}`;
      const [ca, cb] = [digest(randomUUID()), digest(randomUUID())];
      await store.putCode(a, ca, new Date(now.getTime() + 600_000));
      await store.putCode(b, cb, new Date(now.getTime() + 600_000));
      expect((await store.redeemCode(ca, chat, now)).ok).toBe(true);
      expect(await store.redeemCode(cb, chat, now)).toEqual({ ok: false, reason: 'chat_taken' });
    });

    it('an alert key is raised once under concurrent sweeps, sent once, and unlinking drops the unsent', async () => {
      const user = `u-${randomUUID()}`;
      const claims = await Promise.all(
        [1, 2, 3, 4].map(() => store.claimAlert({ userId: user, alertKey: 'fill:f1', text: 'Fill', at: now })),
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
      await store.claimAlert({ userId: user, alertKey: 'fill:f2', text: 'Fill 2', at: now });
      const mine = (await store.unsent(10_000)).filter((r) => r.userId === user);
      expect(mine.map((r) => r.alertKey).sort()).toEqual(['fill:f1', 'fill:f2']);
      await store.markSent(user, 'fill:f1', now);
      await store.unlink(user);
      expect((await store.unsent(10_000)).filter((r) => r.userId === user)).toEqual([]);
      expect(await store.claimAlert({ userId: user, alertKey: 'fill:f1', text: 'Fill', at: now })).toBe(false);
    });

    it('profit targets and margin marks round-trip', async () => {
      const user = `u-${randomUUID()}`;
      expect(await store.profitTarget(user)).toBeNull();
      await store.setProfitTarget(user, '250.5');
      expect(await store.profitTarget(user)).toBe('250.5');
      await store.setProfitTarget(user, null);
      expect(await store.profitTarget(user)).toBeNull();
      expect(await store.mark(user, 'margin:x:80')).toEqual({ episode: 0, armed: true });
      await store.setMark(user, 'margin:x:80', { episode: 3, armed: false });
      expect(await store.mark(user, 'margin:x:80')).toEqual({ episode: 3, armed: false });
    });
  });
}
