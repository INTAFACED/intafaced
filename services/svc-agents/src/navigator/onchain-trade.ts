import { createPublicClient, encodeFunctionData, getAddress, http, parseAbi, type Address, type Hex } from 'viem';
import { z } from 'zod';
import {
  NAVIGATOR_ONCHAIN_TEST_CHAIN_ID,
  navigatorAskMovesMoneyOut,
  type NavigatorOrder,
  type NavigatorTradeRefusal,
  type NavigatorTrading,
} from '@intafaced/contracts/agents-onchain';
import { NavigatorOnchainError, type NavigatorOnchainStore } from './onchain.js';

/**
 * The Navigator trading through the session key the person signed (J-agents-19 #4).
 *
 * One rule: inside the cap the person signed the Navigator does not ask; above it the trade is refused before anything
 * is signed; and it never moves money out. The cap is the key's own, read from the chain (`spendLimitWei`, in TEST ETH
 * on the test network), so the Navigator spends only the token the cap measures: wrapped TEST ETH, one for one. Every
 * order the Navigator has sent under that grant and that has not reverted or been refused holds part of the cap, with
 * whatever native value the chain says the key already moved.
 *
 * This service holds no key. It builds the one call a session key can make (`executeWithSession` on the person's smart
 * account, calling the router's `swapExactIn` with the account itself as the recipient) and hands it to the Navigator's
 * signer (`AGENTS_NAVIGATOR_ONCHAIN_SENDER_URL`). The account contract checks the scope, the expiry and the recipient
 * again, and refuses any transfer, approve or permit. No value moves through INTAFACED; nothing touches the ledger.
 */

const SWAP_EXACT_IN = parseAbi(['function swapExactIn(address pool, address tokenIn, uint256 amountIn, uint256 minAmountOut, address to)']);
const ROUTER_ABI = parseAbi(['function quoteExactIn(address pool, address tokenIn, uint256 amountIn) view returns (uint256)']);
const POOL_ABI = parseAbi(['function token0() view returns (address)', 'function token1() view returns (address)']);
const TOKEN_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
]);
const ACCOUNT_ABI = parseAbi([
  'function getSession(address sessionKey) view returns ((bytes32 specHash, uint48 validAfter, uint48 validUntil, uint128 spentWei, uint64 epoch, bool revoked))',
  'function isSessionLive(address sessionKey) view returns (bool)',
  'event SessionGranted(address indexed sessionKey, bytes32 specHash, uint48 validAfter, uint48 validUntil, uint128 spendLimitWei, address[] targets, bytes4[] selectors)',
  'function executeWithSession((address key, uint48 validAfter, uint48 validUntil, uint128 spendLimitWei, address[] targets, bytes4[] selectors) spec, address target, uint256 value, bytes data) returns (bytes)',
]);
/** The router's `swapExactIn(address,address,uint256,uint256,address)`. */
export const ROUTER_SWAP_EXACT_IN = '0x7b32b50e';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
/**
 * AGENTS_NAVIGATOR_ONCHAIN_MARKET: where the Navigator may trade. The router it calls, the pools it may use (each must
 * also be in the key's granted targets), the token it spends (the wrapped native token, which the cap measures one for
 * one) and the most the fill may fall short of the pool's quote, in basis points. Blank refuses
 * `agents.navigator_market_unset`.
 */
export const navigatorMarketSchema = z.object({
  router: address,
  spendToken: address,
  pools: z.array(address).min(1).max(16),
  slippageBps: z.number().int().min(1).max(5_000),
});
export type NavigatorMarket = z.infer<typeof navigatorMarketSchema>;

/** The key as the chain holds it: its live state and the granted spec, from the newest grant whose hash the chain holds. */
export interface LiveGrant {
  readonly live: boolean;
  readonly specHash: string;
  readonly validAfter: number;
  readonly validUntil: number;
  readonly spendLimitWei: bigint;
  readonly spentWei: bigint;
  readonly targets: readonly string[];
  readonly selectors: readonly string[];
}

export interface PoolTokens {
  readonly pool: string;
  readonly tokens: ReadonlyArray<{ address: string; symbol: string; name: string; decimals: number }>;
}

