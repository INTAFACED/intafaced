import { describe, expect, it } from 'vitest';
import { BankError } from './errors.js';
import {
  assertOnlyWithdrawDestinations,
  assertPersistableWithdrawDestination,
  destKindForRamp,
  evmChecksumMatches,
  lookalikeOf,
  memoryWithdrawDestinations,
} from './withdraw-destination.js';

const EVM = '0x000000000000000000000000000000000000dEaD';
const IBAN = 'GB82WEST12345698765432';
const IFSC = 'SBIN0005943';

describe('assertPersistableWithdrawDestination', () => {
  it('accepts EVM on crypto and IBAN/IFSC on bank', () => {
    expect(assertPersistableWithdrawDestination({ kind: 'crypto', ref: EVM })).toEqual({ kind: 'crypto', ref: EVM });
    expect(assertPersistableWithdrawDestination({ kind: 'bank', ref: IBAN }).ref).toBe(IBAN);
    expect(assertPersistableWithdrawDestination({ kind: 'bank', ref: IFSC }).ref).toBe(IFSC);
  });

  it('refuses empty / gibberish before any hold', () => {
    try {
      assertPersistableWithdrawDestination({ kind: 'crypto', ref: '0xdead' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BankError);
      expect(err).toMatchObject({ code: 'bank.ramp_invalid_destination' });
    }
    try {
      assertPersistableWithdrawDestination({ kind: 'bank', ref: 'IBAN-TEST' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'bank.ramp_invalid_destination' });
    }
  });

  it('maps ramp kind to dest kind — fiat is bank shape, not a PSP', () => {
    expect(destKindForRamp('crypto')).toBe('crypto');
    expect(destKindForRamp('fiat')).toBe('bank');
  });
});

describe('evmChecksumMatches (EIP-55)', () => {
  // The EIP-55 specification's own examples.
  const VECTORS = [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ];

  it('accepts the specification examples, and an address in one case only, which carries no checksum', () => {
    for (const address of VECTORS) expect(evmChecksumMatches(address)).toBe(true);
    expect(evmChecksumMatches(VECTORS[0]!.toLowerCase())).toBe(true);
    expect(evmChecksumMatches(`0x${VECTORS[0]!.slice(2).toUpperCase()}`)).toBe(true);
  });

  it('refuses one flipped letter, and assertPersistableWithdrawDestination says so with its own code', async () => {
    const flipped = '0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    expect(evmChecksumMatches(flipped)).toBe(false);
    expect(() => assertPersistableWithdrawDestination({ kind: 'crypto', ref: flipped })).toThrow(
      expect.objectContaining({ code: 'bank.address_checksum_mismatch' }),
    );
    // The legacy one-per-kind slot the offramp writes goes through the same check.
    await expect(assertOnlyWithdrawDestinations().persist({ userId: 'u1', kind: 'crypto', ref: flipped })).rejects.toMatchObject({
      code: 'bank.address_checksum_mismatch',
    });
  });
});

describe('lookalikeOf', () => {
  const saved = [{ ref: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', label: 'Cold' }];

  it('finds a saved address with the same start and end as the book shows them, and a different middle', () => {
    expect(lookalikeOf(`0x5aae${'1'.repeat(32)}eaed`, saved)).toBe(saved[0]);
  });

  it('ignores the same address in any case, a different start or end, and anything that is not an address', () => {
    expect(lookalikeOf(saved[0]!.ref.toLowerCase(), saved)).toBeNull();
    expect(lookalikeOf(`0x5aaf${'1'.repeat(32)}eaed`, saved)).toBeNull();
    expect(lookalikeOf(`0x5aae${'1'.repeat(32)}eaee`, saved)).toBeNull();
    expect(lookalikeOf('0x5aaeeaed', saved)).toBeNull();
    expect(lookalikeOf(`0x5aae${'1'.repeat(32)}eaed`, [{ ref: 'GB82WEST12345698765432' }])).toBeNull();
  });

  it('never calls an address already in the book a look-alike, even when another saved entry shows like it', () => {
    const near = `0x5aae${'1'.repeat(32)}eaed`;
    expect(lookalikeOf(near, [...saved, { ref: near.toUpperCase().replace('0X', '0x'), label: 'Confirmed before' }])).toBeNull();
  });
});

describe('assertOnlyWithdrawDestinations (no store)', () => {
  const dests = assertOnlyWithdrawDestinations();

  it('persist asserts and returns — does not invent a stored row', async () => {
    await expect(dests.persist({ userId: 'u', kind: 'crypto', ref: EVM })).resolves.toMatchObject({ kind: 'crypto', ref: EVM });
  });

  it('require refuses closed — later withdraw has no ref to hold against', async () => {
    await expect(dests.require({ userId: 'u', kind: 'crypto' })).rejects.toMatchObject({
      code: 'bank.withdraw_destination_missing',
    });
  });
});

describe('memoryWithdrawDestinations', () => {
  it('require refuses when nothing was stored', async () => {
    const dests = memoryWithdrawDestinations();
    await expect(dests.require({ userId: 'u', kind: 'crypto' })).rejects.toMatchObject({
      code: 'bank.withdraw_destination_missing',
    });
  });

  it('persist then require returns the stored EVM dest', async () => {
    const dests = memoryWithdrawDestinations();
    await dests.persist({ userId: 'u', kind: 'crypto', ref: EVM });
    await expect(dests.require({ userId: 'u', kind: 'crypto' })).resolves.toMatchObject({ kind: 'crypto', ref: EVM });
  });

  it('same-ref persist still bumps updatedAt (injectable now)', async () => {
    let t = new Date('2026-01-01T00:00:00.000Z');
    const dests = memoryWithdrawDestinations({ now: () => t });
    const first = await dests.persist({ userId: 'u', kind: 'crypto', ref: EVM });
    t = new Date('2026-01-01T00:00:01.000Z');
    const second = await dests.persist({ userId: 'u', kind: 'crypto', ref: EVM });
    expect(second.ref).toBe(EVM);
    expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
    const required = await dests.require({ userId: 'u', kind: 'crypto' });
    expect(required.updatedAt.getTime()).toBe(second.updatedAt.getTime());
  });
});
