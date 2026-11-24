import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiItem,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import {
  BRIDGE_AMOUNT_INVALID,
  BRIDGE_BURN_MISMATCH,
  BRIDGE_KEY_CONFLICT,
  BRIDGE_PROVIDER_UNSET,
  BRIDGE_ROUTE_UNKNOWN,
  BRIDGE_TOO_MANY_WAITING,
  BRIDGE_TRANSFER_NOT_FOUND,
  BRIDGE_UNREACHABLE,
  type BridgeRoute,
  type BridgeTransfer,
  type BridgeTransferState,
} from '@intafaced/contracts/protocol-bridge';

/**
 * Bridge transfers (D-bridge-chain-03, J-dex-protocol-05 #6 #7): burn on one chain, the provider's attestation, mint on
 * the other. Non-custodial: this service stores the person's intent and builds the unsigned burn and mint; the wallet
 * signs and sends both, nothing here holds a key, and nothing posts to the ledger.
 *
 * The intent is stored before the wallet is asked to burn, and its id goes into the burn, which the token refuses twice
 * for one intent. So a transfer whose page closed or whose process stopped after the intent was stored is resumed from
 * the chain on the next read: a burn for its intent is found and the row moves on; with none, the same burn is offered
 * again, and can only ever happen once.
 */
export class BridgeTransferError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'BridgeTransferError';
  }
}

export const BRIDGE_TOKEN_ABI = parseAbi([
  'function burn(bytes32 intentId, uint256 destinationChainId, address recipient, uint256 amount)',
  'function mint(bytes32 intentId, uint256 sourceChainId, address recipient, uint256 amount, bytes attestation)',
  'function burned(bytes32 intentId) view returns (bool)',
  'function minted(bytes32 intentId) view returns (bool)',
]);
export const BURNED_EVENT = parseAbiItem(
  'event Burned(bytes32 indexed intentId, address indexed sender, uint256 destinationChainId, address recipient, uint256 amount)',
);

/** A wallet keeps at most this many transfers waiting for their burn; one more is refused until one is burned. */
export const MAX_WAITING_PER_WALLET = 5;

export interface BridgeTransferRecord {
  id: string;
  wallet: Address;
  key: string;
  intentId: Hex;
  fromChainId: number;
  toChainId: number;
  token: string;
  amountUnits: bigint;
  state: BridgeTransferState;
  burnTx: Hex | null;
  attestation: Hex | null;
  createdAt: Date;
}
export type NewBridgeTransfer = Omit<BridgeTransferRecord, 'id' | 'state' | 'burnTx' | 'attestation' | 'createdAt'>;

export interface BridgeTransferStore {
  /** Inserts the intent, or answers the row already stored under its wallet and key (never a second row). */
  insert(row: NewBridgeTransfer): Promise<BridgeTransferRecord>;
  findByKey(wallet: Address, key: string): Promise<BridgeTransferRecord | null>;
  get(wallet: Address, id: string): Promise<BridgeTransferRecord | null>;
  list(wallet: Address): Promise<BridgeTransferRecord[]>;
  countWaiting(wallet: Address): Promise<number>;
  /** Moves a row on, only from the state it was read in; false when another call moved it first. */
  advance(
    id: string,
    from: BridgeTransferState,
    next: { state: BridgeTransferState; burnTx: Hex | null; attestation: Hex | null },
  ): Promise<boolean>;
}

/** The burn the wallet sent, as the source chain holds it: pending (no receipt yet), mined, or reverted. */
export interface SentBurn {
  from: Address;
  to: Address | null;
  input: Hex;
  status: 'pending' | 'success' | 'reverted';
}

/** One route chain, as this service reads it. */
export interface BridgeChain {
  burned(token: Address, intentId: Hex): Promise<boolean>;
  minted(token: Address, intentId: Hex): Promise<boolean>;
  /** The hash of the burn carrying `intentId`, from the token's Burned events; null when none is on chain. */
  burnTx(token: Address, intentId: Hex): Promise<Hex | null>;
  /** The transaction with this hash; null when the chain does not know it. */
  transaction(hash: Hex): Promise<SentBurn | null>;
}

