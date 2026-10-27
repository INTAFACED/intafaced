import { expect } from '@playwright/test';
import { journeyState } from './stack.mjs';
import { installTestWallet, testWalletKey, TEST_WALLET } from './test-wallet.mjs';

// Shared parts of the Web3 journeys (J-dex-protocol-NN) written ahead of their rooms. The app's network on the stack is
// Base Sepolia (84532), as in J-dex-protocol-01; the person's wallet is the TEST wallet (test-wallet.mjs). A step whose
// room or control is not built fails at its first missing part within UNBUILT, never by waiting out the whole test.

/** The wait for a part a step needs that may not be built yet: short, so an unbuilt step fails fast and says where. */
export const UNBUILT = { timeout: 5_000 };
export const CHAIN_ID = 84532;

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

/** Installs the run's TEST wallet in `page`, opens /wallet and connects it; returns the wallet handle. */
export async function connectWallet(page, dex, { tokens = [], chainId = CHAIN_ID } = {}) {
  const wallet = await installTestWallet(page, { chainId, tokens, privateKey: dex.key() });
  await page.goto('/wallet');
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` }).click();
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  return wallet;
}

/** Opens a Web3 room from the shell's top navigation by its name, as a person does. */
export async function openFromNav(page, name) {
  await page.getByTestId('tb-nav').getByRole('link', { name, exact: true }).click(UNBUILT);
}

/** Opens one section of the wallet room (Overview, Activity, Approvals, Session keys, Accounts, Safety, ...) by its tab. */
export async function walletSection(page, name) {
  await page.getByRole('button', { name, exact: true }).click(UNBUILT);
}
