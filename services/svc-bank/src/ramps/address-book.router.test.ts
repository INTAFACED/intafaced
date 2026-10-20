import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import type { LedgerClient } from '@intafaced/ledger-client';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import { memoryWithdrawDestinations } from '../withdraw-destination.js';
import { RampService } from './ramp-service.js';

/** W-withdraw-08 through the router: who may save, rename and remove, and what a list row shows. */

const SECRET = 'a-bank-address-book-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const ADDRESS = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

function callerWith(scopes: string[], mfa = true) {
  const raw = encodePrincipal({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'full',
    mfa,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  const ramps = new RampService({} as Sql, {} as LedgerClient, { destinations: shared, addressBookCap: '2' });
  return createBankRouter({ ramps } as unknown as BankServices).createCaller(
    edgeContext({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req-book',
    }),
  );
}

const shared = memoryWithdrawDestinations({ addressBookCap: () => '2' });
const entry = { assetId: 'USDT', network: 'erc20', ref: ADDRESS, label: 'Cold wallet' } as const;

describe('bank.ramps.destinations: the address book', () => {
  it('refuses a plain session on save and remove, and saves nothing', async () => {
    const plain = callerWith(['bank:read', 'bank:write']);
    await expect(plain.ramps.destinations.save(entry)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      plain.ramps.destinations.remove({ destinationId: '33333333-3333-4333-8333-333333333333', idempotencyKey: 'rm-1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await plain.ramps.destinations.list()).toEqual([]);
  });

  it('saves with the step-up scope, lists the row masked with its network and state, and renames with bank:write', async () => {
    const stepped = callerWith(['bank:read', 'bank:write', 'trade:withdraw']);
    const saved = await stepped.ramps.destinations.save({ ...entry, tag: '777' });
    expect(saved).toMatchObject({
      assetId: 'USDT',
      network: 'erc20',
      tag: '777',
      origin: 'customer',
      state: 'active',
      refMasked: '0xAbCd…Ef01',
    });
    const listed = await callerWith(['bank:read']).ramps.destinations.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ destinationId: saved.destinationId, coolingBlocker: 'bank.offramp_cooling_unset' });
    const renamed = await callerWith(['bank:read', 'bank:write']).ramps.destinations.rename({
      destinationId: saved.destinationId,
      label: 'Vault',
    });
    expect(renamed.label).toBe('Vault');
  });

  it('names the typed refusals for a taken label and a full book', async () => {
    const stepped = callerWith(['bank:read', 'bank:write', 'trade:withdraw']);
    await expect(
      stepped.ramps.destinations.save({ ...entry, ref: '0x2222222222222222222222222222222222222222', label: 'vault' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: expect.stringContaining('already have a saved address') });
    await stepped.ramps.destinations.save({ ...entry, ref: '0x3333333333333333333333333333333333333333', label: 'Second' });
    await expect(
      stepped.ramps.destinations.save({ ...entry, ref: '0x4444444444444444444444444444444444444444', label: 'Third' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('address book is full') });
  });

  it('removes a saved address with the step-up scope', async () => {
    const stepped = callerWith(['bank:read', 'bank:write', 'trade:withdraw']);
    const [first] = await stepped.ramps.destinations.list();
    await expect(stepped.ramps.destinations.remove({ destinationId: first!.destinationId, idempotencyKey: 'rm-book-1' })).resolves.toEqual({
      destinationId: first!.destinationId,
      removed: true,
    });
    expect(await stepped.ramps.destinations.list()).toHaveLength(1);
  });
});
