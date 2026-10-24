/**
 * trade.mm-bot — orderFilled accountId recovery.
 *
 * Seeded MM fills must carry a recoverable house STP id. Empty / house
 * bookkeeping UUID looks like an anonymous customer fill and must fail.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mmSeedJobsArmed } from './seed-honesty.js';
import { HOUSE_MM_USER_UUID, MM_MATCHING_ACCOUNT_ID, looksLikeAnonymousCustomerFill, recoverMatchingAccountId } from './fill-account.js';
import { tradeServiceArea, tradeServiceSource } from '../spot/trade-service/source.testkit.js';

const here = dirname(fileURLToPath(import.meta.url));

const CUSTOMER = '11111111-1111-4111-8111-111111111111';

describe('recoverMatchingAccountId — house MM seed fills', () => {
  it('event house STP id is already recoverable', () => {
    const recovered = recoverMatchingAccountId({
      eventAccountId: MM_MATCHING_ACCOUNT_ID,
      orderUserId: HOUSE_MM_USER_UUID,
    });
    expect(recovered).toBe(MM_MATCHING_ACCOUNT_ID);
    expect(looksLikeAnonymousCustomerFill(recovered)).toBe(false);
  });

  it('omitted event accountId recovers house STP id from recorded seed row', () => {
    const recovered = recoverMatchingAccountId({
      eventAccountId: '',
      orderUserId: HOUSE_MM_USER_UUID,
    });
    expect(recovered).toBe(MM_MATCHING_ACCOUNT_ID);
    expect(looksLikeAnonymousCustomerFill(recovered)).toBe(false);
  });

  it('undefined event accountId recovers the same way as empty', () => {
    const recovered = recoverMatchingAccountId({
      orderUserId: HOUSE_MM_USER_UUID,
    });
    expect(recovered).toBe(MM_MATCHING_ACCOUNT_ID);
    expect(looksLikeAnonymousCustomerFill(recovered)).toBe(false);
  });

  it('bookkeeping UUID on the event is rewritten — never left as a customer-looking id', () => {
    const recovered = recoverMatchingAccountId({
      eventAccountId: HOUSE_MM_USER_UUID,
    });
    expect(recovered).toBe(MM_MATCHING_ACCOUNT_ID);
    expect(looksLikeAnonymousCustomerFill(HOUSE_MM_USER_UUID)).toBe(true);
    expect(looksLikeAnonymousCustomerFill(recovered)).toBe(false);
  });

  it('fails the seeded-fill contract when accountId is missing and no house row exists', () => {
    const recovered = recoverMatchingAccountId({
      eventAccountId: '',
      orderUserId: '',
    });
    expect(recovered).toBe('');
    expect(looksLikeAnonymousCustomerFill(recovered)).toBe(true);
  });

  it('does not invent house MM from a live customer order row', () => {
    const recovered = recoverMatchingAccountId({
      eventAccountId: '',
      orderUserId: CUSTOMER,
    });
    expect(recovered).toBe(CUSTOMER);
    expect(looksLikeAnonymousCustomerFill(recovered)).toBe(false);
  });
});

describe('TRADE_MM_SEED_ENABLED kill is unchanged', () => {
  it('jobs stay unarmed when the seed flag is off (same kill as placeOrder seeded path)', () => {
    expect(mmSeedJobsArmed(false, 3)).toBe(false);
    expect(mmSeedJobsArmed(true, 0)).toBe(false);
    expect(mmSeedJobsArmed(true, 2)).toBe(true);
  });
});

describe('production fill/event path — not tests-only', () => {
  it('settleFillEvent recovers maker and taker via recoverMatchingAccountId', () => {
    // settleFillEvent lives in spot/trade-service/events.ts since the split by area.
    const src = tradeServiceArea('events');
    expect(src).toMatch(/import \{ recoverMatchingAccountId \} from '\.\.\/\.\.\/mm\/fill-account\.js'/);
    expect(src).toMatch(/async function settleFillEvent\([\s\S]*?const makerAccountId = recoverMatchingAccountId\(/);
    expect(src).toMatch(/async function settleFillEvent\([\s\S]*?const takerAccountId = recoverMatchingAccountId\(/);
  });

  it('orderFilled bus consumer calls settleFillEvent (live recovery path)', () => {
    const src = readFileSync(join(here, '..', 'events.ts'), 'utf8');
    expect(src).toMatch(/'orderFilled'/);
    expect(src).toMatch(/await trade\.settleFillEvent\(/);
    expect(src).toMatch(/makerAccountId: payload\.makerAccountId/);
  });

  it('index mounts MM seed jobs behind TRADE_MM_SEED_ENABLED', () => {
    const src = readFileSync(join(here, '..', 'index.ts'), 'utf8');
    expect(src).toMatch(/import \{ parseMmSeedTargets, startMmSeedJobs \} from '\.\/mm\/seed-jobs\.js'/);
    expect(src).toMatch(/const mmSeedJobs = startMmSeedJobs\(/);
    expect(src).toMatch(/enabled: env\.TRADE_MM_SEED_ENABLED/);
  });
});
