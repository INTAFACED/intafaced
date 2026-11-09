import { describe, expect, it } from 'vitest';
import { opsCapitalVenuesSchema } from '@intafaced/contracts';
import { createVenueReader, type BuilderAccountVenue } from './venues.js';
import {
  OPS_CAPITAL_BUILDER_ACCOUNT_UNSET,
  OPS_CAPITAL_TEST_VENUE_OUTSIDE_DEV_TEST,
  TestVenueRefusedError,
  testVenuesFor,
} from './test-venue.js';

const AT = new Date('2026-11-09T01:00:00.000Z');
const TEST_ENV = { APP_ENV: 'test' };

function venue(report: () => Promise<unknown>): BuilderAccountVenue {
  return {
    venueId: 'v',
    displayName: 'TEST venue',
    test: true,
    builderAccount: 'TEST-builder',
    builderAccountReport: report as BuilderAccountVenue['builderAccountReport'],
  };
}

describe('the TEST venues (OPS_TEST_VENUE)', () => {
  it('off is no venue, so the monitor says not connected', () => {
    expect(testVenuesFor('off', undefined, {})).toEqual([]);
    expect(createVenueReader([])).toBeUndefined();
  });

  it('refuses to start outside APP_ENV exactly dev or test, or under NODE_ENV=production', () => {
    for (const env of [
      {},
      { APP_ENV: 'staging' },
      { APP_ENV: 'production' },
      { APP_ENV: 'Test' },
      { APP_ENV: 'test', NODE_ENV: 'production' },
    ]) {
      for (const setting of ['test', 'down'] as const) {
        expect(() => testVenuesFor(setting, 'TEST-builder', env)).toThrow(TestVenueRefusedError);
        try {
          testVenuesFor(setting, 'TEST-builder', env);
        } catch (e) {
          expect((e as TestVenueRefusedError).code).toBe(OPS_CAPITAL_TEST_VENUE_OUTSIDE_DEV_TEST);
        }
      }
    }
  });

  it('a blank builder account refuses with ops.capital.builder_account_unset, never an invented one', () => {
    for (const blank of [undefined, '', '   ']) {
      try {
        testVenuesFor('test', blank, TEST_ENV);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(TestVenueRefusedError);
        expect((e as TestVenueRefusedError).code).toBe(OPS_CAPITAL_BUILDER_ACCOUNT_UNSET);
      }
    }
  });

  it('test: each venue reports the builder account balance as a decimal string with its as-of time, beside a published minimum or none', async () => {
    const read = createVenueReader(testVenuesFor('test', 'TEST-builder', TEST_ENV, () => AT))!;
    const out = opsCapitalVenuesSchema.parse(await read());
    expect(out).toEqual({
      status: 'read',
      venues: [
        {
          venueId: 'test-perp',
          displayName: 'TEST perpetuals venue',
          test: true,
          builderAccount: 'TEST-builder',
          balance: { status: 'read', assetId: 'USDC', amount: '125.5', asOf: AT.toISOString() },
          minimum: { status: 'published', assetId: 'USDC', amount: '100' },
        },
        {
          venueId: 'test-spot',
          displayName: 'TEST spot venue',
          test: true,
          builderAccount: 'TEST-builder',
          balance: { status: 'read', assetId: 'USDC', amount: '0.25', asOf: AT.toISOString() },
          minimum: { status: 'not_published' },
        },
      ],
    });
  });

  it('down: every venue reads unknown with ops.capital.source_unavailable, balance and minimum, never 0 or "not published"', async () => {
    const out = opsCapitalVenuesSchema.parse(await createVenueReader(testVenuesFor('down', 'TEST-builder', TEST_ENV))!());
    expect(out.status).toBe('read');
    if (out.status !== 'read') return;
    expect(out.venues).toHaveLength(2);
    for (const v of out.venues) {
      expect(v.balance).toMatchObject({ status: 'unknown', code: 'ops.capital.source_unavailable' });
      expect(v.minimum).toMatchObject({ status: 'unknown', code: 'ops.capital.source_unavailable' });
      expect(JSON.stringify(v)).not.toMatch(/"amount"/);
    }
  });
});

describe('the venue reader', () => {
  it('a venue that does not answer in time reads unknown', async () => {
    const out = await createVenueReader([venue(() => new Promise(() => undefined))], 10)!();
    expect(out.status === 'read' && out.venues[0]!.balance).toMatchObject({ status: 'unknown', code: 'ops.capital.source_unavailable' });
    expect(out.status === 'read' && out.venues[0]!.balance.status === 'unknown' && out.venues[0]!.balance.message).toContain('in time');
  });

  it('an answer in another shape reads unknown: a number, a negative, a bad time, a bad minimum', async () => {
    const good = { balance: { assetId: 'USDC', amount: '1', asOf: AT.toISOString() }, minimum: { status: 'not_published' } };
    const bad = [
      { ...good, balance: { ...good.balance, amount: 1 } },
      { ...good, balance: { ...good.balance, amount: '-1' } },
      { ...good, balance: { ...good.balance, amount: '1e3' } },
      { ...good, balance: { ...good.balance, asOf: 'yesterday' } },
      { ...good, minimum: { status: 'published', assetId: 'USDC', amount: 'lots' } },
      { ...good, minimum: {} },
      null,
    ];
    for (const answer of bad) {
      const out = await createVenueReader([venue(async () => answer)])!();
      expect(out.status === 'read' && out.venues[0]!.balance.status, JSON.stringify(answer)).toBe('unknown');
      expect(out.status === 'read' && out.venues[0]!.minimum.status, JSON.stringify(answer)).toBe('unknown');
    }
    const ok = await createVenueReader([venue(async () => good)])!();
    expect(ok.status === 'read' && ok.venues[0]!.balance).toEqual({ status: 'read', assetId: 'USDC', amount: '1', asOf: AT.toISOString() });
  });

  it('one venue failing leaves the other read', async () => {
    const good = { balance: { assetId: 'USDC', amount: '2.5', asOf: AT.toISOString() }, minimum: { status: 'not_published' } };
    const out = await createVenueReader([
      venue(async () => {
        throw new Error('refused');
      }),
      { ...venue(async () => good), venueId: 'w' },
    ])!();
    expect(out.status === 'read' && out.venues.map((v) => v.balance.status)).toEqual(['unknown', 'read']);
  });
});
