import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createEdgeContext } from '@intafaced/contracts';
import type { LedgerClient } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import { memorySecurityLock } from '../security-lock.js';
import { memoryWithdrawDestinations } from '../withdraw-destination.js';
import { memoryApprovalLinks } from './address-approval.js';
import { memoryFraudList } from './fraud-list.js';
import { RampService } from './ramp-service.js';
import { memoryWalletProofs } from './wallet-ownership.js';
import { memoryWithdrawNetworks } from './withdraw-networks.js';

/**
 * J-wallet-05 #6 (issue #6517): svc-pay asks the address book whether money may be sent to one address of one asset on one
 * network before it claims a withdrawal out of the platform. Only a saved entry on that same network counts, and then the
 * book's own readiness decides: the lock, approval and the cooling-off. Nothing here writes.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '44444444-4444-4444-8444-444444444444';
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const HOUR = 60 * 60 * 1000;
const UNLOCKS_AT = '2026-10-25T08:00:00.000Z';

const registry = memoryWithdrawNetworks([
  {
    id: 'USDT',
    kind: 'crypto',
    precision: 6,
    networks: [
      { networkId: 'ethereum', label: 'TEST Ethereum' },
      { networkId: 'base', label: 'TEST Base' },
    ],
    defaultNetworkId: 'ethereum',
    allowedActions: ['deposit', 'withdraw'],
    state: 'active',
    revision: 1,
    updatedAt: '2026-10-23T00:00:00.000Z',
  },
]);
const entry = { userId: USER, assetId: 'USDT', network: 'ethereum', ref: ADDRESS, label: 'TEST send wallet' };
const ask = { userId: USER, assetId: 'USDT', network: 'ethereum', ref: ADDRESS };

function book(clock: { now: Date }, hours = '24') {
  const lock = memorySecurityLock();
  const destinations = memoryWithdrawDestinations({ addressBookCap: () => '5', now: () => clock.now });
  // The fraud list as it stands at each read, so a test can list an address after it was saved.
  const listed: Array<{ network: string; address: string }> = [];
  const service = new RampService({} as Sql, {} as LedgerClient, {
    securityLock: lock,
    destinations,
    withdrawNetworks: registry,
    walletProofs: memoryWalletProofs(),
    approvalLinks: memoryApprovalLinks(),
    offrampCoolingHours: hours,
    fraudList: { isListed: (network, ref) => memoryFraudList(listed).isListed(network, ref) },
  });
  return { lock, destinations, service, listed };
}

/** Saved and approved 25 hours ago: past a 24-hour cooling-off. */
async function readyEntry(over: Partial<typeof entry> = {}, hours = '24') {
  const clock = { now: new Date(Date.now() - 25 * HOUR) };
  const made = book(clock, hours);
  const saved = await made.service.saveDestination({ ...entry, ...over });
  await made.destinations.approve({ userId: USER, destinationId: saved.destinationId, by: 'link' });
  clock.now = new Date();
  return { ...made, saved };
}

