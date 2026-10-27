import { createHash, pbkdf2Sync } from 'node:crypto';
import { createPublicClient, createWalletClient, defineChain, getContract, http, toHex } from 'viem';
import type { Transport } from 'viem';
import { HDKey, hdKeyToAccount } from 'viem/accounts';
import type { Address, Chain, Hex, HDAccount, PublicClient, WalletClient } from 'viem';
import { loadArtifact } from '../src/chain/artifacts.js';

/**
 * THE LOCAL DEV CHAIN — everything that must never reach production.
 *
 * This file lives in `scripts/`, not `src/`, and that is load-bearing.
 * `tsconfig.json` includes only `src/**`, so nothing here is compiled into
 * `dist/` and nothing here can be imported by the running service. `env.ts`
 * states that svc-protocol holds no signing key of any kind; that statement
 * stays true of the shipped service because the only key in this repository
 * sits in a file the service cannot reach.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MNEMONIC BELOW IS PUBLIC. IT IS SUPPOSED TO BE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `test test test test test test test test test test test junk` is the phrase
 * Foundry, Hardhat and Ganache all print to the terminal on every start. It is
 * in their documentation, in thousands of repositories, and in every tutorial
 * ever written about local EVM development. Anyone can spend anything its
 * accounts hold on any chain, which is exactly why it must only ever touch a
 * chain whose entire state is disposable.
 *
 * `assertDisposableChain` below is what enforces that. It refuses to sign
 * anything unless the endpoint identifies itself as anvil/hardhat AND reports
 * the dev chain id. A fat-fingered `PROTOCOL_RPC_URL` pointing at a real
 * network gets a refusal, not a transaction.
 *
 * If you are reading this because you want to deploy for real: you do not want
 * this file. A production deployment is a key-management decision, made by a
 * human, with a key this repository has never seen.
 */

/** Anvil/Hardhat's default local chain id. */
export const DEV_CHAIN_ID = 31337;

/**
 * PUBLIC, WELL-KNOWN, WORTHLESS. See the banner above. Named so that no reader
 * and no scanner can mistake it for a credential.
 */
export const PUBLIC_ANVIL_DEV_MNEMONIC = 'test test test test test test test test test test test junk';

/** Anvil account #0's address — the deployer `chain:deploy` uses. */
export const PUBLIC_ANVIL_DEV_ACCOUNT_0_ADDRESS: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/**
 * BIP-39 seed, derived once on first use. Child accounts are cached by path
 * so a repeated path returns the same object. Suites that never ask for an
 * account never pay this cost.
 *
 * The KDF is PBKDF2-HMAC-SHA512, 2048 rounds, 64 bytes: the same inputs as
 * `@scure/bip39`'s `mnemonicToSeedSync`. That helper runs the rounds in pure
 * JavaScript, and one call plus the module load exceeds the 5s budget of the
 * derivation test on a loaded CI runner. Node's `pbkdf2Sync` is the OpenSSL
 * implementation of that same KDF.
 */
let devRoot: HDKey | undefined;
const devAccountByPath = new Map<string, HDAccount>();

const BIP39_ROUNDS = 2048;
const BIP39_SEED_BYTES = 64;

function devMnemonicSeed(mnemonic: string, passphrase = ''): Uint8Array {
  const password = Buffer.from(mnemonic.normalize('NFKD'), 'utf8');
  const salt = Buffer.from(`mnemonic${passphrase}`.normalize('NFKD'), 'utf8');
  return Uint8Array.from(pbkdf2Sync(password, salt, BIP39_ROUNDS, BIP39_SEED_BYTES, 'sha512'));
}

function devHdPath(accountIndex: number, addressIndex: number): string {
  return `m/44'/60'/${accountIndex}'/0/${addressIndex}`;
}

function devRootKey(): HDKey {
  if (!devRoot) {
    devRoot = HDKey.fromMasterSeed(devMnemonicSeed(PUBLIC_ANVIL_DEV_MNEMONIC));
  }
  return devRoot;
}

