import { useMemo, useRef, useState } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { BANK_PAY_YOURSELF_SUMMARY } from '@intafaced/contracts/bank-pay-yourself-procedures';
import { sleep as pause } from '@intafaced/contracts/sleep';
import { displayAmount, formatAmount, parseAmount } from '../../../shared/money';
import { useSession } from '../../session';
import { StepUpConfirm } from '../../money';
import {
  APP_CHAIN_ID,
  canonicalAmount,
  createVenueAccountApi,
  toTokenUnits,
  transferCalldata,
  usePolled,
  useWallet,
  type VenueWithdrawal,
} from '../../protocol';
import { draftId, keys, type VenueAccountSummary } from '../venue-api';
import { useVenueActions } from '../venue/VenueKit';
import { moveOutCopy } from './move-out-copy';
import { moveOutRefusal } from './move-out';

/**
 * The move out of the trading account to spending (J-derivatives-25 #10 #11), two legs, each sent once:
 *
 * 1. A venue withdrawal to the person's own wallet, signed in that wallet after a fresh second factor, under its own
 *    withdrawal key (the venue door keeps one action per key, so asking again is the same withdrawal).
 * 2. Once the venue reports it paid, the wallet's own signed send of what arrived to the person's own pay-in address at
 *    the partner, once per withdrawal: the room keeps the send's hash by the withdrawal's nonce and never sends it again.
 *
 * Before anything is signed: the amount is at most what the venue reports can leave (its `withdrawable` figure, its fee
 * and any cross loss already counted), and the partner publishes a pay-in on the wallet's chain; otherwise it refuses
 * with the figure and nothing is sent. Each leg shows its fee as its source reports it, or "not known", never 0. The
 * partner and the card show the money once the partner credits it, from the partner. INTAFACED holds none of it and the
 * ledger posts nothing. If this crashes after the withdrawal and before the send, the money is in the person's own
 * wallet: theirs, not stranded.
 */

type T = ReturnType<typeof moveOutCopy.useCopy>['t'];
const ASSET = 'USDC';
const READ_EVERY_MS = 2_000;
const FOLLOW_MS = 180_000;
const FOLLOW_EVERY_MS = 1_500;
/** Where the room keeps a withdrawal's forward send, by the venue's nonce: a second press never sends it twice. */
const sentKey = (nonce: string) => `intafaced:trading-move-out:${nonce}`;

type Leg = { at: 'withdrawal'; w: VenueWithdrawal } | { at: 'send'; w: VenueWithdrawal; tx: string };
type Stage =
  | { at: 'idle' }
  | { at: 'review'; amount: string; withdrawalKey: string }
  | { at: 'signing' | 'paying'; amount: string; withdrawalKey: string }
  | { at: 'forwarding'; w: VenueWithdrawal }
  | { at: 'crediting' | 'done'; w: VenueWithdrawal; tx: string };

function feeText(t: T, fee: { known: true; value: string } | { known: false }, asset: string) {
  return fee.known ? t('fee', { fee: `${displayAmount(fee.value, 2)} ${asset}` }) : t('feeUnknown');
}

/** What reaches the wallet: the withdrawal less the network fee the venue reports; null when it reports none. */
function arrived(w: VenueWithdrawal): string | null {
  if (!w.networkFee.known) return null;
  const left = parseAmount(w.amount) - parseAmount(w.networkFee.value);
  return left > 0n ? formatAmount(left) : null;
}

