import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStaffHoldLedger } from './ledger.js';

const SECRET = 'a-staff-hold-ledger-test-secret-long-enough';

describe('the staff hold ledger read by key', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks the txByKey door alone and answers who booked the key, never following on to txById', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      paths.push(new URL(url).pathname);
      return Response.json({
        found: true,
        txId: 'tx-9',
        hash: 'h',
        postedAt: '2026-10-24T08:00:00.000Z',
        module: 'ops',
        reason: 'ops.hold.placed',
      });
    });
    const ledger = createStaffHoldLedger({ ledgerUrl: 'http://ledger.test', secret: SECRET })!;
    expect(await ledger.findByKey('ops:hold:9')).toEqual({ txId: 'tx-9', module: 'ops', reason: 'ops.hold.placed' });
    expect(paths).toEqual(['/trpc/txByKey']);
  });

  it('answers null only for an explicit not-found, and throws on anything unreadable', async () => {
    let body: unknown = { found: false };
    vi.stubGlobal('fetch', async () => Response.json(body));
    const ledger = createStaffHoldLedger({ ledgerUrl: 'http://ledger.test', secret: SECRET })!;
    expect(await ledger.findByKey('ops:hold:1')).toBeNull();
    body = { found: true, module: 'ops' };
    await expect(ledger.findByKey('ops:hold:1')).rejects.toThrow(/malformed/);
    body = {};
    await expect(ledger.findByKey('ops:hold:1')).rejects.toThrow(/malformed/);
  });

  it('is absent without a URL or a credential', () => {
    expect(createStaffHoldLedger({ secret: SECRET })).toBeUndefined();
    expect(createStaffHoldLedger({ ledgerUrl: 'http://ledger.test', secret: 'short' })).toBeUndefined();
  });
});
