import { describe, expect, it, vi } from 'vitest';
import { TestnetSigner } from './evm-signer.js';
import { pad, toHex, type Hex } from 'viem';
import { parseAmount } from '@intafaced/ledger-client';
import { MemoryBroadcastStore } from './broadcast-store.js';
import { ERC20_TRANSFER_TOPIC, parseEvmAssets } from './evm-assets.js';
import { EvmLiveChain } from './evm-chain.js';

/**
 * L320. No chain node: the public client is a stub.
 *
 * An empty first refresh must leave the 2000-block lookback in place. An
 * address registered during an awaited getBlock must be visible on a later
 * block of that same scan.
 */

const MNEMONIC = 'test test test test test test test test test test test junk';
const HOT_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const PAYER = '0x0000000000000000000000000000000000000001';
const LOOKBACK = 2_000n;

type NativeTx = {
  to: string;
  from: string;
  value: bigint;
  hash: Hex;
  transactionIndex: number;
};

function block(number: bigint, transactions: NativeTx[] = []) {
  return { number, transactions };
}

function scanCursorOf(chain: EvmLiveChain): bigint {
  return (chain as unknown as { scanCursor: bigint }).scanCursor;
}

function installRpc(
  chain: EvmLiveChain,
  rpc: {
    getBlockNumber: () => Promise<bigint>;
    getBlock: (args: { blockNumber: bigint }) => Promise<{ number: bigint; transactions: NativeTx[] }>;
    getLogs?: (args: { address?: string; fromBlock?: bigint; toBlock?: bigint }) => Promise<Erc20Log[]>;
    getTransactionReceipt?: (args: { hash: Hex }) => Promise<ReceiptStub | null>;
  },
): void {
  const client = {
    getLogs: async (): Promise<Erc20Log[]> => [],
    getTransactionReceipt: async ({ hash }: { hash: Hex }): Promise<ReceiptStub> => ({
      status: 'success',
      transactionHash: hash,
      logs: [],
    }),
    ...rpc,
  };
  (chain as unknown as { public: typeof client }).public = client;
}

type Erc20Log = {
  address: string;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
  topics: readonly [Hex, Hex, Hex];
  data: Hex;
};

type ReceiptStub = {
  status: 'success' | 'reverted';
  transactionHash: Hex;
  blockNumber?: bigint;
  to?: string | null;
  logs: readonly Erc20Log[];
};

function addressTopic(address: string): Hex {
  return pad(address.toLowerCase() as Hex, { size: 32 });
}

function chainWith(): EvmLiveChain {
  return new EvmLiveChain({
    rpcUrl: 'http://127.0.0.1:9',
    chainId: 31337,
    depositMnemonic: MNEMONIC,
    signer: TestnetSigner.fromFixtureKey(HOT_KEY),
    assets: parseEvmAssets('ETH:native'),
    broadcasts: new MemoryBroadcastStore(),
    minConfirmations: 1,
  });
}

describe('EvmLiveChain deposit scan cursor', () => {
  it('leaves the lookback cursor when the first refresh has no addresses, and sees an address added during the scan', async () => {
    const emptyChain = chainWith();
    const tip = 2_500n;
    const lookbackCursor = tip - LOOKBACK;
    const earlyHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex;
    const earlyValue = parseAmount('0.05');
    const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => block(blockNumber));
    installRpc(emptyChain, {
      getBlockNumber: async () => tip,
      getBlock,
    });

    await emptyChain.refresh();

    expect(getBlock).not.toHaveBeenCalled();
    expect(scanCursorOf(emptyChain)).toBe(lookbackCursor);

    const lateAddress = await emptyChain.acceptanceAddress('pay-registered-after-restart', 'ETH');
    getBlock.mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => {
      if (blockNumber !== lookbackCursor) return block(blockNumber);
      return block(blockNumber, [
        {
          to: lateAddress,
          from: PAYER,
          value: earlyValue,
          hash: earlyHash,
          transactionIndex: 0,
        },
      ]);
    });

    const early = await emptyChain.inboundTransfer(lateAddress);
    expect(getBlock.mock.calls[0]?.[0]).toMatchObject({ blockNumber: lookbackCursor });
    expect(early).toMatchObject({ txHash: earlyHash, assetId: 'ETH', amount: earlyValue });
    expect(typeof early?.amount).toBe('bigint');

    const midChain = chainWith();
    const midTip = 4n;
    const midHash = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex;
    const midValue = parseAmount('0.2');
    let added = '';
    const addedAt = 0n;
    const depositAt = 3n;
    installRpc(midChain, {
      getBlockNumber: async () => midTip,
      getBlock: async ({ blockNumber }) => {
        if (blockNumber === addedAt) {
          added = await midChain.acceptanceAddress('pay-added-during-scan', 'ETH');
          return block(blockNumber);
        }
        if (blockNumber === depositAt) {
          return block(blockNumber, [
            {
              to: added,
              from: PAYER,
              value: midValue,
              hash: midHash,
              transactionIndex: 2,
            },
          ]);
        }
        return block(blockNumber);
      },
    });

    await midChain.acceptanceAddress('pay-already-watched', 'ETH');
    await midChain.refresh();

    expect(added).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(depositAt > addedAt).toBe(true);
    const mid = await midChain.inboundTransfer(added);
    expect(mid).toMatchObject({ txHash: midHash, assetId: 'ETH', amount: midValue });
    expect(typeof mid?.amount).toBe('bigint');
  });
});