export function MoveOut({
  owner,
  venue,
  summary,
  partner,
  onMoved,
}: {
  owner: string;
  venue: { id: string | undefined; name: string };
  summary: VenueAccountSummary | null;
  partner: string | null;
  onMoved: () => void;
}) {
  const { t } = moveOutCopy.useCopy();
  const { api, userId } = useSession();
  const wallet = useWallet();
  const account = useMemo(() => createVenueAccountApi(api), [api]);
  const { run } = useVenueActions(owner);
  const payYourself = usePolled(
    (signal) => api.call(BANK_PAY_YOURSELF_SUMMARY, undefined, { signal }),
    `move-out:${userId}`,
    READ_EVERY_MS,
  );
  const payIn = payYourself.data?.payIn ?? null;
  const partnerFee = payYourself.data?.partnerFee ?? null;
  const [amount, setAmount] = useState('');
  const [stage, setStage] = useState<Stage>({ at: 'idle' });
  const [refusal, setRefusal] = useState<{ body: string; code?: string } | null>(null);
  const draft = useRef(draftId());
  const partnerName = partner ?? t('yourPartner');
  const withdrawable = summary?.withdrawable ?? null;
  const busy = stage.at === 'signing' || stage.at === 'paying' || stage.at === 'forwarding' || stage.at === 'crediting';

  const review = () => {
    setRefusal(null);
    const asked = canonicalAmount(amount);
    const why = moveOutRefusal(asked, withdrawable);
    if (why === 'amount') return setRefusal({ body: t('badAmount') });
    if (why === 'unreported') return setRefusal({ body: t('unreported', { venue: venue.name }) });
    if (why === 'above')
      return setRefusal({
        body: t('above', { venue: venue.name, withdrawable: withdrawable ?? '0', asset: ASSET }),
        code: 'trade.move_out_above_withdrawable',
      });
    if (!payIn || 'unset' in payIn || payIn.chainId !== APP_CHAIN_ID) return setRefusal({ body: t('noPayIn', { partner: partnerName }) });
    setStage({ at: 'review', amount: asked!, withdrawalKey: keys.withdraw(owner, draft.current) });
  };

  /** Leg two: the wallet's own send of what arrived to the person's pay-in at the partner, once per withdrawal. */
  const forward = async (w: VenueWithdrawal) => {
    if (!payIn || 'unset' in payIn) return setRefusal({ body: t('noPayIn', { partner: partnerName }) });
    const kept = localStorage.getItem(sentKey(w.nonce));
    if (kept) return follow(w, kept);
    const left = arrived(w);
    const units = left === null ? null : toTokenUnits(left, payIn.tokenDecimals);
    if (units === null) return setRefusal({ body: t('arrivedUnknown', { venue: venue.name }) });
    setStage({ at: 'forwarding', w });
    const sent = await wallet.sign({ kind: 'transaction', to: payIn.token, data: transferCalldata(payIn.address, units) });
    if (sent.status !== 'sent') {
      setStage({ at: 'idle' });
      return setRefusal({
        body:
          sent.status === 'rejected' ? t('walletRejected') : t('walletFailed', { detail: sent.status === 'failed' ? sent.message : '' }),
      });
    }
    localStorage.setItem(sentKey(w.nonce), sent.hash);
    await follow(w, sent.hash);
  };

  /** The partner's credit of the send, followed until it reads available, as the partner reports it. */
  const follow = async (w: VenueWithdrawal, tx: string) => {
    setStage({ at: 'crediting', w, tx });
    const until = Date.now() + FOLLOW_MS;
    while (Date.now() < until) {
      const read = await api.call(BANK_PAY_YOURSELF_SUMMARY, undefined);
      const credit = read.ok ? read.data.credits.find((c) => c.txHash.toLowerCase() === tx.toLowerCase()) : undefined;
      if (credit?.status === 'available') break;
      await pause(FOLLOW_EVERY_MS);
    }
    payYourself.reload();
    onMoved();
    setStage({ at: 'done', w, tx });
  };

  /** Leg one, after the fresh second factor: the wallet signs the venue withdrawal to itself; the venue's payout is followed. */
  const withdraw = async (stepUpApprovalId: string | null) => {
    if (stage.at !== 'review') return;
    const { amount: asked, withdrawalKey } = stage;
    setStage({ at: 'signing', amount: asked, withdrawalKey });
    const answer = await run(
      { kind: 'withdraw', asset: ASSET, amount: asked, destination: owner, withdrawalKey },
      { stepUpApprovalId, ...(venue.id ? { venueId: venue.id } : {}) },
    );
    const nonce = answer.kind === 'outcome' && answer.outcome.accepted ? answer.nonce : answer.kind === 'unknown' ? answer.nonce : null;
    if (!nonce) {
      setStage({ at: 'idle' });
      if (answer.kind === 'refused') return setRefusal({ body: answer.message, ...(answer.code ? { code: answer.code } : {}) });
      if (answer.kind === 'outcome') return setRefusal({ body: t('venueRefused', { venue: venue.name }) });
      return setRefusal({ body: answer.kind === 'rejected' ? t('walletRejected') : t('notSent') });
    }
    // A new move after this one is a new withdrawal, under a new key.
    draft.current = draftId();
    setStage({ at: 'paying', amount: asked, withdrawalKey });
    onMoved();
    const until = Date.now() + FOLLOW_MS;
    let w: VenueWithdrawal | null = null;
    while (Date.now() < until) {
      const read = await account.withdrawal(owner, nonce);
      w = read.ok ? read.data.value : null;
      if (w && w.status !== 'pending') break;
      await pause(FOLLOW_EVERY_MS);
    }
    if (!w || w.status !== 'done') {
      setStage({ at: 'idle' });
      return setRefusal({
        body: w?.status === 'failed' ? t('withdrawalFailed', { venue: venue.name }) : t('withdrawalPending', { venue: venue.name }),
      });
    }
    await forward(w);
  };

  const legs: Leg | null =
    stage.at === 'forwarding'
      ? { at: 'withdrawal', w: stage.w }
      : stage.at === 'crediting' || stage.at === 'done'
        ? { at: 'send', w: stage.w, tx: stage.tx }
        : null;
  return (
    <section className="lt-stack" aria-label={t('title')} data-testid="move-out">
      <h2>{t('title')}</h2>
      <p className="lt-hint">{t('lead')}</p>
      <p data-testid="move-out-withdrawable" data-value={withdrawable ?? ''}>
        {withdrawable === null
          ? t('withdrawableUnknown', { venue: venue.name })
          : t('withdrawable', { venue: venue.name, amount: withdrawable, asset: ASSET })}
      </p>
      {stage.at === 'idle' || stage.at === 'done' ? (
        <div className="lt-actions">
          <Field
            label={t('amount', { asset: ASSET })}
            name="move-out-amount"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          <Button onClick={review}>{t('review')}</Button>
        </div>
      ) : null}
      {stage.at === 'review' ? (
        <div data-testid="move-out-review" className="lt-stack">
          <ol>
            <li data-leg="withdrawal">
              {t('legWithdrawal', { venue: venue.name, amount: displayAmount(stage.amount, 2), asset: ASSET, wallet: owner })}
            </li>
            <li data-leg="send">{t('legSend', { partner: partnerName, asset: ASSET })}</li>
          </ol>
          <StepUpConfirm
            key={stage.withdrawalKey}
            request={() => ({
              scope: 'trade.step_up.venue.withdraw',
              purpose: 'venue.withdraw',
              target: stage.withdrawalKey,
              amount: stage.amount,
              fields: { withdrawalKey: stage.withdrawalKey, owner, subAccount: '', asset: ASSET, amount: stage.amount, destination: owner },
            })}
            words={{
              why: t('stepUpWhy'),
              code: t('stepUpCode'),
              codeHint: t('stepUpCodeHint'),
              codeShort: t('stepUpCodeShort'),
              noFactor: t('stepUpNoFactor'),
              sendWithout: t('stepUpSendWithout'),
            }}
            disabled={busy}
            onApproved={(id) => void withdraw(id)}
          />
        </div>
      ) : null}
      {stage.at === 'signing' ? <p role="status">{t('signing')}</p> : null}
      {stage.at === 'paying' ? <p role="status">{t('paying', { venue: venue.name })}</p> : null}
      {stage.at === 'forwarding' ? <p role="status">{t('forwarding', { partner: partnerName })}</p> : null}
      {stage.at === 'crediting' ? <p role="status">{t('crediting', { partner: partnerName })}</p> : null}
      {stage.at === 'done' ? (
        <p role="status" data-testid="move-out-done">
          {t('done', { partner: partnerName })}
        </p>
      ) : null}
      {legs ? (
        <ol data-testid="move-out-legs">
          <li data-leg="withdrawal" data-nonce={legs.w.nonce}>
            {t('legWithdrawal', { venue: venue.name, amount: displayAmount(legs.w.amount, 2), asset: legs.w.asset, wallet: owner })}{' '}
            <span data-tx={legs.w.txHash ?? ''}>{legs.w.txHash ?? null}</span> <span data-fee>{feeText(t, legs.w.fee, legs.w.asset)}</span>{' '}
            <span data-network-fee>
              {legs.w.networkFee.known
                ? t('networkFee', { fee: `${displayAmount(legs.w.networkFee.value, 2)} ${legs.w.asset}` })
                : t('networkFeeUnknown')}
            </span>
          </li>
          {legs.at === 'send' ? (
            <li data-leg="send">
              {t('legSent', { amount: displayAmount(arrived(legs.w) ?? legs.w.amount, 2), asset: legs.w.asset, partner: partnerName })}{' '}
              <span data-tx={legs.tx}>{legs.tx}</span>{' '}
              <span data-fee>
                {partnerFee === null ? t('feeUnknown') : t('fee', { fee: `${displayAmount(partnerFee, 2)} ${legs.w.asset}` })}
              </span>
            </li>
          ) : null}
        </ol>
      ) : null}
      {refusal ? (
        <div role="alert" className="lt-refusal" data-testid="move-out-refusal">
          <strong>{t('refusedTitle')}</strong> <span data-refusal-body>{refusal.body}</span>{' '}
          {refusal.code ? <code>{refusal.code}</code> : null}
        </div>
      ) : null}
    </section>
  );
}