describe('whether money may be sent to an address on a network now', () => {
  it('answers ready for a saved, approved entry past its cooling-off on that network, whatever the letter case', async () => {
    const { service, saved } = await readyEntry();
    await expect(service.sendableDestination(ask)).resolves.toMatchObject({ state: 'ready', destinationId: saved.destinationId });
    await expect(service.sendableDestination({ ...ask, ref: ADDRESS.toLowerCase(), assetId: 'usdt' })).resolves.toMatchObject({
      state: 'ready',
      destinationId: saved.destinationId,
    });
  });

  it('answers other_network when the address is saved for the asset only on another network', async () => {
    const { service } = await readyEntry();
    await expect(service.sendableDestination({ ...ask, network: 'base' })).resolves.toEqual({
      state: 'other_network',
      destinationId: null,
      coolingOffEndsAt: null,
    });
  });

  it('answers not_saved for an address not in the book, another asset, or another person', async () => {
    const { service } = await readyEntry();
    const notSaved = { state: 'not_saved', destinationId: null, coolingOffEndsAt: null };
    await expect(service.sendableDestination({ ...ask, ref: '0x000000000000000000000000000000000000dEaD' })).resolves.toEqual(notSaved);
    await expect(service.sendableDestination({ ...ask, assetId: 'ETH' })).resolves.toEqual(notSaved);
    await expect(service.sendableDestination({ ...ask, userId: OTHER })).resolves.toEqual(notSaved);
  });

  it('does not match an entry saved with a tag, since a send carries none', async () => {
    const { service } = await readyEntry({ tag: 'memo-1' });
    await expect(service.sendableDestination(ask)).resolves.toMatchObject({ state: 'not_saved' });
  });

  it('answers approval_pending for a saved entry not approved yet', async () => {
    const { service } = book({ now: new Date(Date.now() - 25 * HOUR) });
    await service.saveDestination(entry);
    await expect(service.sendableDestination(ask)).resolves.toMatchObject({ state: 'approval_pending' });
  });

  it('answers cooling, with its end, inside the cooling-off, and cooling_unset when none is published', async () => {
    const clock = { now: new Date() };
    const { service, destinations } = book(clock);
    const saved = await service.saveDestination(entry);
    await destinations.approve({ userId: USER, destinationId: saved.destinationId, by: 'link' });
    await expect(service.sendableDestination(ask)).resolves.toEqual({
      state: 'cooling',
      destinationId: saved.destinationId,
      coolingOffEndsAt: new Date(clock.now.getTime() + 24 * HOUR).toISOString(),
    });
    const unset = await readyEntry({}, '');
    await expect(unset.service.sendableDestination(ask)).resolves.toMatchObject({ state: 'cooling_unset' });
  });

  it('answers locked while the security lock holds, and refuses when the lock cannot be read', async () => {
    const { service, lock } = await readyEntry();
    lock.set(USER, { locked: true, unlocksAt: UNLOCKS_AT });
    await expect(service.sendableDestination(ask)).resolves.toMatchObject({ state: 'locked' });
    lock.failWith(new BankError('identity is down', 'bank.security_lock_unavailable'));
    await expect(service.sendableDestination(ask)).rejects.toMatchObject({ code: 'bank.security_lock_unavailable' });
  });

  it('answers blocked for a saved, ready entry whose address is put on the fraud list afterwards', async () => {
    const { service, listed, saved } = await readyEntry();
    listed.push({ network: '*', address: ADDRESS });
    await expect(service.sendableDestination(ask)).resolves.toMatchObject({ state: 'blocked', destinationId: saved.destinationId });
  });

  it('never answers ready for a removed entry', async () => {
    const { service, saved } = await readyEntry();
    await service.removeDestination({ userId: USER, destinationId: saved.destinationId, idempotencyKey: `remove:${saved.destinationId}` });
    await expect(service.sendableDestination(ask)).resolves.toMatchObject({ state: 'not_saved' });
  });
});

describe('the sendable door', () => {
  const edge = createEdgeContext({ secret: 'a-bank-send-destination-test-secret-32c', serviceName: 'svc-bank' });
  const answers: unknown[] = [];
  const bank = {
    ramps: {
      sendableDestination: async (input: unknown) => {
        answers.push(input);
        return { state: 'ready', destinationId: '22222222-2222-4222-8222-222222222222', coolingOffEndsAt: null };
      },
    },
  } as unknown as BankServices;
  const call = (service: string | null, input: unknown = ask) =>
    createBankRouter(bank)
      .createCaller({ ...edge({ headers: {}, id: 'req-1' }), service } as never)
      .ramps.destinations.sendable(input as never);

  it('answers svc-pay', async () => {
    await expect(call('svc-pay')).resolves.toMatchObject({ state: 'ready' });
    expect(answers).toEqual([ask]);
  });

  it('serves svc-pay only: another service is forbidden and no service is unauthorized', async () => {
    await expect(call('svc-tax')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(call(null)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(answers).toHaveLength(1);
  });

  it('refuses an input with a field it does not name', async () => {
    await expect(call('svc-pay', { ...ask, tag: 'memo' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
