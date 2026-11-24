import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { SqlBuilderModeAlertStore } from './builder-mode-store.js';

// J-ops-console-28: trade.builder_mode_alerts holds one open alert per venue and builder address, however many checks,
// retries or concurrent reads try to open it; clearing sets its time and mode once.

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. The builder-mode alert store test does not start Docker.');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const BUILDER = '0x116d8f7751e72306d499dd61ae826e46a726c632';
const CONTACT = 'TEST founders on call (oncall@intafaced.test)';
const at = (m: number) => new Date(Date.UTC(2026, 10, 21, 3, m));
const opening = (venueId: string, m: number) => ({
  venueId,
  builder: BUILDER,
  modeSeen: 'unified',
  requiredMode: 'standard',
  contact: CONTACT,
  at: at(m),
});

describe('SqlBuilderModeAlertStore on Postgres (trade.builder_mode_alerts)', () => {
  let db: TestDatabase | undefined;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('opens one alert per episode under concurrent opens, clears it once with its time, and opens the next episode anew', async () => {
    const store = new SqlBuilderModeAlertStore(db!.sql);
    const opens = await Promise.all(Array.from({ length: 10 }, (_, i) => store.open(opening('test-venue-sim', i))));
    expect(opens.filter((o) => o !== null)).toHaveLength(1);
    expect(await store.open(opening('test-venue-sim', 20))).toBeNull();
    // Another venue's episode is its own.
    expect(await store.open(opening('test-venue-sim-b', 1))).toMatchObject({ venueId: 'test-venue-sim-b', contact: CONTACT });

    const clears = await Promise.all(
      Array.from({ length: 5 }, () => store.clear({ venueId: 'test-venue-sim', builder: BUILDER, mode: 'standard', at: at(30) })),
    );
    expect(clears.filter((c) => c !== null)).toEqual([expect.objectContaining({ clearedAt: at(30), clearedMode: 'standard' })]);
    expect(await store.clear({ venueId: 'test-venue-sim', builder: BUILDER, mode: 'standard', at: at(31) })).toBeNull();

    const next = await store.open(opening('test-venue-sim', 40));
    expect(next).toMatchObject({ openedAt: at(40), clearedAt: null, clearedMode: null });
    const recent = await store.recent(10);
    expect(recent.map((r) => [r.venueId, r.clearedAt?.toISOString() ?? null])).toEqual([
      ['test-venue-sim', null],
      ['test-venue-sim-b', null],
      ['test-venue-sim', at(30).toISOString()],
    ]);
    expect(recent[2]).toMatchObject({ modeSeen: 'unified', requiredMode: 'standard', contact: CONTACT, builder: BUILDER });
  });
});
