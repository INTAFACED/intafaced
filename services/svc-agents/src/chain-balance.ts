/**
 * A wallet's balance of the payment token, as the chain reports it (J-agents-02 #4). One JSON-RPC node, read-only:
 * `eth_chainId` (the node must be the configured chain), `eth_getBlockByNumber('latest')` for the block and its time,
 * then `balanceOf(wallet)` and the token's own `symbol()` by `eth_call` at that same block, so the figure, the name it
 * is shown under and its as-of time describe one moment.
 * The balance is scaled from the token's decimals to the fee asset's Amount scale, rounding down, so a figure is never
 * shown as more than the chain holds. Nothing is signed or sent. A node that cannot be reached, answers for another
 * chain or gives an answer that cannot be read throws `FundsUnreadError`; nothing invents a balance.
 */
import { createPublicClient, erc20Abi, http, type PublicClient } from 'viem';
import { DECIMALS } from '@intafaced/ledger-client';
import { FundsUnreadError, type FundsReading } from './funds.js';

export interface PaymentTokenConfig {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly tokenAddress: `0x${string}`;
  readonly tokenDecimals: number;
}

export type WalletBalanceReading = Extract<FundsReading, { kind: 'wallet' }>;

export interface ChainBalancePort {
  read(address: string): Promise<WalletBalanceReading>;
}

const RPC_TIMEOUT_MS = 3_000;

/** Token units → the ledger's Amount scale (18 places), rounding down. */
export function toAmountScale(units: bigint, decimals: number): bigint {
  if (decimals === DECIMALS) return units;
  if (decimals < DECIMALS) return units * 10n ** BigInt(DECIMALS - decimals);
  return units / 10n ** BigInt(decimals - DECIMALS);
}

export function createChainBalance(
  config: PaymentTokenConfig,
  client?: Pick<PublicClient, 'getChainId' | 'getBlock' | 'readContract'>,
): ChainBalancePort {
  const rpc = client ?? createPublicClient({ transport: http(config.rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: 0 }) });
  return {
    async read(address) {
      const method = { kind: 'wallet', address: address.toLowerCase() } as const;
      let chainId: number;
      let block: { number: bigint | null; timestamp: bigint };
      let units: bigint;
      let token: string;
      let decimals: number;
      try {
        chainId = await rpc.getChainId();
      } catch {
        throw new FundsUnreadError(method, 'chain_unreachable');
      }
      if (chainId !== config.chainId) throw new FundsUnreadError(method, 'chain_mismatch');
      try {
        block = await rpc.getBlock({ blockTag: 'latest' });
        if (block.number === null) throw new Error('pending block');
        units = await rpc.readContract({
          address: config.tokenAddress,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [method.address as `0x${string}`],
          blockNumber: block.number,
        });
        decimals = await rpc.readContract({
          address: config.tokenAddress,
          abi: erc20Abi,
          functionName: 'decimals',
          blockNumber: block.number,
        });
        token = await rpc.readContract({ address: config.tokenAddress, abi: erc20Abi, functionName: 'symbol', blockNumber: block.number });
      } catch {
        throw new FundsUnreadError(method, 'chain_unreachable');
      }
      if (typeof units !== 'bigint' || units < 0n) throw new FundsUnreadError(method, 'chain_unreachable');
      // The token's own decimals, at the same block: a setting that disagrees with the chain would scale every figure
      // wrong and look right, so it refuses instead.
      if (Number(decimals) !== config.tokenDecimals) throw new FundsUnreadError(method, 'chain_mismatch');
      // A name the page can show as it is: letters, digits and a few marks, never markup or a blank.
      if (typeof token !== 'string' || !/^[A-Za-z0-9.$_-]{1,16}$/.test(token)) throw new FundsUnreadError(method, 'chain_unreachable');
      return {
        kind: 'wallet',
        available: toAmountScale(units, config.tokenDecimals),
        token,
        method,
        source: { kind: 'chain', chainId, block: block.number },
        asOf: new Date(Number(block.timestamp) * 1000).toISOString(),
      };
    },
  };
}
