import { useEffect, useRef, useState } from 'react';
import { academyCoursePurchaseViewSchema, type AcademyCoursePurchaseView } from '@intafaced/contracts/academy-catalogue';
import { ServiceOffNotice as KitServiceOffNotice } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Loading, Panel } from '../../shared/ui';
import { useApi } from '../session/session';
import { WALLET_SECTIONS } from '../protocol/routes';
import { useWallet, WalletProvider } from '../protocol/wallet/WalletProvider';
import { academyPurchaseCopy as copy } from './academy-purchase-copy';
import { AcademyRefusal, GuardedButton } from './AcademyLmsParts';

type Failure = Extract<ApiResult<never>, { ok: false }>;
type View = AcademyCoursePurchaseView;

/** States the page keeps reading until they settle: the chain or the ledger still has to answer. */
const MOVING = new Set(['submitted', 'confirmed', 'refunding']);
const POLL_MS = 2_000;

/**
 * Buying a paid course's certificate track (J-academy-07, AC-commerce-01), signed in. The price and the track difference,
 * Buy from the person's own wallet, and Pay by card (off with no card partner). The wallet is asked to sign one transfer
 * to INTAFACED only when Academy's answer to Buy carries the request; a second press or a lost reply re-reads the stored
 * purchase and never asks again. What shows is always the stored purchase, read again until the chain and the ledger
 * have answered. Its own wallet connection, restored from the one the person made in Wallet.
 */
export function AcademyCoursePurchase({ slug, onSettled }: { slug: string; onSettled?: () => void }) {
  return (
    <WalletProvider scope="academy-purchase">
      <PurchasePanelFrame slug={slug} onSettled={onSettled} />
    </WalletProvider>
  );
}

function PurchasePanelFrame(props: { slug: string; onSettled?: (() => void) | undefined }) {
  const { t } = copy.useCopy();
  return (
    <Panel title={t('title')}>
      <PurchasePanel {...props} />
    </Panel>
  );
}

