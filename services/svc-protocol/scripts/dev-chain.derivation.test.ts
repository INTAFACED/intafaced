import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { mnemonicToAccount } from 'viem/accounts';

/**
 * Suite senders stay on the same BIP-44 path as `mnemonicToAccount`, but the
 * PBKDF2 seed is derived once per process. Thirty suite URLs plus anvil's ten
 * pre-funded indices used to be about forty seed derivations.
 */
const calls = { mnemonicToAccount: 0, pbkdf2Sync: 0 };

vi.mock('viem/accounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem/accounts')>();
  return {
    ...actual,
    mnemonicToAccount: (...args: Parameters<typeof actual.mnemonicToAccount>) => {
      calls.mnemonicToAccount += 1;
      return actual.mnemonicToAccount(...args);
    },
  };
});

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    pbkdf2Sync: (...args: Parameters<typeof actual.pbkdf2Sync>) => {
      calls.pbkdf2Sync += 1;
      return actual.pbkdf2Sync(...args);
    },
  };
});

const serviceRoot = join(import.meta.dirname, '..');

function suiteUrl(name: string): string {
  return pathToFileURL(join(serviceRoot, name)).href;
}

async function loadDevChain() {
  vi.resetModules();
  calls.mnemonicToAccount = 0;
  calls.pbkdf2Sync = 0;
  return import('./dev-chain.js');
}

describe('suite account derivation', () => {
  // viem's import dominates this test. Busy local runs took 4512ms and 5644ms.
  // 5644ms is past the 5000ms CI default. Budget is 5644 * 3, rounded up.
  it('derives the HD seed once and returns the same account object', async () => {
    const { devAccount, suiteAccount } = await loadDevChain();

    for (let i = 0; i < 30; i += 1) {
      suiteAccount(suiteUrl(`src/suite-${i}.onchain.test.ts`));
    }
    for (let i = 0; i < 10; i += 1) {
      devAccount(i);
    }

    expect(calls.mnemonicToAccount + calls.pbkdf2Sync).toBeLessThanOrEqual(1);
    expect(calls.pbkdf2Sync).toBe(1);

    const url = suiteUrl('src/lending/lending-oracle.onchain.test.ts');
    const first = suiteAccount(url);
    expect(suiteAccount(url)).toBe(first);
  }, 17_000);

  it('matches mnemonicToAccount for real suite URLs and anvil account 0', async () => {
    const { devAccount, PUBLIC_ANVIL_DEV_ACCOUNT_0_ADDRESS, PUBLIC_ANVIL_DEV_MNEMONIC, suiteAccount, suiteSenderIndex } =
      await loadDevChain();
    const message = 'ciflake-fixed-message';
    const urls = [
      suiteUrl('src/lending/lending-oracle.onchain.test.ts'),
      `${suiteUrl('src/lending/lending-cascade-flash.onchain.test.ts')}#b`,
      suiteUrl('src/amm/pool-factory-onchain.test.ts'),
    ];

    for (const url of urls) {
      const cached = suiteAccount(url);
      const direct = mnemonicToAccount(PUBLIC_ANVIL_DEV_MNEMONIC, {
        accountIndex: 1,
        addressIndex: suiteSenderIndex(url),
      });
      expect(cached.address).toBe(direct.address);
      expect(await cached.signMessage({ message })).toBe(await direct.signMessage({ message }));
    }

    expect(devAccount(0).address).toBe(PUBLIC_ANVIL_DEV_ACCOUNT_0_ADDRESS);
  });
});
