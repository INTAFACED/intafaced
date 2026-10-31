import { describe, expect, it } from 'vitest';
import { SendOutDoor } from './door.js';
import {
  NO_WITHDRAW_SIGNER,
  PAY_TEST_WITHDRAW_SIGNER_NETWORKS_ENV,
  SIGNED_SEND_RAIL,
  assertWithdrawSignerPosture,
  signerFor,
} from './signer-posture.js';

/**
 * The custody signer per network (J-wallet-05 #6 and #7, issue #6517). No live signer exists; a TEST one may be named per
 * network in dev and test only, and staging and prod can neither boot with one nor find one at a send.
 */
const ENV = PAY_TEST_WITHDRAW_SIGNER_NETWORKS_ENV;

describe('the TEST withdrawal signer: boot gate', () => {
  it('is named PAY_TEST_WITHDRAW_SIGNER_NETWORKS and sends only through crypto-native', () => {
    expect(ENV).toBe('PAY_TEST_WITHDRAW_SIGNER_NETWORKS');
    expect(SIGNED_SEND_RAIL).toBe('crypto-native');
  });

  it('blank, whitespace or unset names no network, in any environment', () => {
    for (const appEnv of ['dev', 'test', 'staging', 'prod', undefined]) {
      expect(assertWithdrawSignerPosture({ APP_ENV: appEnv }).testNetworks.size).toBe(0);
      expect(assertWithdrawSignerPosture({ APP_ENV: appEnv, [ENV]: '  ' }).testNetworks.size).toBe(0);
    }
    expect(NO_WITHDRAW_SIGNER.testNetworks.size).toBe(0);
  });

  it('names the listed networks in dev and test', () => {
    expect([...assertWithdrawSignerPosture({ APP_ENV: 'dev', [ENV]: 'ethereum' }).testNetworks]).toEqual(['ethereum']);
    expect([...assertWithdrawSignerPosture({ APP_ENV: 'test', [ENV]: ' base ' }).testNetworks]).toEqual(['base']);
  });

  it.each([['staging'], ['prod'], ['production'], [''], [undefined], ['Dev']])(
    'refuses to boot with a TEST signer where APP_ENV is %s',
    (appEnv) => {
      expect(() => assertWithdrawSignerPosture({ APP_ENV: appEnv, [ENV]: 'ethereum' })).toThrow(/only APP_ENV dev or test/);
    },
  );

  it.each([['Ethereum'], ['eth mainnet'], ['base_sepolia'], ['-base']])(
    'refuses to boot on a network id that does not parse: %s',
    (raw) => {
      expect(() => assertWithdrawSignerPosture({ APP_ENV: 'dev', [ENV]: raw })).toThrow(/not a network id/);
    },
  );

  it('refuses to boot with more than one network: the crypto-native rail is one chain', () => {
    expect(() => assertWithdrawSignerPosture({ APP_ENV: 'test', [ENV]: 'ethereum,base' })).toThrow(/at most one network/);
    expect(() => assertWithdrawSignerPosture({ APP_ENV: 'test', [ENV]: 'ethereum,,base' })).toThrow(/at most one network/);
  });
});

describe('the TEST withdrawal signer: runtime gate', () => {
  const posture = assertWithdrawSignerPosture({ APP_ENV: 'test', [ENV]: 'ethereum' });

  it('finds the TEST signer for a named network on crypto-native only', () => {
    expect(signerFor(posture, 'crypto-native', 'ethereum')).toBe('test');
    expect(signerFor(posture, 'crypto-native', 'base')).toBeNull();
    expect(signerFor(posture, 'crypto-native', undefined)).toBeNull();
    expect(signerFor(posture, 'crypto-native', '')).toBeNull();
    expect(signerFor(posture, 'card-sandbox', 'ethereum')).toBeNull();
    expect(signerFor(posture, 'bank-payout', 'ethereum')).toBeNull();
  });

  it('finds none in staging or prod even when a posture was built by hand with networks', () => {
    for (const appEnv of ['staging', 'prod', '', 'production']) {
      expect(signerFor({ appEnv, testNetworks: new Set(['ethereum']) }, 'crypto-native', 'ethereum')).toBeNull();
    }
  });
});

describe('the door before the claim', () => {
  const door = (state: 'ready' | 'not_saved' = 'ready', settleDepth: number | null = 6) => {
    const asked: unknown[] = [];
    const sendOut = new SendOutDoor({
      signer: assertWithdrawSignerPosture({ APP_ENV: 'test', [ENV]: 'ethereum' }),
      settleDepth,
      destinations: { check: async (input) => (asked.push(input), { state, destinationId: null, coolingOffEndsAt: null }) },
    });
    return { sendOut, asked };
  };
  const ask = {
    userId: 'u-1',
    assetId: 'USDT',
    rail: 'crypto-native',
    networkId: 'ethereum',
    quoteRef: 'q-1',
    destination: { kind: 'crypto', ref: '0x52908400098527886E0F7030069857D2E4169EE7' },
  };

  it('refuses every send out with one typed code while the owner has set no settle depth, after the signer and before the quote', () => {
    const { sendOut } = door('ready', null);
    expect(sendOut.settleDepth).toBeNull();
    expect(() => sendOut.assertSigner(ask)).toThrow(
      expect.objectContaining({ code: 'pay.withdraw_confirmations_unset', detail: { networkId: 'ethereum' } }),
    );
    expect(() => sendOut.assertSigner({ ...ask, quoteRef: undefined })).toThrow(
      expect.objectContaining({ code: 'pay.withdraw_confirmations_unset' }),
    );
    // No signer still refuses as no signer: the first thing a send needs is named first.
    expect(() => sendOut.assertSigner({ ...ask, networkId: 'base' })).toThrow(
      expect.objectContaining({ code: 'pay.wallet_withdraw_unavailable' }),
    );
    expect(door().sendOut.settleDepth).toBe(6);
  });

  it('asks for the signer first, then the quote, and names the network it refused on', () => {
    const { sendOut } = door();
    expect(() => sendOut.assertSigner({ ...ask, networkId: 'base' })).toThrow(
      expect.objectContaining({ code: 'pay.wallet_withdraw_unavailable', detail: { networkId: 'base', rail: 'crypto-native' } }),
    );
    expect(() => sendOut.assertSigner({ ...ask, networkId: undefined, quoteRef: undefined })).toThrow(
      expect.objectContaining({ code: 'pay.wallet_withdraw_unavailable' }),
    );
    expect(() => sendOut.assertSigner({ ...ask, quoteRef: undefined })).toThrow(
      expect.objectContaining({ code: 'withdrawal_quote.required' }),
    );
    expect(() => sendOut.assertSigner(ask)).not.toThrow();
  });

  it('asks the address book by asset, network and address, and refuses any answer but ready', async () => {
    const ready = door();
    await expect(ready.sendOut.assertDestination(ask)).resolves.toBeUndefined();
    expect(ready.asked).toEqual([{ userId: 'u-1', assetId: 'USDT', network: 'ethereum', ref: ask.destination.ref }]);
    await expect(door('not_saved').sendOut.assertDestination(ask)).rejects.toMatchObject({ code: 'pay.withdrawal_destination_not_saved' });
  });

  it('answers an asset the address book cannot hold as not saved, without asking it (never "try again")', async () => {
    const { sendOut, asked } = door();
    await expect(sendOut.assertDestination({ ...ask, assetId: 'USDC.e' })).rejects.toMatchObject({
      code: 'pay.withdrawal_destination_not_saved',
    });
    expect(asked).toEqual([]);
  });
});
