import { afterEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { LedgerClient } from '@intafaced/ledger-client';
import { memorySecurityLock } from '../security-lock.js';
import { memoryWithdrawDestinations } from '../withdraw-destination.js';
import { memoryApprovalLinks } from './address-approval.js';
import { memoryFraudList } from './fraud-list.js';
import { RampService } from './ramp-service.js';
import {
  BANK_DESTINATION_SANCTIONS_ENV,
  destinationSanctions,
  memorySanctions,
  readSanctionsList,
  type DestinationSanctionsPort,
} from './sanctions-list.js';
import { memoryWalletProofs } from './wallet-ownership.js';
import { memoryWithdrawNetworks } from './withdraw-networks.js';

const USER = '11111111-1111-4111-8111-111111111111';
const LISTED = '0x5a7c7100000000000000000000000000000ba5ed';
const CLEAN = '0x52908400098527886E0F7030069857D2E4169EE7';

const registry = memoryWithdrawNetworks([
  {
    id: 'USDT',
    kind: 'crypto',
    precision: 6,
    networks: [{ networkId: 'ethereum', label: 'TEST Ethereum' }],
    defaultNetworkId: 'ethereum',
    allowedActions: ['deposit', 'withdraw'],
    state: 'active',
    revision: 1,
    updatedAt: '2026-10-31T00:00:00.000Z',
  },
]);

function bank(sanctions?: DestinationSanctionsPort) {
  const destinations = memoryWithdrawDestinations({ addressBookCap: () => '5' });
  const service = new RampService({} as Sql, {} as LedgerClient, {
    securityLock: memorySecurityLock(),
    destinations,
    withdrawNetworks: registry,
    walletProofs: memoryWalletProofs(),
    approvalLinks: memoryApprovalLinks(),
    offrampCoolingHours: '0',
    fraudList: memoryFraudList(),
    ...(sanctions ? { sanctions } : {}),
  });
  return { service, destinations };
}

const save = (ref: string, network = 'ethereum') => ({ userId: USER, assetId: 'USDT', network, ref, label: `TEST ${ref.slice(0, 6)}` });

describe('reading the owner setting', () => {
  it('reads unset, blank and unreadable settings as no list, and invents no entries', () => {
    expect(readSanctionsList(undefined)).toBeNull();
    expect(readSanctionsList('')).toBeNull();
    expect(readSanctionsList('   ')).toBeNull();
    expect(readSanctionsList(LISTED)).toBeNull();
    expect(readSanctionsList(`ethereum:${LISTED},`)).toBeNull();
    expect(readSanctionsList(`:${LISTED}`)).toBeNull();
    expect(readSanctionsList('ethereum:')).toBeNull();
  });

  it('reads network:address pairs, the network in lower case and an EVM address in lower case', () => {
    expect(readSanctionsList(` Ethereum:${CLEAN.toUpperCase().replace('0X', '0x')} , *:TRON-addr `)).toEqual([
      { network: 'ethereum', ref: CLEAN.toLowerCase() },
      { network: '*', ref: 'TRON-addr' },
    ]);
  });

  it('answers unset, listed or clear, on the network given or on every network', () => {
    const unset = destinationSanctions(() => undefined);
    expect(unset.check('ethereum', LISTED)).toBe('unset');
    const one = destinationSanctions(() => `ethereum:${LISTED}`);
    expect(one.check('ethereum', LISTED.toUpperCase().replace('0X', '0x'))).toBe('listed');
    expect(one.check('base', LISTED)).toBe('clear');
    expect(one.check(null, LISTED)).toBe('listed');
    expect(one.check('ethereum', CLEAN)).toBe('clear');
    expect(destinationSanctions(() => `*:${LISTED}`).check('base', LISTED)).toBe('listed');
  });
});

describe('saving a withdrawal address against the sanctions list (J-wallet-05 #2)', () => {
  const before = process.env[BANK_DESTINATION_SANCTIONS_ENV];
  afterEach(() => {
    if (before === undefined) delete process.env[BANK_DESTINATION_SANCTIONS_ENV];
    else process.env[BANK_DESTINATION_SANCTIONS_ENV] = before;
  });

  it('refuses every save while the owner setting is blank, and saves nothing', async () => {
    for (const raw of [undefined, '', 'not a list']) {
      if (raw === undefined) delete process.env[BANK_DESTINATION_SANCTIONS_ENV];
      else process.env[BANK_DESTINATION_SANCTIONS_ENV] = raw;
      const { service, destinations } = bank();
      await expect(service.saveDestination(save(CLEAN))).rejects.toMatchObject({ code: 'bank.destination_sanctions_unset' });
      expect(await destinations.list(USER)).toEqual([]);
    }
  });

  it('reads the setting as it stands at each save', async () => {
    delete process.env[BANK_DESTINATION_SANCTIONS_ENV];
    const { service, destinations } = bank();
    await expect(service.saveDestination(save(CLEAN))).rejects.toMatchObject({ code: 'bank.destination_sanctions_unset' });
    process.env[BANK_DESTINATION_SANCTIONS_ENV] = `ethereum:${LISTED}`;
    await expect(service.saveDestination(save(CLEAN))).resolves.toMatchObject({ ref: expect.any(String) });
    expect(await destinations.list(USER)).toHaveLength(1);
  });

  it('refuses a listed address by name, however its case is typed, and saves nothing', async () => {
    process.env[BANK_DESTINATION_SANCTIONS_ENV] = `ethereum:${LISTED}`;
    const { service, destinations } = bank();
    for (const ref of [LISTED, LISTED.toUpperCase().replace('0X', '0x')]) {
      await expect(service.saveDestination(save(ref))).rejects.toMatchObject({ code: 'bank.destination_sanctions_listed' });
    }
    expect(await destinations.list(USER)).toEqual([]);
  });

  it('refuses the check before the confirmation code as the save would', async () => {
    process.env[BANK_DESTINATION_SANCTIONS_ENV] = `ethereum:${LISTED}`;
    const { service } = bank();
    await expect(service.checkDestination({ userId: USER, ref: LISTED, network: 'ethereum' })).rejects.toMatchObject({
      code: 'bank.destination_sanctions_listed',
    });
    await expect(service.checkDestination({ userId: USER, ref: CLEAN, network: 'ethereum' })).resolves.toMatchObject({ address: 'ok' });
    delete process.env[BANK_DESTINATION_SANCTIONS_ENV];
    await expect(bank().service.checkDestination({ userId: USER, ref: CLEAN, network: 'ethereum' })).rejects.toMatchObject({
      code: 'bank.destination_sanctions_unset',
    });
  });

  it('reads a list with a network that is not a network id as unset, so a typo never fails open', () => {
    expect(readSanctionsList(`ether um:${LISTED}`)).toBeNull();
    expect(destinationSanctions(() => `ether um:${LISTED}`).check('ethereum', LISTED)).toBe('unset');
  });

  it('refuses saving again an entry saved before it was listed, rather than answering the replay', async () => {
    const sanctioned: Array<{ network: string; address: string }> = [];
    const { service, destinations } = bank({ check: (network, ref) => memorySanctions(sanctioned).check(network, ref) });
    await service.saveDestination(save(LISTED));
    sanctioned.push({ network: '*', address: LISTED });
    await expect(service.saveDestination(save(LISTED))).rejects.toMatchObject({ code: 'bank.destination_sanctions_listed' });
    expect(await destinations.list(USER)).toHaveLength(1);
  });
});
