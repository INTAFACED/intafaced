import { createHash } from 'node:crypto';
import { TestnetSigner } from './evm-signer.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, defineChain, http, parseEther, toHex, type Address, type Hex } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { describeError, recordInfraProbe } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client';
import { MemoryBroadcastStore } from './broadcast-store.js';
import { parseEvmAssets } from './evm-assets.js';
import { EvmLiveChain } from './evm-chain.js';
import { CryptoNativeAdapter } from './crypto-native.js';

/**
 * LIVE proof against a real JSON-RPC (compose `evm` / anvil on :8545).
 *
 * Skips when the node is absent — a laptop without anvil must still run the
 * rest of svc-pay. The skip is journalled (`recordInfraProbe`), so
 * `infra-verdict` can name it instead of turbo counting a pass.
 *
 * REQUIRE_PAY_EVM=1 fails instead of skip. CI's pay-bank shard does not set
 * that and does not start anvil; Tests (full) has anvil on :8545 and the
 * verdict fails a journalled skip under CI=true. Do not invent a second chain.
 */

const RPC = process.env.PAY_CRYPTO_RPC_URL ?? process.env.PROTOCOL_RPC_URL ?? 'http://127.0.0.1:8545';
const CHAIN_ID = Number(process.env.PAY_CRYPTO_CHAIN_ID ?? process.env.PROTOCOL_CHAIN_ID ?? 31337);

const DEPOSIT_MNEMONIC = 'test test test test test test test test test test test junk';
const SECRET = 'live-crypto-webhook-secret-at-least-32-chars!!';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS SUITE NO LONGER USES ANVIL'S PRE-FUNDED ACCOUNTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It used to hard-code anvil account #0 as the hot wallet and #1 as the payer.
 * Those are not free: svc-protocol's `scripts/deploy-dev.ts` owns #0 (compose
 * names the CREATE addresses its nonce produces) and its
 * `accounts/create2-onchain.test.ts` was sending from #1. `pnpm verify` runs
 * packages in parallel, so this file and that one both read the same pending
 * nonce, both broadcast with it, and whichever lost got `nonce too low` — in
 * svc-pay or in svc-protocol depending on the day, with nothing wrong in
 * either diff.
 *
 * So both senders are now derived from THIS FILE's path, on the `m/44'/60'/1'`
 * branch. Three properties, all load-bearing:
 *
 *   · anvil's ten pre-funded accounts are on `m/44'/60'/0'`, so nothing here
 *     can collide with a suite in another service again.
 *   · `EvmLiveChain` derives its acceptance addresses from this same public
 *     mnemonic on the DEFAULT branch, so the hot wallet cannot accidentally BE
 *     a deposit address — which is the property the first test asserts and
 *     which a shared 2^31 index space only made overwhelmingly likely.
 *   · the mnemonic is unchanged and still the public `…junk` phrase. No new
 *     key material enters the repository; only the derivation path moves.
 *
 * Derived accounts hold nothing at genesis, so they are funded with
 * `anvil_setBalance` — a direct state write with no sender and no nonce. A
 * faucet TRANSFER would just move the race onto the faucet's account.
 */
const SUITE_BRANCH_ACCOUNT_INDEX = 1;

