import { expect } from '@playwright/test';
import { keccak256, toHex } from 'viem';
import { journeyState, toUnits } from './stack.mjs';
import { installTestWallet, testWalletKey, TEST_WALLET } from './test-wallet.mjs';

// Shared parts of the Web3 journeys (J-dex-protocol-NN) written ahead of their rooms. The app's network on the stack is
// Base Sepolia (84532), as in J-dex-protocol-01; the person's wallet is the TEST wallet (test-wallet.mjs). A step whose
// room or control is not built fails at its first missing part within UNBUILT, never by waiting out the whole test.
// A table is found the way the app's DataTable draws one: a region named by the table's label, holding the table.

/** The wait for a part a step needs that may not be built yet: short, so an unbuilt step fails fast and says where. */
export const UNBUILT = { timeout: 5_000 };
export const CHAIN_ID = 84532;
// TEST tokens only the TEST wallet knows (its stand-in for a node answers for them). Fixed addresses, so rows can be read.
export const TOKEN_A = { address: '0x00000000000000000000000000000000000a11ce', name: 'TEST Token A', version: '1', decimals: 6, nonce: 0 };
export const TOKEN_B = {
  address: '0x00000000000000000000000000000000000b0b00',
  name: 'TEST Token B',
  version: '1',
  decimals: 18,
  nonce: 0,
};

/** One journey run's state, with one TEST wallet key kept for every step of the run. */
export function dexRun(journey) {
  const run = journeyState(`${journey}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
  return {
    run,
    /** Starts the run again with a new TEST wallet key (each journey's first step). */
    start(extra = {}) {
      return run.reset({ walletKey: testWalletKey(), ...extra });
    },
    /** The run's TEST wallet key, made on first use when no earlier step started the run. */
    key() {
      const state = run.read();
      if (state.walletKey) return state.walletKey;
      return this.start().walletKey;
    },
  };
}

/**
 * The stack's seeded TEST wallet: one fixed TEST key, derived from a public phrase, that the stack's seeded TEST sales,
 * vaults, campaigns and cards name as their member, owner or heir. A step that reads seeded state as the person connects
 * this wallet instead of the run's new one. TEST only: it never holds anything outside the stack.
 */
export const seededWallet = { key: () => keccak256(toHex('INTAFACED LOCAL TEST seeded wallet')) };

/** The one decimal amount in a line such as "1,250.5 TEST Token A", in scaled units; none or several fails by name. */
export function oneAmount(text) {
  const found = text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  expect(found, `one amount in "${text}"`).toHaveLength(1);
  return toUnits(found[0].replaceAll(',', ''));
}

/** Installs the run's TEST wallet in `page`, opens /wallet and connects it; returns the wallet handle. */
export async function connectWallet(page, dex, { tokens = [], chainId = CHAIN_ID } = {}) {
  const wallet = await installTestWallet(page, { chainId, tokens, privateKey: dex.key() });
  await page.goto('/wallet');
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` }).click();
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  return wallet;
}

/** Opens one section of the wallet room (Overview, Activity, Approvals, Session keys, Accounts, Safety, ...) by its tab. */
export async function walletSection(page, name) {
  await page.getByRole('button', { name, exact: true }).click(UNBUILT);
}