/** The reads the Navigator makes of the chain. */
export interface NavigatorChain {
  grant(account: string, sessionKey: string): Promise<LiveGrant | null>;
  pool(pool: string): Promise<PoolTokens>;
  quote(router: string, pool: string, tokenIn: string, amountIn: bigint): Promise<bigint>;
  /** The receipt's status, or null when it is not mined within the wait. */
  receipt(hash: string): Promise<'success' | 'reverted' | null>;
}

/** The Navigator's signer: takes the one session call, answers its transaction hash, or throws when it refuses it. */
export interface NavigatorSender {
  send(call: { chainId: number; from: string; to: string; data: string }): Promise<{ hash: string }>;
}

export function viemNavigatorChain(rpcUrl: string, receiptTimeoutMs = 30_000): NavigatorChain {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000 }) });
  return {
    async grant(account, sessionKey) {
      const a = getAddress(account);
      const key = getAddress(sessionKey);
      const record = await client.readContract({ address: a, abi: ACCOUNT_ABI, functionName: 'getSession', args: [key] });
      if (/^0x0+$/.test(record.specHash)) return null;
      const logs = await client.getContractEvents({
        address: a,
        abi: ACCOUNT_ABI,
        eventName: 'SessionGranted',
        args: { sessionKey: key },
        fromBlock: 0n,
      });
      const granted = [...logs].reverse().find((log) => log.args.specHash?.toLowerCase() === record.specHash.toLowerCase())?.args;
      if (!granted) return null;
      const live = await client.readContract({ address: a, abi: ACCOUNT_ABI, functionName: 'isSessionLive', args: [key] });
      return {
        live,
        specHash: record.specHash,
        validAfter: Number(granted.validAfter),
        validUntil: Number(granted.validUntil),
        spendLimitWei: granted.spendLimitWei ?? 0n,
        spentWei: record.spentWei,
        targets: (granted.targets ?? []).map((t) => t.toLowerCase()),
        selectors: (granted.selectors ?? []).map((s) => s.toLowerCase()),
      };
    },
    async pool(pool) {
      const p = getAddress(pool);
      const pair = await Promise.all([
        client.readContract({ address: p, abi: POOL_ABI, functionName: 'token0' }),
        client.readContract({ address: p, abi: POOL_ABI, functionName: 'token1' }),
      ]);
      const tokens = await Promise.all(
        pair.map(async (token) => {
          const [symbol, name, decimals] = await Promise.all([
            client.readContract({ address: token, abi: TOKEN_ABI, functionName: 'symbol' }),
            client.readContract({ address: token, abi: TOKEN_ABI, functionName: 'name' }),
            client.readContract({ address: token, abi: TOKEN_ABI, functionName: 'decimals' }),
          ]);
          return { address: token.toLowerCase(), symbol, name, decimals };
        }),
      );
      return { pool: pool.toLowerCase(), tokens };
    },
    async quote(router, pool, tokenIn, amountIn) {
      return client.readContract({
        address: getAddress(router),
        abi: ROUTER_ABI,
        functionName: 'quoteExactIn',
        args: [getAddress(pool), getAddress(tokenIn), amountIn],
      });
    },
    async receipt(hash) {
      try {
        const r = await client.waitForTransactionReceipt({ hash: hash as Hex, timeout: receiptTimeoutMs });
        return r.status;
      } catch {
        return null;
      }
    },
  };
}

/** The signer behind a URL: POST {chainId, from, to, data}, answered {hash} or refused with a status. */
export function httpNavigatorSender(url: string): NavigatorSender {
  return {
    async send(call) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(call),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => null)) as { hash?: unknown; error?: unknown } | null;
      if (!res.ok || typeof body?.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(body.hash))
        throw new Error(`navigator signer refused (${res.status}): ${typeof body?.error === 'string' ? body.error : 'no hash'}`);
      return { hash: body.hash };
    },
  };
}

/** An exact decimal amount in a token's smallest unit, or null. Never a `number`. */
export function toUnits(text: string, decimals: number): bigint | null {
  const m = /^(\d{1,30})(?:\.(\d{1,36}))?$/.exec(text);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > decimals) return null;
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/** "swap <amount> <token> for <token>" (also sell or trade, for or into), after an optional TEST: label. */
const ASK =
  /^\s*(?:TEST:\s*)?(?:please\s+)?(?:swap|sell|trade)\s+(\d+(?:\.\d+)?)\s+(.+?)\s+(?:for|into)\s+(.+?)(?:\s+on-chain)?\s*[.!]?\s*$/i;
