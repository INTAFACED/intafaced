import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, pad, stringToHex, toHex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import type { Abi, Address, Chain, Hex, HDAccount, PublicClient, WalletClient } from 'viem';
import { describeError, recordInfraProbe } from '@intafaced/db';

/**
 * THE DEV CHAIN, FROM THE INDEXER'S SIDE — everything that must never ship.
 *
 * This file lives in `scripts/`, not `src/`, and that is load-bearing.
 * `tsconfig.json` includes only `src/**`, so nothing here is compiled into
 * `dist/` and nothing here can be imported by the running service.
 * `src/sovereignty.test.ts` asserts, over every `.ts` under `src/`, that this
 * service creates no wallet client and derives no account from a key — and that
 * assertion stays true precisely because the only key in svc-indexer sits in a
 * file the service cannot reach. svc-protocol draws the same line in
 * `scripts/dev-chain.ts` for the same reason.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MNEMONIC BELOW IS PUBLIC. IT IS SUPPOSED TO BE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `test test test test test test test test test test test junk` is the phrase
 * Foundry, Hardhat and Ganache all print to the terminal on every start. Anyone
 * can spend anything its accounts hold on any chain, which is exactly why it must
 * only ever touch a chain whose entire state is disposable.
 *
 * `assertDisposableChain` is what enforces that: it refuses to sign unless the
 * endpoint identifies itself as anvil/hardhat AND reports the dev chain id. It is
 * duplicated from svc-protocol rather than imported because the guard is four
 * lines and the alternative is a runtime dependency between two services for the
 * benefit of a test fixture — the compiler pin is worth sharing (see
 * `contract-sources.mjs`); a `web3_clientVersion` check is not.
 */

/** Anvil/Hardhat's default local chain id. */
export const DEV_CHAIN_ID = 31337;

/** PUBLIC, WELL-KNOWN, WORTHLESS. See the banner above. */
export const PUBLIC_ANVIL_DEV_MNEMONIC = 'test test test test test test test test test test test junk';

/**
 * One of anvil's ten pre-funded accounts.
 *
 * Test files take DIFFERENT indices on purpose. Vitest runs files in parallel
 * workers, each deploys its own venue, and a shared deployer means two workers
 * racing the same nonce — which surfaces as `nonce too low` in whichever one
 * loses, intermittently, on a chain that is behaving perfectly. svc-protocol
 * reserves index 0 for its deploy script and uses low indices in its suites, so
 * this service starts at 5 to stay clear of it.
 */
export function devAccount(index = 5): HDAccount {
  return mnemonicToAccount(PUBLIC_ANVIL_DEV_MNEMONIC, { addressIndex: index });
}