function suiteSenderIndex(role: string): number {
  const path = decodeURIComponent(import.meta.url.replace(/^file:\/\//, '')).replace(/\\/g, '/');
  const id = `${path.slice(path.lastIndexOf('/services/') + 1).toLowerCase()}#${role}`;
  return createHash('sha256').update(id).digest().readUInt32BE(0) & 0x7fff_ffff;
}

/** A private key for one of this file's own derived accounts. Public mnemonic; worthless. */
function suiteKey(role: string): Hex {
  const hd = mnemonicToAccount(DEPOSIT_MNEMONIC, {
    accountIndex: SUITE_BRANCH_ACCOUNT_INDEX,
    addressIndex: suiteSenderIndex(role),
  }).getHdKey();
  if (!hd.privateKey) throw new Error('derived HD account has no private key');
  return toHex(hd.privateKey);
}

const HOT_KEY = suiteKey('hot-wallet');
const PAYER_KEY = suiteKey('payer');

const chainDef = defineChain({
  id: CHAIN_ID,
  name: 'pay-anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

function payEvmRequired(): boolean {
  return process.env.REQUIRE_PAY_EVM === '1';
}

/** Journalled JSON-RPC probe — the private `catch { return false }` is gone. */
async function payEvmReachable(): Promise<boolean> {
  let reason = '';
  try {
    const client = createPublicClient({
      chain: chainDef,
      transport: http(RPC, { timeout: 2_000, retryCount: 0 }),
    });
    const id = await client.getChainId();
    if (id === CHAIN_ID) {
      recordInfraProbe({ dependency: 'evm-chain', outcome: 'ran', target: RPC });
      return true;
    }
    reason = `chain id ${id} != expected ${CHAIN_ID}`;
  } catch (err) {
    reason = describeError(err);
  }
  if (payEvmRequired()) {
    recordInfraProbe({ dependency: 'evm-chain', outcome: 'required-failed', target: RPC, reason });
    throw new Error(`REQUIRE_PAY_EVM=1 but no chain at ${RPC} (chainId ${CHAIN_ID}): ${reason}`);
  }
  recordInfraProbe({ dependency: 'evm-chain', outcome: 'skipped', target: RPC, reason });
  return false;
}

/**
 * Give the derived senders a balance outright.
 *
 * `anvil_setBalance` is anvil-only on purpose — it cannot silently work against
 * a real node — and the client-version check runs FIRST, so the refusal happens
 * before anything is written. This mirrors `assertDisposableChain` in
 * svc-protocol's `scripts/dev-chain.ts`; svc-pay cannot import that file
 * (services do not import each other's source), so the check is restated here.
 */
async function fundFromNothing(addresses: readonly Address[]): Promise<void> {
  const client = createPublicClient({ chain: chainDef, transport: http(RPC) });
  const version = (await client.request({ method: 'web3_clientVersion' } as never)) as string;
  if (!/anvil|hardhat/i.test(version)) {
    throw new Error(
      `REFUSING to fund test accounts on "${version}". This suite signs with the public \`…junk\` mnemonic and may ` +
        `only ever touch a throwaway anvil/hardhat node.`,
    );
  }
  for (const address of addresses) {
    await client.request({ method: 'anvil_setBalance', params: [address, toHex(10_000n * 10n ** 18n)] } as never);
  }
}

const reachable = await payEvmReachable();
const describeLive = reachable ? describe : describe.skip;

describeLive('EvmLiveChain against a real node', () => {
  let port: EvmLiveChain;
  let payer: ReturnType<typeof privateKeyToAccount>;

  beforeAll(async () => {
    payer = privateKeyToAccount(PAYER_KEY);
    await fundFromNothing([privateKeyToAccount(HOT_KEY).address, payer.address]);

    port = new EvmLiveChain({
      rpcUrl: RPC,
      chainId: CHAIN_ID,
      depositMnemonic: DEPOSIT_MNEMONIC,
      signer: TestnetSigner.fromFixtureKey(HOT_KEY),
      assets: parseEvmAssets('ETH:native'),
      broadcasts: new MemoryBroadcastStore(),
      minConfirmations: 1,
    });
  });

  afterAll(() => {
    // nothing to close — http transport is stateless
  });

  it('reports posture live and derives a stable acceptance address', async () => {
    expect(port.posture).toBe('live');
    const a = await port.acceptanceAddress('pay_live_1', 'ETH');
    const b = await port.acceptanceAddress('pay_live_1', 'ETH');
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Not the hot wallet — deposits must not land on the payout key.
    expect(a.toLowerCase()).not.toBe(port.hotWalletAddress().toLowerCase());
  });

  it('sees a native deposit and exposes it as inboundTransfer', async () => {
    // Unique payment id → unique HD address. A shared anvil (e2e / prior runs)
    // may already hold funds at a reused index; first-inbound-wins would then
    // report the older txHash instead of this deposit.
    const paymentId = `pay_live_deposit_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const address = await port.acceptanceAddress(paymentId, 'ETH');
    const wallet = createWalletClient({
      account: payer,
      chain: chainDef,
      transport: http(RPC),
    });
    const publicClient = createPublicClient({ chain: chainDef, transport: http(RPC) });

    const hash = await wallet.sendTransaction({
      account: payer,
      to: address as `0x${string}`,
      value: parseEther('0.05'),
      chain: chainDef,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    // Mine a couple of empty blocks so confirmations advance on anvil.
    for (let i = 0; i < 2; i++) {
      await publicClient.request({ method: 'evm_mine' as never, params: [] as never }).catch(() => undefined);
    }

    // Rescan from the block this deposit landed in, not from genesis.
    //
    // `refresh()` walks blocks one `eth_getBlock` at a time, so `resetScan(0n)`
    // costs one round trip per block that has ever been mined. On CI's anvil
    // that is a handful; on the compose `evm` container, which is
    // `restart: unless-stopped` and therefore accumulates every block every
    // `pnpm verify` has ever produced, it grows without bound and eventually
    // blows the 5s test timeout — a red suite whose cause is the age of the
    // developer's docker container.
    //
    // The window still contains the deposit, the blocks are still real, and
    // the port still has to find the transfer by reading them. All that is
    // dropped is the re-reading of blocks mined before the test began.
    port.resetScan(receipt.blockNumber);
    const transfer = await port.inboundTransfer(address);
    expect(transfer).not.toBeNull();
    expect(transfer!.assetId).toBe('ETH');
    expect(transfer!.amount).toBe(parseAmount('0.05'));
    expect(transfer!.from.toLowerCase()).toBe(payer.address.toLowerCase());
    expect(transfer!.confirmations).toBeGreaterThanOrEqual(1);
    expect(transfer!.txHash).toBe(hash);
  });

  it('makes crypto-native a LIVE rail and pays out idempotently', async () => {
    const adapter = new CryptoNativeAdapter({ chain: port, secret: SECRET, minConfirmations: 1, toleranceSeconds: 300 });
    expect(adapter.mode).toBe('live');

    const dest = mnemonicToAccount(DEPOSIT_MNEMONIC, { addressIndex: 99 }).address;
    const first = await adapter.payout({
      settlementId: 'settle_live_1',
      merchantId: 'm1',
      amount: parseAmount('0.01'),
      assetId: 'ETH',
      window: '2026-07-31',
      destination: { kind: 'crypto', ref: dest },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await adapter.payout({
      settlementId: 'settle_live_1',
      merchantId: 'm1',
      amount: parseAmount('0.01'),
      assetId: 'ETH',
      window: '2026-07-31',
      destination: { kind: 'crypto', ref: dest },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.railRef).toBe(first.railRef);
  });
});