export function parseTradeAsk(text: string): { amount: string; tokenIn: string; tokenOut: string } | null {
  const m = ASK.exec(text);
  return m ? { amount: m[1]!, tokenIn: m[2]!.trim(), tokenOut: m[3]!.trim() } : null;
}

const refuse = (code: NavigatorTradeRefusal | 'rail.crypto' | 'agents.request_id_replay', field?: string) =>
  new NavigatorOnchainError(code, field);

export interface NavigatorTradeDeps {
  readonly store: NavigatorOnchainStore;
  /** The Navigator's public signer address; null refuses `rail.crypto`. */
  readonly signer: string | null;
  readonly sender: NavigatorSender | null;
  readonly market: NavigatorMarket | null;
  readonly chain: NavigatorChain | null;
}

/** The person's live key: their newest binding not asked to be revoked, and the grant the chain holds for it, live. */
async function liveKey(deps: NavigatorTradeDeps, userId: string) {
  if (!deps.signer) throw refuse('rail.crypto');
  if (!deps.chain || !deps.market) throw refuse('agents.navigator_market_unset');
  const binding = await deps.store.liveBinding(userId, NAVIGATOR_ONCHAIN_TEST_CHAIN_ID, deps.signer);
  if (!binding) return null;
  const grant = await deps.chain.grant(binding.account, deps.signer);
  if (!grant || !grant.live) return null;
  return { binding, grant, chain: deps.chain, market: deps.market, signer: deps.signer };
}

/** The workspace's view of the key: the cap the person signed and what the Navigator's orders hold against it. */
export async function navigatorTrading(deps: NavigatorTradeDeps, userId: string): Promise<NavigatorTrading> {
  let key;
  try {
    key = await liveKey(deps, userId);
  } catch (err) {
    if (err instanceof NavigatorOnchainError) return { key: null };
    throw err;
  }
  if (!key) return { key: null };
  const held = await deps.store.heldWei(userId, NAVIGATOR_ONCHAIN_TEST_CHAIN_ID, key.binding.account, key.grant.specHash);
  const spent = held + key.grant.spentWei;
  const left = key.grant.spendLimitWei > spent ? key.grant.spendLimitWei - spent : 0n;
  return {
    key: {
      chainId: NAVIGATOR_ONCHAIN_TEST_CHAIN_ID,
      account: key.binding.account,
      capWei: key.grant.spendLimitWei.toString(),
      spentWei: spent.toString(),
      leftWei: left.toString(),
      validUntil: key.grant.validUntil,
    },
  };
}

const sameToken = (words: string, token: { symbol: string; name: string }) =>
  [token.symbol, token.name].some((label) => label.toLowerCase() === words.toLowerCase());

/**
 * One trade ask the person made of the Navigator. Refused by name, before anything is signed, when it moves money out,
 * when there is no live key, when it is not a trade the Navigator can place, or when it is above what is left of the cap.
 * Otherwise the order is recorded under its business key and sent once: a retried ask is the first order, unsent again.
 */
