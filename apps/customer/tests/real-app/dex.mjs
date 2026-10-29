import { expect } from '@playwright/test';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { journeyState, tool, toUnits } from './stack.mjs';
import { installTestWallet, testWalletKey, TEST_WALLET } from './test-wallet.mjs';

// Shared parts of the Web3 journeys (J-dex-protocol-NN) written ahead of their rooms. The app's network on the stack is
// Base Sepolia (84532), as in J-dex-protocol-01; the person's wallet is the TEST wallet (test-wallet.mjs). A step whose
// room or control is not built fails at its first missing part within UNBUILT, never by waiting out the whole test.
// A table is found the way the app's DataTable draws one: a region named by the table's label, holding the table.

/** The wait for a part a step needs that may not be built yet: short, so an unbuilt step fails fast and says where. */
export const UNBUILT = { timeout: 5_000 };
export const CHAIN_ID = 84532;
// TEST tokens at fixed addresses, so rows can be read. The TEST wallet answers their domain, decimals and nonce itself;
// on the stack's TEST chain the same tokens are deployed at these addresses (services/svc-protocol/scripts/seed-test-chain.ts).
export const TOKEN_A = { address: '0x00000000000000000000000000000000000a11ce', name: 'TEST Token A', version: '1', decimals: 6, nonce: 0 };
export const TOKEN_B = {
  address: '0x00000000000000000000000000000000000b0b00',
  name: 'TEST Token B',
  version: '1',
  decimals: 18,
  nonce: 0,
};

/**
 * The journeys that run on the stack's LOCAL TEST chain (tooling/scripts/local-test-chain.mjs: anvil, chain id 84532,
 * seeded TEST tokens, pools and router). Their wallet is connected to that node and their run's key is funded with
 * TEST ETH and TEST Token A and B when the run starts. Every other journey's wallet reaches no chain, as before.
 */
export const ON_TEST_CHAIN = new Set(['J-dex-protocol-02', 'J-dex-protocol-04']);

/** The stack's TEST chain: `{ chain: 'running', gate, gateUrl }` or `{ chain: 'absent' }` (no anvil on this stack). */
export function testChain() {
  return JSON.parse(tool('local-test-chain.mjs', 'status'));
}

/** Funds `address` on the TEST chain (TEST ETH for gas, 10,000 TEST Token A and B); refuses by name with no chain. */
export function fundOnTestChain(address) {
  return tool('local-test-chain.mjs', 'fund', address);
}

/** One journey run's state, with one TEST wallet key kept for every step of the run. */
export function dexRun(journey) {
  const run = journeyState(`${journey}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
  const onChain = ON_TEST_CHAIN.has(journey);
  return {
    run,
    onChain,
    /** Starts the run again with a new TEST wallet key (each journey's first step), funded when it runs on the TEST chain. */
    start(extra = {}) {
      const walletKey = testWalletKey();
      if (onChain) fundOnTestChain(privateKeyToAccount(walletKey).address);
      return run.reset({ walletKey, ...extra });
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

/**
 * Installs the run's TEST wallet in `page`, opens /wallet and connects it; returns the wallet handle. A journey on the
 * TEST chain gets a wallet connected to that node (through its gate, as svc-protocol reads it).
 */
export async function connectWallet(page, dex, { tokens = [], chainId = CHAIN_ID } = {}) {
  const rpcUrl = dex.onChain ? testChain().gateUrl : null;
  const wallet = await installTestWallet(page, { chainId, tokens, privateKey: dex.key(), rpcUrl });
  await page.goto('/wallet');
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` }).click();
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  return wallet;
}

/** Opens one section of the wallet room (Overview, Activity, Approvals, Session keys, Accounts, Safety, ...) by its tab. */
export async function walletSection(page, name) {
  await page.getByRole('button', { name, exact: true }).click(UNBUILT);
}
