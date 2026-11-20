/**
 * A first deposit from the person's own embedded wallet to the venue's bridge (J-wallet-24). Pure parts, with no React:
 * the wallet's chain reads, the fee estimate, the checks made before anything is signed, and the transaction itself.
 *
 * Every figure is read: the chain and asset the bridge takes, its minimum and its warning are the venue's; the balances
 * and the network fee are the chain's, read through the wallet provider's own connection, each with the block's time.
 * A figure that cannot be read is "not known", never 0. INTAFACED moves nothing and the ledger posts nothing: the deposit
 * is the person's own signed transfer, sent once, and no gas is paid for them while the owner's gas-sponsor setting is
 * blank (`wallet.gas_sponsor_unset`).
 */
import type { VenueAssetRoute, VenueDepositRoute } from '../venue-wallet/venue-account-api';
import { toTokenUnits } from '../venue-wallet/venue-account-api';
import { exactUnits, nativeCurrency, transferCalldata } from '../wallet/transfer';
import type { ChainReadMethod, WalletTransaction } from './provider-client';

export type ChainRead = (method: ChainReadMethod, params: unknown[]) => Promise<unknown>;

const word = (answer: unknown): bigint | null =>
  typeof answer === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(answer) ? BigInt(answer) : null;

/** `balanceOf(owner)` calldata: the ERC-20 selector, then the address left-padded to one word. */
const balanceOfData = (owner: string) => `0x70a08231${owner.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;

/** The chain's own gas token, or a name for it when the app does not list the chain. */
export function gasToken(chainId: number): { symbol: string; decimals: number } {
  return nativeCurrency(chainId) ?? { symbol: `chain ${chainId} gas`, decimals: 18 };
}

/** A figure read from the chain: exact base units and its decimal form, or not known. */
export type Read = { known: true; units: bigint; amount: string } | { known: false };

/** The wallet's balances of the bridge's token and of the chain's gas token, both at one block, with the block's time. */
export interface WalletFunds {
  asOf: string | null;
  block: string | null;
  token: Read;
  gas: Read;
}

const known = (units: bigint | null, decimals: number): Read =>
  units === null ? { known: false } : { known: true, units, amount: exactUnits(units, decimals) };

/** Reads both balances at the newest block. A balance whose read fails is not known, never 0. */
export async function readWalletFunds(read: ChainRead, route: VenueDepositRoute, owner: string): Promise<WalletFunds> {
  const block = (await read('eth_getBlockByNumber', ['latest', false]).catch(() => null)) as {
    number?: unknown;
    timestamp?: unknown;
  } | null;
  const number = word(block?.number ?? null);
  const time = word(block?.timestamp ?? null);
  if (number === null || time === null) return { asOf: null, block: null, token: { known: false }, gas: { known: false } };
  const at = `0x${number.toString(16)}`;
  const [token, gas] = await Promise.all([
    read('eth_call', [{ to: route.token, data: balanceOfData(owner) }, at]).then(word, () => null),
    read('eth_getBalance', [owner, at]).then(word, () => null),
  ]);
  return {
    asOf: new Date(Number(time) * 1000).toISOString(),
    block: number.toString(),
    token: known(token, route.tokenDecimals),
    gas: known(gas, gasToken(route.chainId).decimals),
  };
}

/** The transfer to the venue's bridge, as the chain is asked to run it: the token contract, called with `transfer`. */
function depositCall(route: VenueDepositRoute, owner: string, units: bigint) {
  return { from: owner, to: route.token, data: transferCalldata(route.address, units), value: '0x0' };
}

/**
 * The chain's estimate of the network fee for the transfer, in the gas token: its gas estimate times its gas price.
 * Not known when either read fails; never a guess.
 */
export async function estimateNetworkFee(read: ChainRead, route: VenueDepositRoute, owner: string, units: bigint): Promise<Read> {
  const [gas, price] = await Promise.all([
    read('eth_estimateGas', [depositCall(route, owner, units)]).then(word, () => null),
    read('eth_gasPrice', []).then(word, () => null),
  ]);
  if (gas === null || price === null) return { known: false };
  return known(gas * price, gasToken(route.chainId).decimals);
}

/** What stops a deposit before anything is signed, in the order the person meets them. */
export type DepositStop =
  | { kind: 'amount' }
  | { kind: 'below_minimum'; minimum: string }
  | { kind: 'balance_unknown' }
  | { kind: 'not_enough'; balance: string }
  | { kind: 'no_gas'; fee: Read }
  | { kind: 'gas_short'; fee: Read; balance: string };

/**
 * Checks a deposit of `amount` before anything is signed: a whole amount in the token's decimals; at least the venue's
 * minimum, where it publishes one (a transfer below it is never credited); no more than the wallet holds; and gas to
 * send it. With none of the chain's gas token the person is stopped and told the fee and how to add it, since no
 * sponsored deposit is offered while the owner's gas-sponsor setting is blank.
 */
export function checkDeposit(input: {
  amount: string;
  route: VenueDepositRoute;
  funds: WalletFunds;
  fee: Read;
}): { ok: true; units: bigint } | { ok: false; stop: DepositStop } {
  const units = toTokenUnits(input.amount, input.route.tokenDecimals);
  if (units === null || units <= 0n) return { ok: false, stop: { kind: 'amount' } };
  const minimum = input.route.minimum ?? null;
  if (minimum !== null) {
    const floor = toTokenUnits(minimum, input.route.tokenDecimals);
    if (floor !== null && units < floor) return { ok: false, stop: { kind: 'below_minimum', minimum } };
  }
  if (!input.funds.token.known || !input.funds.gas.known) return { ok: false, stop: { kind: 'balance_unknown' } };
  if (units > input.funds.token.units) return { ok: false, stop: { kind: 'not_enough', balance: input.funds.token.amount } };
  if (input.funds.gas.units === 0n) return { ok: false, stop: { kind: 'no_gas', fee: input.fee } };
  if (input.fee.known && input.fee.units > input.funds.gas.units)
    return { ok: false, stop: { kind: 'gas_short', fee: input.fee, balance: input.funds.gas.amount } };
  return { ok: true, units };
}

/** The signed transfer to the venue's bridge, at the wallet's nonce: the provider sends one transaction per nonce. */
export function depositTransaction(route: VenueDepositRoute, owner: string, units: bigint, nonce: number): WalletTransaction {
  const call = depositCall(route, owner, units);
  return { chainId: route.chainId, to: call.to, data: call.data, value: call.value, nonce };
}

/** The wallet's next nonce, counting transactions it already sent that are not mined yet. Null when not read. */
export async function readNonce(read: ChainRead, owner: string): Promise<number | null> {
  const n = word(await read('eth_getTransactionCount', [owner, 'pending']).catch(() => null));
  return n === null || n > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(n);
}

/** The network fee the chain charged for a mined transaction (gas used times its effective price), or null until mined. */
export async function paidNetworkFee(
  read: ChainRead,
  hash: string,
  chainId: number,
): Promise<{ status: 'mined' | 'reverted'; fee: Read } | null> {
  const receipt = (await read('eth_getTransactionReceipt', [hash]).catch(() => null)) as {
    status?: unknown;
    gasUsed?: unknown;
    effectiveGasPrice?: unknown;
  } | null;
  if (!receipt) return null;
  const used = word(receipt.gasUsed ?? null);
  const price = word(receipt.effectiveGasPrice ?? null);
  const fee = used === null || price === null ? ({ known: false } as const) : known(used * price, gasToken(chainId).decimals);
  return { status: receipt.status === '0x1' ? 'mined' : 'reverted', fee };
}

/** How the venue takes `asset`: by its bridge on this chain, by another route it publishes, or not at all. */
export type AssetWay = { kind: 'bridge' } | { kind: 'other_route'; network: string; how: string | null } | { kind: 'not_offered' };

export function assetWay(asset: string, route: VenueDepositRoute, routes: readonly VenueAssetRoute[]): AssetWay {
  if (asset === route.asset) return { kind: 'bridge' };
  const published = routes.find((r) => r.asset === asset);
  if (published?.network) return { kind: 'other_route', network: published.network, how: published.how };
  return { kind: 'not_offered' };
}
