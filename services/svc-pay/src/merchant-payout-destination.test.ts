import { describe, expect, it } from 'vitest';
import { DestinationKindError } from './payout-destination.js';
import {
  assertOnlyPayoutDestinations,
  assertPersistableDestination,
  memoryPayoutDestinations,
  PayoutDestinationMissingError,
} from './merchant-payout-destination.js';

const EVM = '0x000000000000000000000000000000000000dEaD';
const IBAN = 'GB82WEST12345698765432';
const IFSC = 'SBIN0005943';

describe('assertPersistableDestination', () => {
  it('persists EVM on crypto-native through the existing door', () => {
    expect(assertPersistableDestination('crypto-native', { kind: 'crypto', ref: EVM })).toEqual({
      kind: 'crypto',
      ref: EVM,
    });
  });

  it('persists IBAN and IFSC on card-sandbox through the existing door', () => {
    expect(assertPersistableDestination('card-sandbox', { kind: 'bank', ref: IBAN }).ref).toBe(IBAN);
    expect(assertPersistableDestination('card-sandbox', { kind: 'bank', ref: IFSC }).ref).toBe(IFSC);
  });

  it('does not invent a destination — empty / gibberish refuse before any hold', () => {
    expect(() => assertPersistableDestination('crypto-native', { kind: 'crypto', ref: '0xdead' })).toThrow(DestinationKindError);
    expect(() => assertPersistableDestination('card-sandbox', { kind: 'bank', ref: 'X' })).toThrow(DestinationKindError);
  });

  it('does not live-wire bank-payout — kind+shape may persist, adapter stays absent', () => {
    expect(assertPersistableDestination('bank-payout', { kind: 'bank', ref: IBAN }).kind).toBe('bank');
    expect(() => assertPersistableDestination('bank-payout', { kind: 'crypto', ref: EVM })).toThrow(DestinationKindError);
  });
});

describe('assertOnlyPayoutDestinations (no store)', () => {
  const dests = assertOnlyPayoutDestinations();

  it('persist asserts and returns — does not invent a stored row', async () => {
    await expect(dests.persist({ merchantId: 'm', railId: 'crypto-native', kind: 'crypto', ref: EVM })).resolves.toEqual({
      kind: 'crypto',
      ref: EVM,
    });
  });

  it('require refuses closed — later payout has no ref to hold against', async () => {
    await expect(dests.require({ merchantId: 'm', railId: 'crypto-native' })).rejects.toBeInstanceOf(PayoutDestinationMissingError);
    await expect(dests.require({ merchantId: 'm', railId: 'crypto-native' })).rejects.toMatchObject({
      code: 'pay.payout_destination_missing',
    });
  });
});

describe('memoryPayoutDestinations', () => {
  it('require refuses until persist, then returns the stored EVM dest', async () => {
    const dests = memoryPayoutDestinations();
    await expect(dests.require({ merchantId: 'm', railId: 'crypto-native' })).rejects.toMatchObject({
      code: 'pay.payout_destination_missing',
    });
    await dests.persist({ merchantId: 'm', railId: 'crypto-native', kind: 'crypto', ref: EVM });
    await expect(dests.require({ merchantId: 'm', railId: 'crypto-native' })).resolves.toEqual({
      kind: 'crypto',
      ref: EVM,
    });
  });
});