function accountAt(accountIndex: number, addressIndex: number): HDAccount {
  const path = devHdPath(accountIndex, addressIndex);
  const cached = devAccountByPath.get(path);
  if (cached) return cached;
  const child = devRootKey().derive(path);
  // `derive('m')` returns the same key. viem's path type only allows a BIP-44
  // string, so the master path is asserted and the child is not derived again.
  const account = hdKeyToAccount(child, { path: 'm' as `m/44'/60'/${string}` });
  devAccountByPath.set(path, account);
  return account;
}

/**
 * One of anvil's ten pre-funded accounts (`m/44'/60'/0'/0/{index}`).
 *
 * Index 0 is reserved for `deploy-dev.ts`, because the addresses it produces
 * are the ones named in docker-compose.apps.yml and they depend on that
 * account's nonce.
 *
 * **Test suites must NOT call this.** They call `devSuiteClients()` below —
 * see the banner there for why a hand-picked index is the wrong tool.
 */
export function devAccount(index = 0): HDAccount {
  return accountAt(0, index);
}

/**
 * Receipt polling for the dev chain. anvil mines each transaction the moment it arrives, but viem polls for a
 * receipt every 4 s by default (about a second per write in practice), which put long on-chain tests at their
 * 30 s timeout.
 */
export const DEV_RECEIPT_POLL_MS = 50;

/**
 * Wrap a transport so `eth_estimateGas` returns twice the estimate.
 *
 * The node estimates against a block stamped with the wall clock, but instant mining then stamps the real block a
 * second later whenever the clock ticks in between. Contracts that do more work once the timestamp has moved (the
 * lending market's `accrue()` runs only when the timestamp changed) then need more gas than the estimate, and
 * viem sends exactly the estimate, so the transaction runs out of gas and is mined as reverted. Headroom is
 * refunded, so it costs nothing on a disposable chain.
 */
export function withGasHeadroom(base: Transport): Transport {
  return (params) => {
    const transport = base(params);
    const request = (async (args: { method: string; params?: unknown }) => {
      const result = await transport.request(args as never);
      return args.method === 'eth_estimateGas' ? toHex(BigInt(result as string) * 2n) : result;
    }) as typeof transport.request;
    return { ...transport, request };
  };
}