export const devChain = (rpcUrl: string, chainId: number = DEV_CHAIN_ID): Chain =>
  defineChain({
    id: chainId,
    name: `intafaced-dev-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

/** Where the dev chain is. `INDEXER_RPC_URL` first, then svc-protocol's env, then the convention. */
export function devRpcUrl(): string {
  return process.env.INDEXER_RPC_URL || process.env.PROTOCOL_RPC_URL || 'http://127.0.0.1:8545';
}

/**
 * The SECOND dev chain — the `evm-reorg` service, port 8546.
 *
 * A suite that reorgs must not share a node with suites that assume it does not.
 * `evm_revert` rewinds the whole node, so running the reorg suite against 8545
 * would rewind svc-protocol's deployed factory out from under its own live tests
 * — and `pnpm verify` runs package tasks in parallel, so "they will not overlap"
 * is not available as an assumption. See the `evm-reorg` block in
 * docker-compose.yml for the full argument.
 */
export function reorgRpcUrl(): string {
  return process.env.INDEXER_REORG_RPC_URL || 'http://127.0.0.1:8546';
}

/**
 * True when a JSON-RPC endpoint answers at all. Never throws.
 *
 * Journalled either way. A chain-backed suite that skips is invisible in turbo's
 * "N successful" exactly like a database-backed one was, and the reorg proof is
 * the last thing that should be able to disappear quietly. See
 * `packages/db/src/infra-journal.ts` and `tooling/ci/infra-verdict.mjs`.
 */
export async function devChainReachable(rpcUrl = devRpcUrl()): Promise<boolean> {
  try {
    const client = createPublicClient({ chain: devChain(rpcUrl), transport: http(rpcUrl, { timeout: 2_000, retryCount: 0 }) });
    await client.getChainId();
    recordInfraProbe({ dependency: 'evm-chain', outcome: 'ran', target: rpcUrl });
    return true;
  } catch (err) {
    const reason = describeError(err);
    recordInfraProbe({
      dependency: 'evm-chain',
      outcome: devChainRequired() ? 'required-failed' : 'skipped',
      target: rpcUrl,
      reason,
    });
    return false;
  }
}

/**
 * Mirrors `postgresRequired()` in `packages/db`: a suite may skip on a laptop
 * with no chain running, but on CI a missing chain is a hard failure. Silent
 * green is how "we proved the projection survives a reorg" quietly stops being
 * true.
 */
export function devChainRequired(): boolean {
  return process.env.REQUIRE_EVM_CHAIN === '1';
}

/**
 * Refuse to sign against anything that is not a disposable local node.
 *
 * Two independent checks, because either alone is bypassable by accident:
 *   · `web3_clientVersion` must name anvil or hardhat. A real node does not.
 *   · the chain id must be the dev id. Somebody could run anvil forked from
 *     mainnet with `--chain-id 1`; that node's state is not disposable in the
 *     sense that matters, because a broadcast could reach the real network.
 */
export async function assertDisposableChain(client: PublicClient, expectedChainId = DEV_CHAIN_ID): Promise<string> {
  const version = (await client.request({ method: 'web3_clientVersion' } as never)) as string;
  if (!/anvil|hardhat/i.test(version)) {
    throw new Error(
      `REFUSING to use the public dev key against "${version}". DevVenue lets anyone publish any trade they like, ` +
        `and this script only ever signs on a throwaway anvil/hardhat node. Point INDEXER_RPC_URL at the compose ` +
        `\`evm\` service (docker compose up -d evm).`,
    );
  }
  const observed = await client.getChainId();
  if (observed !== expectedChainId) {
    throw new Error(
      `REFUSING: the node at this endpoint reports chain ${observed}, not the dev chain ${expectedChainId}. ` +
        `A dev key must never sign on a chain whose state somebody depends on.`,
    );
  }
  return version;
}

export interface DevChainClients {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly deployer: Address;
  readonly rpcUrl: string;
}

export function devChainClients(rpcUrl = devRpcUrl(), chainId = DEV_CHAIN_ID, accountIndex = 5): DevChainClients {
  const chain = devChain(rpcUrl, chainId);
  const account = devAccount(accountIndex);
  return {
    publicClient: createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient,
    walletClient: createWalletClient({ account, chain, transport: http(rpcUrl) }),
    deployer: account.address,
    rpcUrl,
  };
}

export interface DevVenueArtifact {
  readonly contractName: string;
  /** Compiler version recorded on `contracts/out/DevVenue.json`. */
  readonly solcVersion: string;
  readonly sourceHash: Hex;
  readonly abi: Abi;
  readonly bytecode: Hex;
  readonly deployedBytecode: Hex;
}

export class MissingArtifactError extends Error {
  constructor(name: string, cause: unknown) {
    super(
      `No compiled artefact for ${name}. Run \`pnpm --filter @intafaced/svc-indexer contracts:build\`. ` +
        `Artefacts are committed under contracts/out/ so tests and deploys do not each run a compiler.`,
      { cause },
    );
    this.name = 'MissingArtifactError';
  }
}

/**
 * Resolved from `import.meta.url` rather than `process.cwd()` so it works the
 * same from `src/` under vitest and from `scripts/` under tsx — both sit exactly
 * two levels below the service root.
 */
export function loadDevVenueArtifact(): DevVenueArtifact {
  const url = new URL('../contracts/out/DevVenue.json', import.meta.url);
  try {
    return JSON.parse(readFileSync(url, 'utf8')) as DevVenueArtifact;
  } catch (err) {
    throw new MissingArtifactError('DevVenue', err);
  }
}

export interface DeployedVenue {
  readonly address: Address;
  /** The block the contract landed in — what `INDEXER_START_HEIGHT` should be. */
  readonly deploymentBlock: number;
  readonly abi: Abi;
}

