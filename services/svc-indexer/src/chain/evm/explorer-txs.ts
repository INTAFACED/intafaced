import type { Hex, PublicClient } from 'viem';
import { ChainUnavailableError, classifyChainError } from './availability.js';
import type { ChainTx, ChainTxLog } from '../source.js';
import { isTraceUnsupported, revertReasonFromData, TRACE_UNAVAILABLE_REASON, traceOutput } from './revert-reason.js';
import type { LiveTx } from '../../explorer/tx.js';

/**
 * D-explorer-02 reads. Receipts and bodies come from the node that mined the
 * block. A listed hash the node will not return fails the whole block: a
 * partial transaction list is not stored.
 */

function isNotFound(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  return name === 'TransactionNotFoundError' || name === 'TransactionReceiptNotFoundError';
}

export function transactionHashes(transactions: readonly unknown[], blockHash: string, rpcUrl: string): Hex[] {
  const hashes: Hex[] = [];
  for (const item of transactions) {
    if (typeof item !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(item)) {
      throw new ChainUnavailableError(
        'indexer.malformed_block',
        `Block ${blockHash} at ${rpcUrl} listed a transaction that is not a hash. Refusing a partial transaction list.`,
      );
    }
    hashes.push(item.toLowerCase() as Hex);
  }
  return hashes;
}

function address(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toLowerCase();
}

function revertReasonOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const reason = (raw as { revertReason?: unknown }).revertReason;
  if (typeof reason !== 'string' || reason.trim() === '') return null;
  return reason;
}

async function tracedRevertReason(client: PublicClient, hash: Hex, rpcUrl: string): Promise<string | null> {
  let trace: unknown;
  try {
    trace = await client.request({
      method: 'debug_traceTransaction',
      params: [hash, { tracer: 'callTracer', tracerConfig: { onlyTopCall: true } }],
    } as never);
  } catch (err) {
    if (isTraceUnsupported(err)) return TRACE_UNAVAILABLE_REASON;
    throw classifyChainError(err, `revertReason(${hash})`, rpcUrl);
  }
  return revertReasonFromData(traceOutput(trace));
}

export async function readBlockTransactions(
  client: PublicClient,
  hashes: readonly Hex[],
  blockHash: Hex,
  rpcUrl: string,
): Promise<ChainTx[]> {
  const want = blockHash.toLowerCase();
  const out: ChainTx[] = [];
  for (const hash of hashes) {
    let tx;
    let receipt;
    try {
      tx = await client.getTransaction({ hash });
      receipt = await client.getTransactionReceipt({ hash });
    } catch (err) {
      if (isNotFound(err)) {
        throw new ChainUnavailableError(
          'indexer.malformed_block',
          `Block ${want} lists ${hash} but the node at ${rpcUrl} has no transaction or receipt. Refusing a partial read.`,
        );
      }
      throw classifyChainError(err, `readBlockTransactions(${hash})`, rpcUrl);
    }
    const txBlock = (tx.blockHash ?? '').toLowerCase();
    const receiptBlock = (receipt.blockHash ?? '').toLowerCase();
    if (txBlock !== want || receiptBlock !== want) {
      throw new ChainUnavailableError(
        'indexer.malformed_block',
        `Asked ${rpcUrl} for ${hash} in block ${want} and the node returned block ${txBlock || 'none'}. Refusing to staple it.`,
      );
    }
    if (tx.transactionIndex === null || tx.transactionIndex === undefined) {
      throw new ChainUnavailableError(
        'indexer.malformed_block',
        `Mined transaction ${hash} at ${rpcUrl} has no index. Refusing a partial read.`,
      );
    }
    let revertReason: string | null = null;
    const failed = receipt.status !== 'success';
    if (failed) {
      try {
        const raw = await client.request({ method: 'eth_getTransactionReceipt', params: [hash] });
        revertReason = revertReasonOf(raw);
      } catch (err) {
        throw classifyChainError(err, `revertReason(${hash})`, rpcUrl);
      }
      if (revertReason === null) revertReason = await tracedRevertReason(client, hash, rpcUrl);
    }
    const logs: ChainTxLog[] = [];
    for (const log of receipt.logs) {
      if (log.logIndex === null || log.logIndex === undefined) {
        throw new ChainUnavailableError(
          'indexer.malformed_block',
          `Transaction ${hash} at ${rpcUrl} has a log with no index. Refusing a partial read.`,
        );
      }
      logs.push({
        logIndex: log.logIndex,
        address: log.address.toLowerCase(),
        topics: log.topics.map((topic) => topic.toLowerCase()),
        data: log.data,
      });
    }
    const gasPrice = tx.gasPrice ?? receipt.effectiveGasPrice ?? null;
    out.push({
      hash: tx.hash.toLowerCase(),
      index: tx.transactionIndex,
      from: tx.from.toLowerCase(),
      to: address(tx.to),
      valueWei: tx.value,
      nonce: tx.nonce,
      gasLimit: tx.gas,
      gasPriceWei: gasPrice,
      gasConsumed: receipt.gasUsed,
      status: failed ? 'failed' : 'success',
      revertReason,
      input: tx.input,
      createdContract: address(receipt.contractAddress),
      logs,
    });
  }
  return out;
}

/** Mempool or already-mined. `null` is "the node has never heard of this hash", not a transport failure. */
export async function lookupExplorerTx(client: PublicClient, hash: string, rpcUrl: string): Promise<LiveTx | null> {
  const id = hash.toLowerCase() as Hex;
  let tx;
  try {
    tx = await client.getTransaction({ hash: id });
  } catch (err) {
    if (isNotFound(err)) return null;
    throw classifyChainError(err, `lookupExplorerTx(${id})`, rpcUrl);
  }
  if (!tx) return null;
  if (tx.blockHash === null || tx.blockNumber === null) {
    return {
      kind: 'pending',
      from: tx.from.toLowerCase(),
      to: address(tx.to),
      valueWei: tx.value,
      nonce: tx.nonce,
      gasLimit: tx.gas,
      gasPriceWei: tx.gasPrice ?? null,
      input: tx.input,
    };
  }
  const [mined] = await readBlockTransactions(client, [tx.hash.toLowerCase() as Hex], tx.blockHash.toLowerCase() as Hex, rpcUrl);
  if (!mined) {
    throw new ChainUnavailableError('indexer.malformed_block', `Node at ${rpcUrl} returned ${id} with no body.`);
  }
  return { kind: 'mined', tx: mined };
}