export const devChain = (rpcUrl: string, chainId: number = DEV_CHAIN_ID): Chain =>
  defineChain({
    id: chainId,
    name: `intafaced-dev-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

/** Where the dev chain is, honouring the same env the service reads. */
export function devRpcUrl(): string {
  return process.env.PROTOCOL_RPC_URL ?? 'http://127.0.0.1:8545';
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
      `REFUSING to use the public dev key against "${version}". This script only ever signs on a throwaway ` +
        `anvil/hardhat node. Point PROTOCOL_RPC_URL at the compose \`evm\` service (docker compose up -d evm).`,
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

export function devChainClients(rpcUrl = devRpcUrl(), chainId = DEV_CHAIN_ID, accountIndex = 0): DevChainClients {
  const chain = devChain(rpcUrl, chainId);
  const account = devAccount(accountIndex);
  return {
    publicClient: createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: DEV_RECEIPT_POLL_MS }) as PublicClient,
    walletClient: createWalletClient({ account, chain, transport: withGasHeadroom(http(rpcUrl)) }),
    deployer: account.address,
    rpcUrl,
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PER-SUITE SENDERS — WHY A HAND-PICKED ACCOUNT INDEX IS NOT A FIX
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Vitest runs test files in parallel workers, and `pnpm verify` runs packages
 * in parallel on top of that. Two files that send from the SAME account both
 * read `eth_getTransactionCount(pending)`, both get N, and both broadcast with
 * nonce N. One is mined; the other gets `nonce too low` — on a chain that is
 * behaving perfectly, in a file whose diff contains nothing wrong.
 *
 * The previous answer was a comment convention: every live-chain file picked a
 * different one of anvil's ten pre-funded accounts, and each file's header
 * recited which index the others had taken. That is a registry maintained by
 * copy-paste across three services, and it did what registries maintained by
 * copy-paste do. By the time this was written it had drifted into two silent
 * collisions — index 3 (`token-factory-onchain` + `pool-factory-onchain`) and
 * index 4 (`mint-swap-onchain` + `router-launch-live`) — plus a third across
 * services, svc-pay's live rail suite sending from indices 0 and 1 while
 * svc-protocol's `deploy-dev` and `create2-onchain` used the same two. It also
 * had a hard ceiling: ten accounts, and svc-protocol alone wants six.
 *
 * So the index is no longer picked. It is DERIVED from the suite's own path:
 *
 *   · Distinct files get distinct senders because distinct paths hash apart.
 *     Nothing to remember, nothing to keep in sync, no ceiling, and a new
 *     on-chain suite is isolated the moment it is written.
 *   · The derivation is stable across machines and CI (it keys off the path
 *     from `services/` down, not the checkout root), so a failure is
 *     reproducible and the sender is greppable from the address.
 *   · Two checkouts of the same file DO get the same sender. That is correct:
 *     they are the same suite, and running one repo twice at once against one
 *     dev chain is not a thing this promises to support.
 *
 * ── Why a whole other HD branch ────────────────────────────────────────────
 *
 * anvil's ten pre-funded accounts are `m/44'/60'/0'/0/{0..9}`. Suite senders
 * live at `m/44'/60'/1'/0/{i}` — a different BIP-44 account, so the subtrees
 * are disjoint by construction rather than by staying below/above some agreed
 * number. A derived sender can never BE one of the ten, so `deploy-dev.ts`'s
 * nonce-0/1/2/3 CREATE addresses (which docker-compose.apps.yml names) stay
 * exactly as deterministic as they were. It is also disjoint from the deposit
 * addresses svc-pay derives from this same public mnemonic, which use the
 * default account branch.
 *
 * ── Why funding is a state write, not a transfer ───────────────────────────
 *
 * `m/44'/60'/1'/0/{i}` holds nothing at genesis, so it has to be funded. A
 * faucet TRANSFER would re-introduce exactly the bug being fixed: every suite
 * would race the faucet's nonce instead of the deployer's. `anvil_setBalance`
 * writes the balance directly — no transaction, no nonce, no sender, nothing
 * to race. It is an anvil-only method, which is the point: it cannot silently
 * work against a real node, and `devSuiteClients` calls
 * `assertDisposableChain` BEFORE it, so the throwaway-chain check is what
 * gates the state write rather than something that runs after it.
 */

/** The BIP-44 account branch reserved for derived test senders. See above. */
const SUITE_BRANCH_ACCOUNT_INDEX = 1;

/** What each derived sender is topped up to: anvil's own default balance. */
export const SUITE_FUNDING_WEI = 10_000n * 10n ** 18n;

/**
 * The suite's identity for derivation purposes: its path from `services/` down,
 * separators normalised and case-folded. Independent of where the repository is
 * checked out, so the same suite gets the same sender on a laptop, in a git
 * worktree, and on CI.
 */
export function suiteId(suiteFileUrl: string): string {
  // Deliberately string surgery rather than `fileURLToPath`: that function is
  // platform-aware and rejects a POSIX file URL when it runs on Windows, so a
  // helper built on it would derive fine from `import.meta.url` and throw the
  // moment anything passed it a path shaped like the other operating system.
  const withoutScheme = suiteFileUrl.replace(/^file:\/\//, '');
  const decoded = decodeURIComponent(withoutScheme).replace(/\\/g, '/');
  const anchor = decoded.lastIndexOf('/services/');
  return (anchor === -1 ? decoded : decoded.slice(anchor + 1)).toLowerCase();
}

/**
 * The HD address index this suite sends from.
 *
 * SHA-256 over the suite id, truncated to 31 bits because BIP-32 non-hardened
 * child indices stop at 2^31 - 1. Two suites collide only if their paths
 * collide in that space; with the order of ten on-chain suites in this repo
 * that is around one in 10^7, and `dev-chain.test.ts` checks the actual set
 * rather than trusting the estimate.
 */
export function suiteSenderIndex(suiteFileUrl: string): number {
  const digest = createHash('sha256').update(suiteId(suiteFileUrl)).digest();
  return digest.readUInt32BE(0) & 0x7fff_ffff;
}

/** The account a given suite sends from. Never one of anvil's ten. */
export function suiteAccount(suiteFileUrl: string): HDAccount {
  return accountAt(SUITE_BRANCH_ACCOUNT_INDEX, suiteSenderIndex(suiteFileUrl));
}

/**
 * Give `address` a balance outright.
 *
 * anvil-only, deliberately — see the banner above. Callers must have run
 * `assertDisposableChain` first.
 */
export async function fundDevAccount(client: PublicClient, address: Address, wei: bigint = SUITE_FUNDING_WEI): Promise<void> {
  await client.request({ method: 'anvil_setBalance', params: [address, toHex(wei)] } as never);
}

/**
 * Clients for one test file, sending from that file's own derived, funded
 * account. Pass `import.meta.url` — the caller's identity IS the isolation.
 *
 * Replaces `devChainClients(url, id, <hand-picked index>)` +
 * `assertDisposableChain(...)` in on-chain suites, and does the two in the
 * order that matters: the disposable-chain refusal runs before anything is
 * written to the node.
 */
export async function devSuiteClients(
  suiteFileUrl: string,
  rpcUrl = devRpcUrl(),
  chainId: number = DEV_CHAIN_ID,
): Promise<DevChainClients> {
  const chain = devChain(rpcUrl, chainId);
  const account = suiteAccount(suiteFileUrl);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: DEV_RECEIPT_POLL_MS }) as PublicClient;

  await assertDisposableChain(publicClient, chainId);
  await fundDevAccount(publicClient, account.address);

  return {
    publicClient,
    walletClient: createWalletClient({ account, chain, transport: withGasHeadroom(http(rpcUrl)) }),
    deployer: account.address,
    rpcUrl,
  };
}

/** True when a JSON-RPC endpoint answers at all. Never throws. */
export async function devChainReachable(rpcUrl = devRpcUrl()): Promise<boolean> {
  try {
    const client = createPublicClient({ chain: devChain(rpcUrl), transport: http(rpcUrl, { timeout: 2_000, retryCount: 0 }) });
    await client.getChainId();
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirrors `postgresRequired()` in `packages/db`: a suite may skip on a laptop
 * with no chain running, but on CI a missing chain is a hard failure. Silent
 * green is how "we proved CREATE2 agrees" quietly stops being true.
 */
export function devChainRequired(): boolean {
  return process.env.REQUIRE_EVM_CHAIN === '1';
}

export interface DeployedSuite {
  readonly implementation: Address;
  readonly factory: Address;
  readonly entryPoint: Address;
  readonly implementationTx: Hex;
  readonly factoryTx: Hex;
}

/**
 * Deploy the smart-account suite: the SmartAccount implementation, then the
 * AccountFactory that clones it.
 *
 * The EntryPoint is passed through, not deployed. It is the public ERC-4337
 * v0.7 singleton and we do not own it — see `deploy-dev.ts` for what that means
 * for the dev chain.
 */
export async function deployAccountSuite(clients: DevChainClients, entryPoint: Address): Promise<DeployedSuite> {
  const { publicClient, walletClient } = clients;
  const account = walletClient.account;
  if (!account) throw new Error('deployAccountSuite needs a wallet client with an account');

  const smartAccount = loadArtifact('SmartAccount');
  const factory = loadArtifact('AccountFactory');

  const implementationTx = await walletClient.deployContract({
    abi: smartAccount.abi,
    bytecode: smartAccount.bytecode,
    args: [entryPoint],
    account,
    chain: walletClient.chain,
  });
  const implReceipt = await publicClient.waitForTransactionReceipt({ hash: implementationTx });
  if (implReceipt.status !== 'success' || !implReceipt.contractAddress) {
    throw new Error(`SmartAccount deployment failed: ${implementationTx}`);
  }

  const factoryTx = await walletClient.deployContract({
    abi: factory.abi,
    bytecode: factory.bytecode,
    args: [implReceipt.contractAddress],
    account,
    chain: walletClient.chain,
  });
  const factoryReceipt = await publicClient.waitForTransactionReceipt({ hash: factoryTx });
  if (factoryReceipt.status !== 'success' || !factoryReceipt.contractAddress) {
    throw new Error(`AccountFactory deployment failed: ${factoryTx}`);
  }

  // The factory hard-codes the implementation into every clone it makes. If it
  // did not get the one we just deployed, every address derived below is wrong.
  const onChainImplementation = await publicClient.readContract({
    address: factoryReceipt.contractAddress,
    abi: factory.abi,
    functionName: 'implementation',
  });
  if ((onChainImplementation as string).toLowerCase() !== implReceipt.contractAddress.toLowerCase()) {
    throw new Error(`AccountFactory.implementation is ${String(onChainImplementation)}, expected ${implReceipt.contractAddress}`);
  }

  return {
    implementation: implReceipt.contractAddress,
    factory: factoryReceipt.contractAddress,
    entryPoint,
    implementationTx,
    factoryTx,
  };
}

/** The deployed factory, ready to read. */
export function accountFactoryAt(clients: DevChainClients, address: Address) {
  return getContract({ address, abi: loadArtifact('AccountFactory').abi, client: clients.publicClient });
}

/**
 * Deploy the launch `TokenFactory` (§8.4).
 *
 * Takes no constructor arguments and links nothing: the factory embeds
 * `SovereignToken`'s creation code via `type(T).creationCode`, so the template
 * lives inside the factory's own bytecode and there is no implementation
 * address to point at and get wrong.
 *
 * Worth stating because it inverts the risk in `deployAccountSuite`, where the
 * implementation is a separate deployment that has to be checked against the
 * factory. Here the equivalent failure is the standalone `SovereignToken.json`
 * bytecode drifting from the copy embedded in the factory — which is exactly
 * what `token-factory-onchain.test.ts` rules out by comparing our init code with
 * the factory's own `initCode()`.
 */
export async function deployTokenFactory(clients: DevChainClients): Promise<{ factory: Address; tx: Hex }> {
  const { publicClient, walletClient } = clients;
  const account = walletClient.account;
  if (!account) throw new Error('deployTokenFactory needs a wallet client with an account');

  const artifact = loadArtifact('TokenFactory');
  const tx = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    account,
    chain: walletClient.chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`TokenFactory deployment failed: ${tx}`);
  }
  return { factory: receipt.contractAddress, tx };
}

/** The deployed launch factory, ready to read. */
export function tokenFactoryAt(clients: DevChainClients, address: Address) {
  return getContract({ address, abi: loadArtifact('TokenFactory').abi, client: clients.publicClient });
}

/**
 * Deploy the AMM `PoolFactory` (`protocol.amm`).
 *
 * No constructor args — pools are CREATE2'd later per (token0, token1, feeBps).
 * Same disposable-chain rules as the rest of this file.
 */
export async function deployPoolFactory(clients: DevChainClients): Promise<{ factory: Address; tx: Hex }> {
  const { publicClient, walletClient } = clients;
  const account = walletClient.account;
  if (!account) throw new Error('deployPoolFactory needs a wallet client with an account');

  const artifact = loadArtifact('PoolFactory');
  const tx = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    account,
    chain: walletClient.chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`PoolFactory deployment failed: ${tx}`);
  }
  return { factory: receipt.contractAddress, tx };
}

/** The deployed AMM factory, ready to read. */
export function poolFactoryAt(clients: DevChainClients, address: Address) {
  return getContract({ address, abi: loadArtifact('PoolFactory').abi, client: clients.publicClient });
}
