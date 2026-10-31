import { describe, expect, it } from 'vitest';
import { DestinationKindError } from './payout-destination.js';
import {
  assertOnlyPayoutDestinations,
  assertPersistableDestination,
  destinationLifecycle,
  memoryPayoutDestinations,
  PayoutDestinationHeldError,
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
  it('require refuses an unverified persist and returns a verified seed', async () => {
    const dests = memoryPayoutDestinations();
    await expect(dests.require({ merchantId: 'm', railId: 'crypto-native' })).rejects.toMatchObject({
      code: 'pay.payout_destination_missing',
    });
    await dests.persist({ merchantId: 'm', railId: 'crypto-native', kind: 'crypto', ref: EVM });
    // Saved but not verified: its own typed refusal, not "missing" (J-merchant-02 #5).
    await expect(dests.require({ merchantId: 'm', railId: 'crypto-native' })).rejects.toMatchObject({
      code: 'pay.payout_destination_unverified',
    });
    await dests.seedVerified({ merchantId: 'm', railId: 'crypto-native', kind: 'crypto', ref: EVM });
    await expect(dests.require({ merchantId: 'm', railId: 'crypto-native' })).resolves.toEqual({
      kind: 'crypto',
      ref: EVM,
    });
  });
});

describe('destination states (J-merchant-02 #5)', () => {
  const at = (iso: string) => new Date(iso);

  it('reads unverified, held until activatesAt, then active, from the row and the clock alone', () => {
    const now = at('2026-10-30T12:00:00.000Z');
    expect(destinationLifecycle({ verified: false, activatesAt: null }, now)).toEqual({ state: 'unverified', activatesAt: null });
    expect(destinationLifecycle({ verified: false, activatesAt: at('2026-10-30T13:00:00.000Z') }, now)).toEqual({
      state: 'unverified',
      activatesAt: null,
    });
    expect(destinationLifecycle({ verified: true, activatesAt: at('2026-10-30T12:00:00.001Z') }, now)).toEqual({
      state: 'held',
      activatesAt: at('2026-10-30T12:00:00.001Z'),
    });
    // Exactly at activatesAt it is active.
    expect(destinationLifecycle({ verified: true, activatesAt: now }, now)).toEqual({ state: 'active', activatesAt: null });
    expect(destinationLifecycle({ verified: true, activatesAt: null }, now)).toEqual({ state: 'active', activatesAt: null });
  });

  it('require refuses a held destination with its end, then pays it from activatesAt on', async () => {
    let now = at('2026-10-30T12:00:00.000Z');
    const dests = memoryPayoutDestinations(() => now);
    const activatesAt = at('2026-10-30T12:00:45.000Z');
    await dests.transaction('m', 'crypto-native', async (row, write) => {
      expect(row).toBeNull();
      await write.insertVerified({ kind: 'crypto', ref: EVM, verifiedAt: now, activatesAt });
    });
    const held = await dests.require({ merchantId: 'm', railId: 'crypto-native' }).catch((err: unknown) => err);
    expect(held).toBeInstanceOf(PayoutDestinationHeldError);
    expect(held).toMatchObject({ code: 'pay.payout_destination_held', activatesAt });
    expect(await dests.read({ merchantId: 'm', railId: 'crypto-native' })).toMatchObject({ verified: true, activatesAt });
    now = at('2026-10-30T12:00:44.999Z');
    await expect(dests.require({ merchantId: 'm', railId: 'crypto-native' })).rejects.toMatchObject({
      code: 'pay.payout_destination_held',
    });
    now = activatesAt;
    await expect(dests.require({ merchantId: 'm', railId: 'crypto-native' })).resolves.toEqual({ kind: 'crypto', ref: EVM });
  });

  it('writers keep the states apart: an unverified save never lands on a verified row', async () => {
    const dests = memoryPayoutDestinations();
    await dests.seedVerified({ merchantId: 'm', railId: 'crypto-native', kind: 'crypto', ref: EVM });
    await expect(
      dests.transaction('m', 'crypto-native', async (_row, write) => write.replaceUnverified({ kind: 'crypto', ref: EVM })),
    ).rejects.toBeInstanceOf(PayoutDestinationMissingError);
    await expect(
      dests.transaction('m', 'crypto-native', async (_row, write) => write.insertUnverified({ kind: 'crypto', ref: EVM })),
    ).rejects.toBeInstanceOf(PayoutDestinationMissingError);
    await expect(dests.require({ merchantId: 'm', railId: 'crypto-native' })).resolves.toEqual({ kind: 'crypto', ref: EVM });
  });
});