export type Attestation = { status: 'pending' } | { status: 'ready'; attestation: Hex };

/** The provider a route is carried by: its token on every chain, the chains it reads, and its attestation service. */
export interface BridgeProvider {
  /** The token each route symbol is on both chains, and its decimals. */
  tokens: Readonly<Record<string, { address: Address; decimals: number }>>;
  chain(chainId: number): BridgeChain | null;
  attestation(sourceChainId: number, burnTx: Hex): Promise<Attestation>;
}

export interface BridgeTransfersDeps {
  routes: () => BridgeRoute[];
  /** Null while no provider is connected (`bridge.provider_unset`). */
  provider: () => BridgeProvider | null;
  store: BridgeTransferStore;
}

/** The intent id: keccak256 of the transfer's business key. */
export function bridgeIntentId(wallet: Address, key: string): Hex {
  return keccak256(toHex(`bridge:${wallet.toLowerCase()}:${key}`));
}

/** A positive decimal with at most `decimals` places, in the token's smallest unit; anything else refuses by name. */
function bridgeUnits(amount: string, decimals: number): bigint {
  const text = amount.trim();
  const m = /^\d{1,30}(?:\.(\d+))?$/.exec(text);
  if (!m || (m[1] ?? '').length > decimals)
    throw new BridgeTransferError(BRIDGE_AMOUNT_INVALID, `the amount must be a positive number with at most ${decimals} decimal places`);
  // Exact: the places were checked above, so parseUnits never rounds here.
  const units = parseUnits(text, decimals);
  if (units <= 0n) throw new BridgeTransferError(BRIDGE_AMOUNT_INVALID, 'the amount must be above zero');
  return units;
}

/** A hash or id in lower case, still typed as hex. */
export const lowerHex = (value: string): Hex => `0x${value.slice(2).toLowerCase()}`;

function formatUnitsExact(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

function requireProvider(deps: BridgeTransfersDeps): BridgeProvider {
  const provider = deps.provider();
  if (!provider)
    throw new BridgeTransferError(
      BRIDGE_PROVIDER_UNSET,
      'no bridge provider is connected; the owner has chosen none, so no transfer is built',
    );
  return provider;
}

function routeOf(
  deps: BridgeTransfersDeps,
  { fromChainId, toChainId, token }: { fromChainId: number; toChainId: number; token: string },
): BridgeRoute {
  const route = deps.routes().find((r) => r.from.chainId === fromChainId && r.to.chainId === toChainId && r.token === token);
  if (!route)
    throw new BridgeTransferError(BRIDGE_ROUTE_UNKNOWN, `no published route carries ${token} from chain ${fromChainId} to ${toChainId}`);
  return route;
}

function chainOf(provider: BridgeProvider, chainId: number): BridgeChain {
  const chain = provider.chain(chainId);
  if (!chain) throw new BridgeTransferError(BRIDGE_UNREACHABLE, `the bridge provider reads no chain ${chainId}`);
  return chain;
}

function tokenOf(provider: BridgeProvider, symbol: string) {
  const token = provider.tokens[symbol];
  if (!token) throw new BridgeTransferError(BRIDGE_ROUTE_UNKNOWN, `the bridge provider carries no ${symbol}`);
  return token;
}

/** A chain or attestation read that failed is the provider being unreachable; a refusal of ours passes as it is. */
async function reading<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof BridgeTransferError) throw err;
    throw new BridgeTransferError(BRIDGE_UNREACHABLE, `${what} could not be read; nothing was changed`);
  }
}

