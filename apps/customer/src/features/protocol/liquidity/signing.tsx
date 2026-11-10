import { useMemo, useState, type ReactNode } from 'react';
import { useApi } from '../../session/session';
import { createProtocolApi } from '../api';
import { REGION_BLOCKED_CODE } from '../region';
import { RepresentationPanel } from '../wallet/RepresentationPanel';
import { useWallet, waitMined, type Sequence } from '../wallet/WalletProvider';
import { createLiquidityApi } from './liquidity-api';
import type { LiquidityTranslate } from './copy';

type Step = Sequence['steps'][number];
type Call = { to: string; data: string };

/** How long a liquidity call may take to be mined before the room stops following it (the wallet still holds it). */
const MINED_TIMEOUT_MS = 120_000;

/** What became of the steps: mined and succeeded, or a sentence that says why not, from the chain where it can. */
export type Outcome = { ok: true; hash: string } | { ok: false; reason: string };

/**
 * Signing for the liquidity rooms: the representation gate first (it never fails open), then the exact approvals each
 * token needs for the spender, then one plain-words sheet with every step; the person's wallet signs and sends each.
 * The last step is followed until mined. When it fails, before or after it is mined, the same call is run against the
 * chain again and the contract's own reason is named (a reverted call changes nothing, so it reverts the same way).
 */
export function useLiquiditySigning(t: LiquidityTranslate) {
  const wallet = useWallet();
  const transport = useApi();
  const protocol = useMemo(() => createProtocolApi(transport), [transport]);
  const liquidity = useMemo(() => createLiquidityApi(transport), [transport]);
  const [gate, setGate] = useState<{ status: Parameters<typeof RepresentationPanel>[0]['status']; resume: () => void } | null>(null);
  const [gateProblem, setGateProblem] = useState<string | null>(null);

  /**
   * Runs `then` once this wallet has accepted the representation. When it has not, shows the panel and returns; on
   * accept the room's own `restart` runs (the caller's whole action again, with its busy flag and error handling), which
   * finds the representation accepted and goes on to `then`.
   */
  const withRepresentation = async (then: () => Promise<void>, restart: () => void): Promise<string | null> => {
    if (!wallet.address) return t('noWallet');
    const status = await protocol.representationStatus(wallet.address);
    if (!status.ok)
      return status.code === REGION_BLOCKED_CODE
        ? t('regionBlocked')
        : status.code === 'compliance.representation_unset'
          ? t('representationUnset')
          : t('representationUnread');
    if (!status.data.accepted) {
      setGate({ status: status.data, resume: restart });
      return null;
    }
    await then();
    return null;
  };

  /** The exact approval steps for `amount` of `token` to `spender`, or a sentence when they were not read. */
  const approvals = async (token: { address: string; name: string }, spender: string, amount: bigint, amountShown: string) => {
    if (!wallet.address) return { ok: false as const, reason: t('noWallet') };
    const check = await protocol.checkApproval({ owner: wallet.address, token: token.address, spender, amount: amount.toString() });
    if (!check.ok) return { ok: false as const, reason: t('refused', { reason: check.message }) };
    const steps: Step[] = check.data.calls.map((approve, index) => ({
      label:
        check.data.resetFirst && index === 0
          ? t('stepReset', { token: token.name })
          : t('stepApprove', { amount: amountShown, token: token.name }),
      request: { kind: 'transaction' as const, to: approve.to, data: approve.data },
    }));
    return { ok: true as const, steps };
  };

  /** Why `call` fails, in words, from the contract's own error as the chain answers it now. */
  const why = async (call: Call, fallback: string): Promise<string> => {
    if (!wallet.address) return fallback;
    const answer = await liquidity.explain({ from: wallet.address, to: call.to, data: call.data });
    if (!answer.ok || !answer.data.reverts || !answer.data.error) return fallback;
    const key = `revert_${answer.data.error}`;
    const known = [
      'revert_InsufficientShares',
      'revert_InsufficientAmount0',
      'revert_InsufficientAmount1',
      'revert_Expired',
      'revert_PoolExists',
    ];
    return known.includes(key) ? t(key as 'revert_InsufficientShares') : t('revert_other', { error: answer.data.error });
  };

  /** Sends the steps under one sheet and follows the last one until it is mined. */
  const send = async (sequence: Sequence, last: Call, onSent: () => void = () => undefined): Promise<Outcome> => {
    const result = await wallet.sendSequence(sequence);
    const earlier = result.status !== 'sent' && result.sent.length > 0 ? ` ${t('earlierSent', { hashes: result.sent.join(', ') })}` : '';
    if (result.status === 'rejected')
      return { ok: false, reason: `${result.sent.length > 0 ? t('rejectedAfter') : t('rejected')}${earlier}` };
    if (result.status === 'failed') {
      if (result.step === sequence.steps.length - 1) return { ok: false, reason: `${await why(last, result.message)}${earlier}` };
      return { ok: false, reason: `${t('failed', { reason: result.message })}${earlier}` };
    }
    onSent();
    const hash = result.hashes[result.hashes.length - 1]!;
    const mined = await waitMined((h) => wallet.read('eth_getTransactionReceipt', [h]), hash, MINED_TIMEOUT_MS);
    if (mined.status === 'success') return { ok: true, hash };
    if (mined.status === 'timeout') return { ok: false, reason: t('waiting') };
    return { ok: false, reason: await why(last, t('failed', { reason: hash })) };
  };

  const panel: ReactNode =
    gate && wallet.address ? (
      <RepresentationPanel
        address={wallet.address}
        status={gate.status}
        api={protocol}
        onEnd={(end) => {
          const resume = gate.resume;
          setGate(null);
          if (end.kind === 'accepted') resume();
          else if (end.kind === 'rejected') setGateProblem(t('rejected'));
          else if (end.kind === 'region') setGateProblem(t('regionBlocked'));
          else setGateProblem(end.message);
        }}
      />
    ) : null;

  return { wallet, liquidity, withRepresentation, approvals, send, panel, gateProblem, clearGateProblem: () => setGateProblem(null) };
}

/** The room's note when no wallet is connected: the full layout stays, and the blocker is named. */
export function NoWalletNote({ t }: { t: LiquidityTranslate }) {
  return (
    <div role="note" data-blocker="wallet">
      <strong>{t('blockedBy')}</strong>
      <p>{t('noWallet')}</p>
      <a href="/wallet">{t('connectWallet')}</a>
    </div>
  );
}
