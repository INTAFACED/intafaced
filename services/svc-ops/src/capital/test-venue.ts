import { isExplicitDevOrTest } from '@intafaced/config';
import type { BuilderAccountReport, BuilderAccountVenue } from './venues.js';

/**
 * THE TEST VENUES FOR THE CAPITAL MONITOR, AND THEY ARE TEST FIXTURES (J-ops-console-24 #1).
 *
 * No venue adapter on main reports INTAFACED's own builder account yet, so the local test stack stands two in, labelled
 * TEST, behind the same port a real venue adapter fills (`BuilderAccountVenue`). Each is the venue's own record for the
 * builder account: a TEST balance with the venue's as-of time, and either a TEST published minimum for collecting builder
 * fees or none published. They hold nothing of ours, post nothing to the ledger, and are never summed into own funds.
 *
 * `OPS_TEST_VENUE`:
 *   · `off` (the default): no TEST venue; the monitor says `ops.capital.venue_not_connected`.
 *   · `test`: both TEST venues answer.
 *   · `down`: both TEST venues refuse every read, so the monitor shows each "unknown", never 0.
 *
 * Chosen (`test` or `down`) in a process whose raw `APP_ENV` is not exactly `dev` or `test`, or with `NODE_ENV=production`,
 * svc-ops refuses to start, as svc-bank refuses its TEST partner. The builder account is the owner's value: blank, with a
 * TEST venue chosen, svc-ops refuses to start with `ops.capital.builder_account_unset`, and nothing is invented.
 */
export const OPS_TEST_VENUE_SETTINGS = ['off', 'test', 'down'] as const;
export type OpsTestVenueSetting = (typeof OPS_TEST_VENUE_SETTINGS)[number];

export const OPS_CAPITAL_BUILDER_ACCOUNT_UNSET = 'ops.capital.builder_account_unset' as const;
export const OPS_CAPITAL_TEST_VENUE_OUTSIDE_DEV_TEST = 'ops.capital.test_venue_outside_dev_test' as const;

interface TestVenueRecord {
  readonly venueId: string;
  readonly displayName: string;
  readonly balance: { readonly assetId: string; readonly amount: string };
  readonly minimum: BuilderAccountReport['minimum'];
}

/** The TEST venues' own records. Every figure is TEST: they stand in for a venue on the test stack only. */
export const TEST_VENUE_RECORDS: readonly TestVenueRecord[] = Object.freeze([
  {
    venueId: 'test-perp',
    displayName: 'TEST perpetuals venue',
    balance: { assetId: 'USDC', amount: '125.5' },
    minimum: { status: 'published', assetId: 'USDC', amount: '100' },
  },
  {
    venueId: 'test-spot',
    displayName: 'TEST spot venue',
    balance: { assetId: 'USDC', amount: '0.25' },
    minimum: { status: 'not_published' },
  },
]);

/** Why svc-ops will not start with a TEST venue chosen. */
export class TestVenueRefusedError extends Error {
  readonly code: typeof OPS_CAPITAL_TEST_VENUE_OUTSIDE_DEV_TEST | typeof OPS_CAPITAL_BUILDER_ACCOUNT_UNSET;
  constructor(code: TestVenueRefusedError['code']) {
    super(
      code === OPS_CAPITAL_BUILDER_ACCOUNT_UNSET
        ? 'OPS_TEST_VENUE is chosen but OPS_TEST_VENUE_BUILDER_ACCOUNT is blank: the builder account is the owner’s value and is never invented.'
        : 'OPS_TEST_VENUE stands in for a venue with TEST figures; it runs only with APP_ENV exactly dev or test.',
    );
    this.code = code;
    this.name = 'TestVenueRefusedError';
  }
}

class TestVenueDownError extends Error {
  readonly code = 'ops.capital.test_venue_down' as const;
  constructor(name: string) {
    super(`${name} is switched down (OPS_TEST_VENUE=down) and answers no read.`);
  }
}

/**
 * Total over the closed setting. `off` is no venue. `test` and `down` are the TEST venues only in an explicit dev or test
 * process with a builder account set, and throw at boot otherwise: `env` is the RAW process env.
 */
export function testVenuesFor(
  setting: OpsTestVenueSetting,
  builderAccount: string | undefined,
  env: { readonly APP_ENV?: string; readonly NODE_ENV?: string },
  clock: () => Date = () => new Date(),
): BuilderAccountVenue[] {
  if (setting === 'off') return [];
  if (!isExplicitDevOrTest(env.APP_ENV) || env.NODE_ENV === 'production') {
    throw new TestVenueRefusedError(OPS_CAPITAL_TEST_VENUE_OUTSIDE_DEV_TEST);
  }
  const account = builderAccount?.trim();
  if (!account) throw new TestVenueRefusedError(OPS_CAPITAL_BUILDER_ACCOUNT_UNSET);
  return TEST_VENUE_RECORDS.map((record) => ({
    venueId: record.venueId,
    displayName: record.displayName,
    test: true,
    builderAccount: account,
    builderAccountReport: async () => {
      if (setting === 'down') throw new TestVenueDownError(record.displayName);
      return { balance: { ...record.balance, asOf: clock().toISOString() }, minimum: record.minimum };
    },
  }));
}
