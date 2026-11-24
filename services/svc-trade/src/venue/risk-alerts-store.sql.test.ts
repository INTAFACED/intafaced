import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client/money';
import { SqlRiskAlertStore, type RiskAlertClaim } from './risk-alerts-store.js';

// trade.user_venue_risk_alert_* (J-derivatives-06 #6 #7): a crossing is written once while its kind is armed, a key is
// never reused, editing one level re-arms only its kind, and an alert row is never deleted, never changes what it said,
// and records its publication once.

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. The risk alert store test does not start Docker.');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111f6';
const VENUE = 'test-venue-sim';
const OWNER = '0x00000000000000000000000000000000000000f6';
const SETTING = '22222222-2222-4222-8222-2222222222f6';

describe('SqlRiskAlertStore on Postgres (trade.user_venue_risk_alert_*)', () => {
  let db: TestDatabase | undefined;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('writes each crossing once while armed, re-arms only an edited level, and never reuses a key', async () => {
    const store = new SqlRiskAlertStore(db!.sql);
    const at = new Date('2026-11-24T02:00:00Z');
    const position = { userId: USER, venueId: VENUE, owner: OWNER, symbol: 'BTC-PERP' };
    const s = await store.save({ ...position, id: SETTING, marginLevel: null, ratioLevel: null, at });
    expect(s).toMatchObject({ enabled: true, marginLevel: null, ratioLevel: null, nextSequence: 1 });
    expect(s.armed).toEqual({ margin: true, margin_call: true, liquidation: true });

    const claim = (kind: RiskAlertClaim['kind']): RiskAlertClaim => ({
      settingId: s.id,
      kind,
      asset: 'USDC',
      level: a('100'),
      marginWithResult: a('5.5'),
      maintenance: a('6.01'),
      marginRatio: a('109.272727272727272727'),
      asked: a('0.51'),
      alertKeyOf: (n) => `risk:${USER}:${VENUE}:${OWNER}:BTC-PERP:${n}`,
      at,
    });
    const first = await store.claim(claim('liquidation'));
    expect(first).toMatchObject({ sequence: 1, kind: 'liquidation', asked: a('0.51'), publishedAt: null });
    // Disarmed: the same crossing writes nothing more.
    expect(await store.claim(claim('liquidation'))).toBeNull();
    await store.setArmed(s.id, { kind: 'liquidation', armed: true }, at);
    expect(await store.claim(claim('liquidation'))).toMatchObject({ sequence: 2 });

    // Setting a margin level re-arms the margin kind only.
    await store.setArmed(s.id, { kind: 'margin_call', armed: false }, at);
    const edited = await store.save({
      ...position,
      id: '33333333-3333-4333-8333-3333333333f6',
      marginLevel: a('50'),
      ratioLevel: null,
      at,
    });
    expect(edited.id).toBe(s.id);
    expect(edited.armed).toEqual({ margin: true, margin_call: false, liquidation: false });

    // Off: nothing is written, and turning on again arms every kind.
    await store.turnOff(s.id, at);
    expect(await store.claim(claim('margin'))).toBeNull();
    const on = await store.save({ ...position, id: SETTING, marginLevel: a('50'), ratioLevel: a('40'), at });
    expect(on.armed).toEqual({ margin: true, margin_call: true, liquidation: true });
    expect((await store.enabled()).map((x) => x.id)).toEqual([s.id]);

    // Published once; the account's alerts newest first.
    expect((await store.unpublished(10)).map((x) => x.sequence)).toEqual([1, 2]);
    await store.markPublished(first!.alertKey, at);
    expect((await store.unpublished(10)).map((x) => x.sequence)).toEqual([2]);
    expect((await store.alerts({ userId: USER, venueId: VENUE, owner: OWNER }, 10)).map((x) => x.sequence)).toEqual([2, 1]);
  });

  it('an alert row is never deleted, never changes what it said, and records its publication once', async () => {
    const sql = db!.sql;
    await expect(sql`DELETE FROM trade.user_venue_risk_alerts WHERE setting_id = ${SETTING}`).rejects.toThrow(/never deleted/);
    await expect(sql`UPDATE trade.user_venue_risk_alerts SET asked = 0 WHERE setting_id = ${SETTING} AND sequence = 2`).rejects.toThrow(
      /only an unpublished alert changes/,
    );
    await sql`UPDATE trade.user_venue_risk_alerts SET published_at = now() WHERE setting_id = ${SETTING} AND sequence = 2`;
    await expect(
      sql`UPDATE trade.user_venue_risk_alerts SET published_at = now() WHERE setting_id = ${SETTING} AND sequence = 2`,
    ).rejects.toThrow(/only an unpublished alert changes/);
    // The business key is unique.
    await expect(
      sql`INSERT INTO trade.user_venue_risk_alerts (setting_id, sequence, user_id, venue_id, owner, symbol, kind, alert_key, asset,
            level, margin_with_result, created_at)
          SELECT setting_id, 9, user_id, venue_id, owner, symbol, kind, alert_key, asset, level, margin_with_result, created_at
          FROM trade.user_venue_risk_alerts WHERE setting_id = ${SETTING} AND sequence = 1`,
    ).rejects.toThrow(/user_venue_risk_alerts_key_uq/);
  });
});
