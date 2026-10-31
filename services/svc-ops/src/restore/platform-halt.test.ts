import { describe, expect, it } from 'vitest';
import { OPS_RESTORE_HALT_UNREADABLE, OPS_RESTORE_PLATFORM_NOT_HALTED } from '../codes.js';
import { createLedgerFreezeReader } from './platform-halt.js';

const LEDGER = 'http://ledger.internal:4001';

function answering(status: number, body: unknown, seen: string[] = []): typeof fetch {
  return (async (url: string | URL | Request) => {
    seen.push(String(url));
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe('whether the posting freeze is on, read from the ledger health', () => {
  it('is halted only when the ledger says posting is disabled', async () => {
    const seen: string[] = [];
    const halted = createLedgerFreezeReader({
      ledgerUrl: `${LEDGER}/`,
      fetcher: answering(200, { ok: true, service: 'svc-ledger', postingEnabled: false, frozenReason: 'TEST restore' }, seen),
    });
    expect(await halted.read()).toEqual({ halted: true });
    expect(seen).toEqual([`${LEDGER}/health`]);
    const open = createLedgerFreezeReader({ ledgerUrl: LEDGER, fetcher: answering(200, { service: 'svc-ledger', postingEnabled: true }) });
    expect(await open.read()).toMatchObject({ halted: false, code: OPS_RESTORE_PLATFORM_NOT_HALTED });
  });

  it('never takes a missing, refused, failed or unreadable answer as halted', async () => {
    const thrower = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof fetch;
    const cases = [
      createLedgerFreezeReader({ ledgerUrl: undefined, fetcher: answering(200, { postingEnabled: false }) }),
      createLedgerFreezeReader({ ledgerUrl: 'ftp://ledger', fetcher: answering(200, { postingEnabled: false }) }),
      createLedgerFreezeReader({ ledgerUrl: 'http://user:pw@ledger', fetcher: answering(200, { postingEnabled: false }) }),
      createLedgerFreezeReader({ ledgerUrl: LEDGER, fetcher: answering(503, { postingEnabled: false }) }),
      createLedgerFreezeReader({ ledgerUrl: LEDGER, fetcher: answering(200, { postingEnabled: 'false' }) }),
      createLedgerFreezeReader({ ledgerUrl: LEDGER, fetcher: answering(200, 'not json') }),
      createLedgerFreezeReader({ ledgerUrl: LEDGER, fetcher: thrower }),
    ];
    for (const reader of cases) expect(await reader.read()).toMatchObject({ halted: false, code: OPS_RESTORE_HALT_UNREADABLE });
  });
});