/** The row as the person sees it, with the burn or mint to sign when it is their turn. */
function toWire(row: BridgeTransferRecord, routes: BridgeRoute[], provider: BridgeProvider): BridgeTransfer {
  const route = routes.find((r) => r.from.chainId === row.fromChainId && r.to.chainId === row.toChainId && r.token === row.token);
  const token = provider.tokens[row.token];
  const burnCall =
    row.state === 'awaiting_burn' && token
      ? {
          chainId: row.fromChainId,
          to: getAddress(token.address),
          data: encodeFunctionData({
            abi: BRIDGE_TOKEN_ABI,
            functionName: 'burn',
            args: [row.intentId, BigInt(row.toChainId), row.wallet, row.amountUnits],
          }),
        }
      : null;
  const mintCall =
    row.state === 'mint_ready' && token && row.attestation
      ? {
          chainId: row.toChainId,
          to: getAddress(token.address),
          data: encodeFunctionData({
            abi: BRIDGE_TOKEN_ABI,
            functionName: 'mint',
            args: [row.intentId, BigInt(row.fromChainId), row.wallet, row.amountUnits, row.attestation],
          }),
        }
      : null;
  return {
    id: row.id,
    intentId: row.intentId,
    wallet: getAddress(row.wallet),
    from: { chainId: row.fromChainId, name: route?.from.name ?? `Chain ${row.fromChainId}` },
    to: { chainId: row.toChainId, name: route?.to.name ?? `Chain ${row.toChainId}` },
    token: row.token,
    amount: formatUnitsExact(row.amountUnits, token?.decimals ?? 0),
    provider: route?.provider ?? null,
    state: row.state,
    burnTx: row.burnTx,
    burnCall,
    mintCall,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Starts a transfer: the intent is stored first, then the burn to sign is answered. The same key answers the same row. */
export async function startTransfer(
  deps: BridgeTransfersDeps,
  input: { wallet: string; fromChainId: number; toChainId: number; asset: string; amount: string; clientKey: string },
): Promise<BridgeTransfer> {
  const routes = deps.routes();
  const provider = requireProvider(deps);
  routeOf(deps, { fromChainId: input.fromChainId, toChainId: input.toChainId, token: input.asset });
  const token = tokenOf(provider, input.asset);
  chainOf(provider, input.fromChainId);
  chainOf(provider, input.toChainId);
  const wallet = getAddress(input.wallet);
  const amountUnits = bridgeUnits(input.amount, token.decimals);
  const terms = (r: BridgeTransferRecord) =>
    r.fromChainId === input.fromChainId && r.toChainId === input.toChainId && r.token === input.asset && r.amountUnits === amountUnits;
  const prior = await deps.store.findByKey(wallet, input.clientKey);
  if (prior) {
    if (!terms(prior)) throw new BridgeTransferError(BRIDGE_KEY_CONFLICT, 'this key was used for a transfer with other terms');
    return toWire(prior, routes, provider);
  }
  if ((await deps.store.countWaiting(wallet)) >= MAX_WAITING_PER_WALLET)
    throw new BridgeTransferError(
      BRIDGE_TOO_MANY_WAITING,
      `this wallet has ${MAX_WAITING_PER_WALLET} transfers waiting for their burn; sign or leave one before starting another`,
    );
  const row = await deps.store.insert({
    wallet,
    key: input.clientKey,
    intentId: bridgeIntentId(wallet, input.clientKey),
    fromChainId: input.fromChainId,
    toChainId: input.toChainId,
    token: input.asset,
    amountUnits,
  });
  if (!terms(row)) throw new BridgeTransferError(BRIDGE_KEY_CONFLICT, 'this key was used for a transfer with other terms');
  return toWire(row, routes, provider);
}

/**
 * The wallet sent the burn: the transaction is read on the source chain and kept only when it is this wallet's burn of
 * this transfer's intent. A burn that later reverts sends the row back to waiting for its burn on the next read.
 */
export async function burnSubmitted(
  deps: BridgeTransfersDeps,
  input: { wallet: string; id: string; txHash: string },
): Promise<BridgeTransfer> {
  const routes = deps.routes();
  const provider = requireProvider(deps);
  const wallet = getAddress(input.wallet);
  const row = await deps.store.get(wallet, input.id);
  if (!row) throw new BridgeTransferError(BRIDGE_TRANSFER_NOT_FOUND, 'no transfer with this id belongs to this wallet');
  const hash = lowerHex(input.txHash);
  if (row.state !== 'awaiting_burn') {
    if (row.burnTx === hash) return toWire(row, routes, provider);
    throw new BridgeTransferError(BRIDGE_BURN_MISMATCH, 'this transfer already has its burn on chain; it is never burned twice');
  }
  const token = tokenOf(provider, row.token);
  const source = chainOf(provider, row.fromChainId);
  const tx = await reading(`chain ${row.fromChainId}`, () => source.transaction(hash));
  if (!tx || tx.to === null || getAddress(tx.to) !== getAddress(token.address) || getAddress(tx.from) !== wallet)
    throw new BridgeTransferError(BRIDGE_BURN_MISMATCH, "this transaction is not this wallet's burn of the bridge token");
  let call;
  try {
    call = decodeFunctionData({ abi: BRIDGE_TOKEN_ABI, data: tx.input });
  } catch {
    throw new BridgeTransferError(BRIDGE_BURN_MISMATCH, 'this transaction is not a burn');
  }
  if (call.functionName !== 'burn') throw new BridgeTransferError(BRIDGE_BURN_MISMATCH, 'this transaction is not a burn');
  const [intentId, destination, recipient, amount] = call.args;
  if (
    lowerHex(intentId) !== lowerHex(row.intentId) ||
    destination !== BigInt(row.toChainId) ||
    getAddress(recipient) !== wallet ||
    amount !== row.amountUnits
  )
    throw new BridgeTransferError(BRIDGE_BURN_MISMATCH, "this transaction does not burn this transfer's intent and amount");
  if (tx.status === 'reverted') throw new BridgeTransferError(BRIDGE_BURN_MISMATCH, 'this burn reverted on chain; nothing was burned');
  await deps.store.advance(row.id, 'awaiting_burn', { state: 'burn_submitted', burnTx: hash, attestation: null });
  const now = await deps.store.get(wallet, row.id);
  return toWire(now ?? row, routes, provider);
}

/** One row brought up to date from the chains and the provider; a read that fails leaves the row as it was. */
async function refresh(provider: BridgeProvider, store: BridgeTransferStore, row: BridgeTransferRecord): Promise<BridgeTransferRecord> {
  const token = provider.tokens[row.token];
  const source = provider.chain(row.fromChainId);
  const destination = provider.chain(row.toChainId);
  if (!token || !source || !destination) return row;
  const move = async (next: Pick<BridgeTransferRecord, 'state' | 'burnTx' | 'attestation'>) =>
    (await store.advance(row.id, row.state, next)) ? { ...row, ...next } : ((await store.get(row.wallet, row.id)) ?? row);
  try {
    if (row.state === 'awaiting_burn') {
      // The resume: a burn for this intent is on chain (the page or the process stopped after the wallet sent it).
      if (!(await source.burned(token.address, row.intentId))) return row;
      const burnTx = await source.burnTx(token.address, row.intentId);
      return burnTx ? move({ state: 'burn_submitted', burnTx, attestation: null }) : row;
    }
    if (row.state === 'minted') return row;
    if (await destination.minted(token.address, row.intentId))
      return move({ state: 'minted', burnTx: row.burnTx, attestation: row.attestation });
    if (row.state === 'mint_ready') return row;
    // burn_submitted: a burn that reverted, or that the chain dropped, goes back to waiting for its burn.
    const burnTx = row.burnTx;
    if (burnTx === null) return row;
    const tx = await source.transaction(burnTx);
    if (tx?.status === 'reverted' || (tx === null && !(await source.burned(token.address, row.intentId))))
      return move({ state: 'awaiting_burn', burnTx: null, attestation: null });
    if (tx?.status !== 'success') return row;
    const attested = await provider.attestation(row.fromChainId, burnTx);
    return attested.status === 'ready' ? move({ state: 'mint_ready', burnTx, attestation: attested.attestation }) : row;
  } catch {
    return row;
  }
}

/** A wallet's transfers, newest first, each brought up to date. */
export async function listTransfers(deps: BridgeTransfersDeps, input: { wallet: string }): Promise<{ transfers: BridgeTransfer[] }> {
  const routes = deps.routes();
  const provider = requireProvider(deps);
  const rows = await deps.store.list(getAddress(input.wallet));
  const fresh = await Promise.all(rows.map((row) => refresh(provider, deps.store, row)));
  return { transfers: fresh.map((row) => toWire(row, routes, provider)) };
}