describe('EvmLiveChain inbound identity', () => {
  it.each(['contract', 'sender'] as const)(
    'does not finalize an original token deposit using a receipt with a foreign %s',
    async (changed) => {
      const token = '0x00000000000000000000000000000000000000a1';
      const port = new EvmLiveChain({
        rpcUrl: 'http://127.0.0.1:9',
        chainId: 31337,
        depositMnemonic: MNEMONIC,
        signer: TestnetSigner.fromFixtureKey(HOT_KEY),
        assets: parseEvmAssets(`USDC:${token}:6`),
        broadcasts: new MemoryBroadcastStore(),
        minConfirmations: 1,
      });
      const address = await port.acceptanceAddress('receipt-identity', 'USDC');
      const txHash = `0x${'a'.repeat(64)}` as Hex;
      const original = erc20Log({ token, to: address, value: 1_000_000n, txHash, logIndex: 3, blockNumber: 5n });
      let receiptLog = original;
      let tip = 5n;
      installRpc(port, {
        getBlockNumber: async () => tip,
        getBlock: async ({ blockNumber }) => block(blockNumber),
        getLogs: async ({ fromBlock }) => (fromBlock !== undefined && fromBlock <= 5n ? [original] : []),
        getTransactionReceipt: async () => ({ status: 'success', transactionHash: txHash, blockNumber: 5n, logs: [receiptLog] }),
      });
      await port.refresh();
      expect(port.drainFinalized()[0]?.transfer).toMatchObject({ txHash, from: PAYER, assetId: 'USDC', amount: parseAmount('1') });
      receiptLog =
        changed === 'contract'
          ? { ...original, address: '0x00000000000000000000000000000000000000b1' }
          : { ...original, topics: [original.topics[0], addressTopic('0x0000000000000000000000000000000000000002'), original.topics[2]] };
      tip++;
      await port.refresh();
      expect(port.drainFinalized()).toEqual([]);
      expect(listObserved(port)).toHaveLength(1);
      expect(listObserved(port)[0]).toMatchObject({ txHash, from: PAYER, assetId: 'USDC', amount: parseAmount('1'), inReceipt: false });
      receiptLog = original;
      tip++;
      await port.refresh();
      expect(port.drainFinalized()).toHaveLength(1);
      expect(port.drainFinalized()[0]?.transfer).toMatchObject({ txHash, from: PAYER, assetId: 'USDC', amount: parseAmount('1') });
      port.markFinalizedEmitted(address);
      await port.refresh();
      expect(port.drainFinalized()).toEqual([]);
    },
  );

  it('keeps every log and does not drain a transfer whose receipt is gone after it would have aged in', async () => {
    const token = '0x00000000000000000000000000000000000000a1';
    const port = new EvmLiveChain({
      rpcUrl: 'http://127.0.0.1:9',
      chainId: 31337,
      depositMnemonic: MNEMONIC,
      signer: TestnetSigner.fromFixtureKey(HOT_KEY),
      assets: parseEvmAssets(`USDC:${token}:18`),
      broadcasts: new MemoryBroadcastStore(),
      minConfirmations: 2,
    });
    const deposit = await port.acceptanceAddress('pay-l321', 'USDC');
    const landedBlock = 10n;
    const firstTip = 10n;
    const agedTip = 12n;
    const amountA = parseAmount('1.5');
    const amountB = parseAmount('2.25');
    const amountC = parseAmount('0.4');
    const amountD = parseAmount('9');
    const txSame = '0x1111111111111111111111111111111111111111111111111111111111111111' as Hex;
    const txOther = '0x2222222222222222222222222222222222222222222222222222222222222222' as Hex;
    const txDropped = '0x3333333333333333333333333333333333333333333333333333333333333333' as Hex;
    const wouldBeConfirmations = Number(agedTip - landedBlock + 1n);
    expect(wouldBeConfirmations).toBeGreaterThanOrEqual(2);

    const logs: Erc20Log[] = [
      erc20Log({ token, to: deposit, value: amountA, txHash: txSame, logIndex: 1, blockNumber: landedBlock }),
      erc20Log({ token, to: deposit, value: amountB, txHash: txSame, logIndex: 2, blockNumber: landedBlock }),
      erc20Log({ token, to: deposit, value: amountC, txHash: txOther, logIndex: 5, blockNumber: landedBlock }),
      erc20Log({ token, to: deposit, value: amountD, txHash: txDropped, logIndex: 8, blockNumber: landedBlock }),
    ];
    const available = new Set<Hex>([txSame, txOther, txDropped]);
    let tip = firstTip;
    const getTransactionReceipt = vi.fn(async ({ hash }: { hash: Hex }): Promise<ReceiptStub | null> => {
      if (!available.has(hash)) return null;
      return {
        status: 'success',
        transactionHash: hash,
        blockNumber: landedBlock,
        logs: logs.filter((log) => log.transactionHash === hash),
      };
    });
    installRpc(port, {
      getBlockNumber: async () => tip,
      getBlock: async ({ blockNumber }) => block(blockNumber),
      getLogs: async () => logs,
      getTransactionReceipt,
    });

    await port.refresh();

    const kept = listObserved(port);
    expect(kept).toHaveLength(4);
    for (const row of kept) expect(typeof row.amount).toBe('bigint');
    const sameTx = kept.filter((row) => row.txHash === txSame);
    expect(sameTx.map((row) => row.logIndex).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(sameTx.map((row) => row.amount)).toEqual(expect.arrayContaining([amountA, amountB]));
    expect(sameTx.some((row) => row.amount === amountA + amountB)).toBe(false);
    expect(kept.some((row) => row.txHash === txOther && row.amount === amountC)).toBe(true);
    expect(port.drainFinalized()).toEqual([]);

    available.delete(txDropped);
    tip = agedTip;
    await port.refresh();

    const drained = port.drainFinalized();
    expect(getTransactionReceipt.mock.calls.some((call) => call[0]?.hash === txDropped)).toBe(true);
    expect(drained.map((item) => item.transfer.txHash)).not.toContain(txDropped);
    expect(drained.map((item) => item.transfer.amount)).not.toContain(amountD);
    expect(drained).toHaveLength(3);
    const drainedSame = drained.filter((item) => item.transfer.txHash === txSame);
    expect(drainedSame).toHaveLength(2);
    expect(drainedSame.map((item) => item.transfer.amount)).toEqual(expect.arrayContaining([amountA, amountB]));
    expect(drained.some((item) => item.transfer.txHash === txOther && item.transfer.amount === amountC)).toBe(true);
    for (const item of drained) {
      expect(typeof item.transfer.amount).toBe('bigint');
      expect(item.transfer.confirmations).toBeGreaterThanOrEqual(2);
    }

    port.markFinalizedEmitted(deposit);
    const still = port.drainFinalized();
    expect(still).toHaveLength(2);
    expect(still.map((item) => item.transfer.amount)).toEqual(expect.arrayContaining([amountB, amountC]));
    expect(still.map((item) => item.transfer.amount)).not.toContain(amountA);
    expect(still.map((item) => item.transfer.txHash)).not.toContain(txDropped);
  });
});

describe('EvmLiveChain ERC-20 scan cursor', () => {
  it.each([
    ['native block', 5n],
    ['native block', 6n],
    ['later token', 5n],
    ['later token', 6n],
  ] as const)(
    'retries the original range after %s failure at retry tip %s without duplicating partial observations',
    async (failure, retryTip) => {
      const tokenA = '0x00000000000000000000000000000000000000a1';
      const tokenB = '0x00000000000000000000000000000000000000b1';
      const port = new EvmLiveChain({
        rpcUrl: 'http://127.0.0.1:9',
        chainId: 31337,
        depositMnemonic: MNEMONIC,
        signer: TestnetSigner.fromFixtureKey(HOT_KEY),
        assets: parseEvmAssets(`ETH:native,USDC:${tokenA}:6,USDT:${tokenB}:6`),
        broadcasts: new MemoryBroadcastStore(),
        minConfirmations: 1,
      });
      const nativeAddress = await port.acceptanceAddress('retry-native', 'ETH');
      const addressA = await port.acceptanceAddress('retry-token-a', 'USDC');
      const addressB = await port.acceptanceAddress('retry-token-b', 'USDT');
      const nativeHash = `0x${'1'.repeat(64)}` as Hex;
      const hashA = `0x${'2'.repeat(64)}` as Hex;
      const hashB = `0x${'3'.repeat(64)}` as Hex;
      const nativeAmount = parseAmount('0.25');
      const logA = erc20Log({ token: tokenA, to: addressA, value: 1_000_000n, txHash: hashA, logIndex: 2, blockNumber: 3n });
      const logB = erc20Log({ token: tokenB, to: addressB, value: 2_000_000n, txHash: hashB, logIndex: 4, blockNumber: 5n });
      let tip = 5n;
      let failed = false;
      let receiptBAvailable = false;
      const blocks: bigint[] = [];
      const ranges: Array<{ address?: string; fromBlock?: bigint; toBlock?: bigint }> = [];
      installRpc(port, {
        getBlockNumber: async () => tip,
        getBlock: async ({ blockNumber }) => {
          blocks.push(blockNumber);
          if (failure === 'native block' && blockNumber === 4n && !failed) {
            failed = true;
            throw new Error('transient native block failure');
          }
          return block(
            blockNumber,
            blockNumber === 2n ? [{ to: nativeAddress, from: PAYER, value: nativeAmount, hash: nativeHash, transactionIndex: 1 }] : [],
          );
        },
        getLogs: async (args) => {
          ranges.push(args);
          if (failure === 'later token' && args.address?.toLowerCase() === tokenB && !failed) {
            failed = true;
            throw new Error('transient later token failure');
          }
          const log = args.address?.toLowerCase() === tokenA ? logA : logB;
          return log.blockNumber >= (args.fromBlock ?? 0n) && log.blockNumber <= (args.toBlock ?? tip) ? [log] : [];
        },
        getTransactionReceipt: async ({ hash }) => {
          if (hash === hashB && !receiptBAvailable) return null;
          return {
            status: 'success',
            transactionHash: hash,
            blockNumber: hash === nativeHash ? 2n : hash === hashA ? 3n : 5n,
            to: hash === nativeHash ? nativeAddress : null,
            logs: hash === hashA ? [logA] : hash === hashB ? [logB] : [],
          };
        },
      });
      await expect(port.refresh()).rejects.toThrow(`transient ${failure} failure`);
      const partial = listObserved(port).map(({ txHash, amount, logIndex }) => ({ txHash, amount, logIndex }));
      expect(partial).toHaveLength(failure === 'native block' ? 1 : 2);
      expect(partial).toContainEqual(expect.objectContaining({ txHash: nativeHash, amount: nativeAmount, logIndex: 1 }));
      expect(scanCursorOf(port)).toBe(0n);
      expect(port.drainFinalized()).toEqual([]);
      const priorBlockCalls = blocks.length;
      tip = retryTip;
      await port.refresh();
      expect(blocks[priorBlockCalls]).toBe(0n);
      expect(ranges.slice(-2).map((range) => ({ ...range, address: range.address?.toLowerCase() }))).toEqual([
        expect.objectContaining({ address: tokenA, fromBlock: 0n, toBlock: retryTip }),
        expect.objectContaining({ address: tokenB, fromBlock: 0n, toBlock: retryTip }),
      ]);
      expect(scanCursorOf(port)).toBe(retryTip + 1n);
      expect(listObserved(port)).toHaveLength(3);
      for (const row of partial) expect(listObserved(port)).toContainEqual(expect.objectContaining(row));
      expect(port.drainFinalized().map((item) => item.transfer.txHash)).toEqual([nativeHash, hashA]);
      expect(port.drainFinalized().map((item) => item.transfer.amount)).toEqual([nativeAmount, parseAmount('1')]);
      port.markFinalizedEmitted(nativeAddress);
      port.markFinalizedEmitted(addressA);
      await port.refresh();
      expect(port.drainFinalized()).toEqual([]);
      receiptBAvailable = true;
      tip++;
      await port.refresh();
      expect(port.drainFinalized()).toHaveLength(1);
      expect(port.drainFinalized()[0]?.transfer).toMatchObject({ txHash: hashB, amount: parseAmount('2') });
      port.markFinalizedEmitted(addressB);
      await port.refresh();
      expect(listObserved(port)).toHaveLength(3);
      expect(port.drainFinalized()).toEqual([]);
    },
  );

  it('records a Transfer older than the short confirmation window when it is inside the lookback', async () => {
    const token = '0x00000000000000000000000000000000000000a1';
    const minConfirmations = 2;
    const shortWindow = BigInt(Math.max(minConfirmations * 4, 64));
    const port = new EvmLiveChain({
      rpcUrl: 'http://127.0.0.1:9',
      chainId: 31337,
      depositMnemonic: MNEMONIC,
      signer: TestnetSigner.fromFixtureKey(HOT_KEY),
      assets: parseEvmAssets(`USDC:${token}:18`),
      broadcasts: new MemoryBroadcastStore(),
      minConfirmations,
    });
    const deposit = await port.acceptanceAddress('pay-l322', 'USDC');
    const tip = 2_500n;
    const lookbackCursor = tip - LOOKBACK;
    const landedBlock = lookbackCursor + 100n;
    expect(tip - landedBlock).toBeGreaterThan(shortWindow);
    expect(landedBlock).toBeGreaterThanOrEqual(lookbackCursor);

    const amount = parseAmount('3.5');
    const txHash = '0x4444444444444444444444444444444444444444444444444444444444444444' as Hex;
    const log = erc20Log({ token, to: deposit, value: amount, txHash, logIndex: 4, blockNumber: landedBlock });
    const getLogs = vi.fn(async (args: { fromBlock?: bigint; toBlock?: bigint }) => {
      const fromBlock = args.fromBlock ?? 0n;
      const toBlock = args.toBlock ?? tip;
      if (log.blockNumber < fromBlock || log.blockNumber > toBlock) return [];
      return [log];
    });
    installRpc(port, {
      getBlockNumber: async () => tip,
      getBlock: async ({ blockNumber }) => block(blockNumber),
      getLogs,
      getTransactionReceipt: async ({ hash }) => ({
        status: 'success',
        transactionHash: hash,
        blockNumber: landedBlock,
        logs: [log],
      }),
    });

    await port.refresh();

    expect(getLogs).toHaveBeenCalledTimes(1);
    expect(getLogs.mock.calls[0]?.[0]).toMatchObject({ fromBlock: lookbackCursor, toBlock: tip });
    expect(scanCursorOf(port)).toBe(tip + 1n);
    const kept = listObserved(port);
    expect(kept).toEqual([expect.objectContaining({ txHash, amount, logIndex: 4 })]);
    expect(typeof kept[0]?.amount).toBe('bigint');
  });
});

function erc20Log(input: { token: string; to: string; value: bigint; txHash: Hex; logIndex: number; blockNumber: bigint }): Erc20Log {
  return {
    address: input.token,
    blockNumber: input.blockNumber,
    transactionHash: input.txHash,
    logIndex: input.logIndex,
    topics: [ERC20_TRANSFER_TOPIC, addressTopic(PAYER), addressTopic(input.to)],
    data: toHex(input.value, { size: 32 }),
  };
}

function listObserved(chain: EvmLiveChain): Array<{ txHash: string; amount: bigint; logIndex: number }> {
  const observed = (chain as unknown as { observed: Map<string, { txHash: string; amount: bigint; logIndex: number }> }).observed;
  return [...observed.values()];
}

/** Reads `description` only. No JSON-RPC method is called. */
function described(rpcUrl: string): string {
  return new EvmLiveChain({
    rpcUrl,
    chainId: 31337,
    depositMnemonic: MNEMONIC,
    signer: TestnetSigner.fromFixtureKey(HOT_KEY),
    assets: parseEvmAssets('ETH:native'),
    broadcasts: new MemoryBroadcastStore(),
    minConfirmations: 1,
  }).description;
}

describe('EvmLiveChain description', () => {
  it('keeps the host and drops a path key, a single-segment key, and a query secret', () => {
    const multi = described('https://example/v2/SECRET');
    expect(multi).toContain('rpc=https://example/***');
    expect(multi).not.toContain('SECRET');

    const single = described('https://example/SECRET');
    expect(single).toContain('rpc=https://example/***');
    expect(single).not.toContain('SECRET');

    const query = described('https://example?apikey=SECRET');
    expect(query).toContain('rpc=https://example/');
    expect(query).not.toContain('SECRET');
    expect(query).not.toContain('apikey');
  });

  it('still blanks userinfo when the path and query also hold a key', () => {
    const published = described('https://rpc-user:placeholder-pass@example/v2/SECRET?apikey=SECRET');
    expect(published).toContain('rpc=https://***:***@example/***');
    expect(published).not.toContain('rpc-user');
    expect(published).not.toContain('placeholder-pass');
    expect(published).not.toContain('SECRET');
    expect(published).not.toContain('apikey');
  });
});
