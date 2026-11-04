import { getAddress, type Address, type Hash, type PublicClient } from 'viem';
import {
  FEE_ABOVE_CEILING,
  FEE_BUMP_UNSET,
  FEE_CEILING_UNSET,
  TX_FINAL,
  TX_NOT_FOUND,
  TX_NOT_YOURS,
  type ProtocolReplacement,
  type ProtocolReplacementInput,
} from '@intafaced/contracts';
import { WalletTxRefusal } from './claim-link.js';

/**
 * Speed up and cancel a pending transaction (RC-dex-protocol-01). An account's transactions run in nonce order, so the
 * only way to change a pending one is another transaction at the same nonce that the network prefers: a higher fee.
 * Speed up repeats the same call; cancel is a zero-value send to oneself. Both fee fields are raised by the owner's
 * published bump (`PROTOCOL_TX_FEE_BUMP_BPS`), never above the published ceiling (`PROTOCOL_TX_FEE_CEILING_WEI`), so a
 * stale page cannot build an extreme fee. A mined transaction is final: nothing replaces it, and this refuses
 * `protocol.tx_final`. The service builds an unsigned transaction and stores nothing; the person's wallet signs it.
 */
export interface ReplacementSetting {
  bumpBps: number | null;
  ceilingWei: bigint | null;
}

export type ReplacementChain = Pick<PublicClient, 'getTransaction' | 'getChainId'>;

/** `ceil(fee × (10000 + bump) / 10000)`: at least the published bump above the old fee, never rounded down. */
export function bumpFee(fee: bigint, bumpBps: number): bigint {
  const scaled = fee * BigInt(10_000 + bumpBps);
  return (scaled + 9_999n) / 10_000n;
}

export async function buildReplacement(
  chain: ReplacementChain,
  setting: ReplacementSetting,
  input: ProtocolReplacementInput,
): Promise<ProtocolReplacement> {
  if (setting.bumpBps === null)
    throw new WalletTxRefusal(FEE_BUMP_UNSET, 'the fee bump for a speed-up or cancel is an owner setting (PROTOCOL_TX_FEE_BUMP_BPS).');
  if (setting.ceilingWei === null)
    throw new WalletTxRefusal(
      FEE_CEILING_UNSET,
      'the most a speed-up or cancel may offer per gas is an owner setting (PROTOCOL_TX_FEE_CEILING_WEI).',
    );
  const tx = await chain.getTransaction({ hash: input.txHash as Hash }).catch((err: Error) => {
    if (/not be found|not found/i.test(err.message)) return null;
    throw err;
  });
  if (!tx) throw new WalletTxRefusal(TX_NOT_FOUND, 'the network does not know this transaction: it may have been dropped or replaced.');
  if (getAddress(tx.from) !== getAddress(input.from))
    throw new WalletTxRefusal(TX_NOT_YOURS, 'this transaction was sent by another account; only its sender can replace it.');
  if (tx.blockNumber !== null)
    throw new WalletTxRefusal(TX_FINAL, 'Final. A completed transfer cannot be canceled or revoked; send a new transaction instead.');
  // A legacy transaction has one gas price; both fields of the replacement start from it.
  const oldMax = tx.maxFeePerGas ?? tx.gasPrice ?? 0n;
  const oldTip = tx.maxPriorityFeePerGas ?? tx.gasPrice ?? 0n;
  const newMax = bumpFee(oldMax, setting.bumpBps);
  const newTip = bumpFee(oldTip, setting.bumpBps);
  if (newMax > setting.ceilingWei)
    throw new WalletTxRefusal(
      FEE_ABOVE_CEILING,
      `the raised fee (${newMax} wei per gas) is above the published ceiling (${setting.ceilingWei} wei per gas), so nothing is built.`,
    );
  const from = getAddress(tx.from) as Address;
  const speedUp = input.mode === 'speedUp';
  if (speedUp && !tx.to) throw new WalletTxRefusal(TX_NOT_FOUND, 'this transaction creates a contract; only a cancel can replace it.');
  return {
    mode: input.mode,
    chainId: await chain.getChainId(),
    from,
    nonce: tx.nonce,
    to: speedUp ? getAddress(tx.to!) : from,
    value: speedUp ? tx.value.toString() : '0',
    data: speedUp ? tx.input : '0x',
    original: { maxFeePerGas: oldMax.toString(), maxPriorityFeePerGas: oldTip.toString() },
    replacement: { maxFeePerGas: newMax.toString(), maxPriorityFeePerGas: newTip.toString() },
    bumpBps: setting.bumpBps,
    ceilingWei: setting.ceilingWei.toString(),
  };
}