export async function navigatorTrade(
  deps: NavigatorTradeDeps,
  input: { userId: string; sessionId: string; requestId: string; text: string },
): Promise<NavigatorOrder> {
  if (navigatorAskMovesMoneyOut(input.text)) throw refuse('agents.navigator_money_out_forbidden');
  const orderKey = `agents:navigator:order:${input.sessionId}:${input.requestId}`;
  // The same request id is the same order, whatever the cap now says: it was sent once.
  const earlier = await deps.store.order(input.userId, orderKey);
  if (earlier) {
    if (earlier.text !== input.text) throw refuse('agents.request_id_replay');
    return earlier;
  }
  const key = await liveKey(deps, input.userId);
  if (!key) throw refuse('agents.navigator_no_live_key');
  const { binding, grant, chain, market, signer } = key;

  const ask = parseTradeAsk(input.text);
  if (!ask) throw refuse('agents.navigator_trade_unparsed');
  const router = market.router.toLowerCase();
  if (!grant.targets.includes(router) || !grant.selectors.includes(ROUTER_SWAP_EXACT_IN))
    throw refuse('agents.navigator_trade_out_of_scope');
  const pools = await Promise.all(market.pools.filter((p) => grant.targets.includes(p.toLowerCase())).map((p) => chain.pool(p)));
  const match = pools
    .map((p) => ({
      pool: p.pool,
      tokenIn: p.tokens.find((t) => sameToken(ask.tokenIn, t)),
      tokenOut: p.tokens.find((t) => sameToken(ask.tokenOut, t)),
    }))
    .find((m) => m.tokenIn && m.tokenOut && m.tokenIn.address !== m.tokenOut.address);
  if (!match?.tokenIn || !match.tokenOut) {
    // A pair the market has, but outside the granted targets, is out of scope; a pair it never has is not a trade it places.
    const known = market.pools.length > pools.length ? 'agents.navigator_trade_out_of_scope' : 'agents.navigator_trade_unparsed';
    throw refuse(known);
  }
  // The cap is in native currency, so the Navigator only spends the token that measures it one for one.
  if (match.tokenIn.address !== market.spendToken.toLowerCase()) throw refuse('agents.navigator_trade_cap_unit', 'tokenIn');
  const amountIn = toUnits(ask.amount, match.tokenIn.decimals);
  if (!amountIn || amountIn <= 0n) throw refuse('agents.navigator_trade_unparsed', 'amount');

  // Above what is left of the cap: refused here, before a quote is asked for or anything is built or signed.
  const heldBefore = await deps.store.heldWei(input.userId, NAVIGATOR_ONCHAIN_TEST_CHAIN_ID, binding.account, grant.specHash);
  if (heldBefore + grant.spentWei + amountIn > grant.spendLimitWei) throw refuse('agents.navigator_trade_over_cap', 'amount');

  const quoted = await chain.quote(router, match.pool, match.tokenIn.address, amountIn);
  const minOut = (quoted * BigInt(10_000 - market.slippageBps)) / 10_000n;
  if (minOut <= 0n) throw refuse('agents.navigator_trade_unquoted');

  // The cap is checked again under the grant's lock as the order is written, so two asks at once cannot both fit.
  const reserved = await deps.store.reserveOrder({
    userId: input.userId,
    sessionId: input.sessionId,
    orderKey,
    text: input.text,
    chainId: NAVIGATOR_ONCHAIN_TEST_CHAIN_ID,
    account: binding.account,
    sessionKey: signer,
    specHash: grant.specHash,
    pool: match.pool,
    tokenIn: match.tokenIn.address,
    tokenInSymbol: match.tokenIn.symbol,
    tokenOut: match.tokenOut.address,
    tokenOutSymbol: match.tokenOut.symbol,
    amountInWei: amountIn,
    minOutWei: minOut,
    capWei: grant.spendLimitWei,
    chainSpentWei: grant.spentWei,
  });
  if (reserved.kind === 'over_cap') throw refuse('agents.navigator_trade_over_cap', 'amount');
  if (reserved.kind === 'existing') {
    if (reserved.order.text !== input.text) throw refuse('agents.request_id_replay');
    return reserved.order;
  }

  const swap = encodeFunctionData({
    abi: SWAP_EXACT_IN,
    functionName: 'swapExactIn',
    args: [getAddress(match.pool), getAddress(match.tokenIn.address), amountIn, minOut, getAddress(binding.account)],
  });
  const data = encodeFunctionData({
    abi: ACCOUNT_ABI,
    functionName: 'executeWithSession',
    args: [
      {
        key: getAddress(signer),
        validAfter: grant.validAfter,
        validUntil: grant.validUntil,
        spendLimitWei: grant.spendLimitWei,
        targets: grant.targets.map((t) => getAddress(t)) as Address[],
        selectors: grant.selectors as Hex[],
      },
      getAddress(router),
      0n,
      swap,
    ],
  });
  if (!deps.sender) {
    await deps.store.settleOrder(input.userId, orderKey, 'failed', null);
    throw refuse('rail.crypto');
  }
  let hash: string;
  try {
    hash = (await deps.sender.send({ chainId: NAVIGATOR_ONCHAIN_TEST_CHAIN_ID, from: signer, to: binding.account, data })).hash;
  } catch {
    // The signer refused it: nothing reached the chain, so the order frees its part of the cap.
    return deps.store.settleOrder(input.userId, orderKey, 'failed', null);
  }
  await deps.store.settleOrder(input.userId, orderKey, 'sent', hash);
  const mined = await chain.receipt(hash);
  if (mined === null) return (await deps.store.order(input.userId, orderKey))!;
  return deps.store.settleOrder(input.userId, orderKey, mined === 'success' ? 'filled' : 'reverted', hash);
}