function PurchasePanel({ slug, onSettled }: { slug: string; onSettled?: (() => void) | undefined }) {
  const api = useApi();
  const wallet = useWallet();
  const { t } = copy.useCopy();
  const read = useResource(
    (signal) => api.query('academy', 'coursePurchase', { slug }, academyCoursePurchaseViewSchema, { signal }),
    `course-purchase:${slug}`,
  );
  const [last, setLast] = useState<View | null>(null);
  const ready = read.resource.status === 'ready' ? read.resource.data : null;
  useEffect(() => {
    if (ready) setLast(ready);
  }, [ready]);
  const state = (ready ?? last)?.purchase?.state ?? null;
  // Keep reading while the chain or the ledger has yet to answer; tell the page once access changed. The state seen last
  // is kept even while it moves, so a purchase first seen moving (a refund already sending) still tells the page when it
  // settles.
  const seenState = useRef<string | null>(null);
  useEffect(() => {
    const before = seenState.current;
    seenState.current = state;
    const moving = state !== null && MOVING.has(state);
    if (before !== null && before !== state && !moving) onSettled?.();
    if (moving) {
      const timer = setTimeout(read.reload, POLL_MS);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [state, ready, read.reload, onSettled]);

  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const [refusal, setRefusal] = useState<Failure | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const view = ready ?? last;
  if (!view) {
    if (read.resource.status === 'failed') return <AcademyRefusal failure={read.resource.failure} retry={read.reload} />;
    return <Loading />;
  }

  const connected = wallet.status === 'connected' && wallet.address !== null;
  const onNetwork = view.wallet.state === 'on' && wallet.chainId === view.wallet.chainId;

  const buy = async () => {
    if (inFlight.current || !wallet.address) return;
    inFlight.current = true;
    setSending(true);
    setRefusal(null);
    setNote(null);
    try {
      const answer = await api.mutate('academy', 'buyCourse', { slug, wallet: wallet.address }, academyCoursePurchaseViewSchema);
      if (!answer.ok) {
        setRefusal(answer);
        return;
      }
      const request = answer.data.request;
      const key = answer.data.purchase?.key;
      // No request: the intent was already open or recorded, so the wallet is not asked again.
      if (!request || !key) return;
      const signed = await wallet.sign({ kind: 'transaction', to: request.to, data: request.data, value: '0x0' });
      if (signed.status === 'sent') {
        const stored = await api.mutate('academy', 'submitCoursePayment', { key, txHash: signed.hash }, academyCoursePurchaseViewSchema);
        if (!stored.ok) setRefusal(stored);
      } else if (signed.status === 'rejected') {
        await api.mutate('academy', 'abandonCoursePurchase', { key }, academyCoursePurchaseViewSchema);
        setNote(t('rejected'));
      } else {
        // Not known whether it went out: Academy reads the chain for it, and the wallet is not asked again.
        setNote(t('walletFailed', { message: signed.status === 'failed' ? signed.message : signed.status }));
      }
    } finally {
      inFlight.current = false;
      setSending(false);
      read.reload();
    }
  };

  const cancel = async () => {
    const key = view.purchase?.key;
    if (!key || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    try {
      const answer = await api.mutate('academy', 'abandonCoursePurchase', { key }, academyCoursePurchaseViewSchema);
      if (!answer.ok) setRefusal(answer);
    } finally {
      inFlight.current = false;
      setSending(false);
      read.reload();
    }
  };

  const purchase = view.purchase;
  const open = purchase === null || purchase.state === 'failed' || purchase.state === 'refunded';
  const buyReason =
    view.wallet.state === 'off'
      ? t(view.wallet.code === 'academy.price_unset' ? 'noPrice' : 'paymentsOff')
      : !connected
        ? t('needsWallet')
        : !onNetwork
          ? t('wrongNetwork')
          : sending
            ? t('buying')
            : null;

  return (
    <section className="academy-lms-stack" aria-label={t('title')} data-academy-purchase={view.slug}>
      {view.price !== null && view.asset !== null ? (
        <p data-testid="academy-purchase-price">{t('price', { price: view.price, asset: view.asset })}</p>
      ) : (
        <p role="status">{t('noPrice')}</p>
      )}
      <p className="muted">{t('tracksDifference')}</p>
      <p className="muted">{t('custody')}</p>
      {purchase && <PurchaseState view={view} />}
      {purchase?.state === 'awaiting_signature' && (
        <div className="academy-lms-stack" role="group" aria-label={t('signatureAsked')}>
          <p role="status">{t('signatureAsked')}</p>
          <GuardedButton
            variant="secondary"
            reason={sending ? t('buying') : null}
            reasonId={`academy-purchase-${view.slug}-cancel`}
            onClick={cancel}
          >
            {t('cancel')}
          </GuardedButton>
        </div>
      )}
      {open && (
        <div className="academy-lms-stack" role="group" aria-label={t('walletTitle')}>
          <h4>{t('walletTitle')}</h4>
          {connected && wallet.address ? (
            <p className="muted" data-testid="academy-purchase-wallet">
              {t('walletAddress', { address: wallet.address.toLowerCase() })}
            </p>
          ) : (
            <p className="muted">
              <a href={WALLET_SECTIONS.overview}>{t('openWallet')}</a>
            </p>
          )}
          <GuardedButton reason={buyReason} reasonId={`academy-purchase-${view.slug}-buy`} onClick={buy}>
            {t(purchase ? 'buyAgain' : 'buy')}
          </GuardedButton>
        </div>
      )}
      <div className="academy-lms-stack" role="group" aria-label={t('cardTitle')}>
        <h4>{t('cardTitle')}</h4>
        <GuardedButton variant="secondary" reason={t('cardOff')} reasonId={`academy-purchase-${view.slug}-card`} onClick={() => undefined}>
          {t('card')}
        </GuardedButton>
        <KitServiceOffNotice code={view.card.code} sentence={t('cardOff')} role="note" />
      </div>
      {note && <p role="status">{note}</p>}
      {refusal && <AcademyRefusal failure={refusal} />}
    </section>
  );
}

function Hash({ label, hash }: { label: string; hash: string | null }) {
  if (!hash) return null;
  return (
    <p className="muted">
      {label}: <code data-testid="academy-purchase-tx">{hash}</code>
    </p>
  );
}

/** The stored purchase in words: where its payment is, whether access is granted, and a refund with its reason. */
function PurchaseState({ view }: { view: View }) {
  const { t } = copy.useCopy();
  const purchase = view.purchase!;
  const money = { amount: purchase.amount, asset: purchase.asset };
  const failure =
    purchase.failure === 'payment_reverted'
      ? t('failurePaymentReverted')
      : purchase.failure === 'payment_mismatch'
        ? t('failurePaymentMismatch')
        : (purchase.failure ?? '');
  const words =
    purchase.state === 'submitted'
      ? t('submitted')
      : purchase.state === 'confirmed'
        ? t(purchase.failure ? 'recordPending' : 'confirmed')
        : purchase.state === 'posted'
          ? t('posted')
          : purchase.state === 'refunding'
            ? t('refunding', money)
            : purchase.state === 'refunded'
              ? t('refunded', money)
              : purchase.state === 'failed'
                ? t('failed', { reason: failure })
                : null;
  return (
    <div
      className="academy-lms-stack"
      data-testid="academy-purchase-state"
      data-state={purchase.state}
      data-grant={purchase.grant ?? 'none'}
    >
      {words && <p role="status">{words}</p>}
      <p className="muted">{t('purchaseKey', { key: purchase.key })}</p>
      <Hash label={t('transaction')} hash={purchase.txHash} />
      {purchase.refund && (
        <>
          <p>{t('refundReason', { reason: purchase.refund.reason })}</p>
          <Hash label={t('refundTransaction')} hash={purchase.refund.txHash} />
        </>
      )}
    </div>
  );
}