/** Deploy a DevVenue. Refuses on anything that is not a throwaway node. */
export async function deployDevVenue(clients: DevChainClients, chainId = DEV_CHAIN_ID): Promise<DeployedVenue> {
  await assertDisposableChain(clients.publicClient, chainId);

  const { publicClient, walletClient } = clients;
  const account = walletClient.account;
  if (!account) throw new Error('deployDevVenue needs a wallet client with an account');

  const artifact = loadDevVenueArtifact();
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    account,
    chain: walletClient.chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`DevVenue deployment failed: ${hash}`);
  }

  // The runtime code at the address must be the runtime code we compiled. If it
  // is not, something else is at that address and every log this suite indexes
  // afterwards would be attributed to a contract nobody reviewed.
  const onChain = await publicClient.getCode({ address: receipt.contractAddress });
  if (onChain?.toLowerCase() !== artifact.deployedBytecode.toLowerCase()) {
    throw new Error(
      `The code at ${receipt.contractAddress} is not the DevVenue this repo compiled. ` +
        `Expected ${artifact.deployedBytecode.length} chars of runtime, got ${onChain?.length ?? 0}.`,
    );
  }

  return {
    address: receipt.contractAddress,
    deploymentBlock: Number(receipt.blockNumber),
    abi: artifact.abi,
  };
}

/**
 * `"ETH-USD"` → the `bytes32` the contract expects.
 *
 * Left-aligned and zero-padded, which is how a Solidity `bytes32("…")` literal
 * lays out and what `decode.ts` unpacks.
 */
export function marketWord(symbol: string): Hex {
  if (symbol.length === 0 || symbol.length > 32) throw new Error(`market symbol must be 1..32 chars, got "${symbol}"`);
  return pad(stringToHex(symbol), { dir: 'right', size: 32 });
}

/** A decimal string → the 18-decimal integer the contract carries. No floats. */
export function scaled(decimalString: string): bigint {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(decimalString.trim());
  if (!match) throw new Error(`not a decimal string: "${decimalString}"`);
  const [, sign, whole, frac = ''] = match;
  if (frac.length > 18) throw new Error(`"${decimalString}" has more than 18 decimal places`);
  const value = BigInt(whole ?? '0') * 10n ** 18n + BigInt(frac.padEnd(18, '0') || '0');
  return sign === '-' ? -value : value;
}

// ── anvil's own controls ────────────────────────────────────────────────────
//
// Everything below drives the NODE, not a contract. It is how a test forks a
// chain on demand — the one thing a real chain will never do when asked, and
// the reason every reorg assertion in this service was previously made against
// a hash this repository computed itself.

/** `evm_snapshot` — an id `revertTo` can rewind to. Single use, per anvil. */
export async function snapshot(client: PublicClient): Promise<Hex> {
  return (await client.request({ method: 'evm_snapshot', params: [] } as never)) as Hex;
}

/**
 * `evm_revert` — drop every block above the snapshot.
 *
 * This is a genuine reorg from the indexer's point of view: blocks it has
 * already read and projected stop existing, and the blocks mined afterwards
 * occupy the same heights with different hashes, because their transactions and
 * timestamps differ. Nothing about it is simulated on our side — the node really
 * does discard them, and `eth_getBlockByNumber` really does start answering with
 * a different hash at the same height.
 */
export async function revertTo(client: PublicClient, id: Hex): Promise<boolean> {
  return (await client.request({ method: 'evm_revert', params: [id] } as never)) as boolean;
}

/** `evm_mine` — mine `count` empty blocks. */
export async function mine(client: PublicClient, count = 1): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await client.request({ method: 'evm_mine', params: [] } as never);
  }
}

/**
 * Force the next block's timestamp forward.
 *
 * After `evm_revert` the replacement branch is mined within the same second as
 * the branch it replaces, and anvil will then produce a block whose header
 * differs only by its transactions. That is still a different hash — but if the
 * replacement branch is EMPTY, it is not: same height, same parent, same
 * timestamp, no transactions, therefore the same block. A test that built one of
 * those would assert nothing at all, which is the failure mode
 * `MemoryChainSource.reorg` folds a salt in to avoid.
 */
export async function bumpNextTimestamp(client: PublicClient, seconds: number): Promise<void> {
  await client.request({ method: 'evm_increaseTime', params: [toHex(seconds)] } as never);
}
