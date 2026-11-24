// volt-room: /pay/scheduled
// volt-room: /pay/cases
// volt-room: /pay/history/:transferId
// volt-room: /pay/cases/:caseId
// volt-room: /pay/bills/invoices/:invoiceId
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button, EmptyState } from '@intafaced/ui/lit';
import { KeyValue, RecordListTemplate, RefusalBox, Skeleton, type KeyValueRow, type RoomState } from '@intafaced/ui/lit/templates';
import { createActivityFeed, fmtAmount, refusalCopy } from '../../data';
import { usePreferences } from '../../shared/preferences';
import { stamp } from '../money/time';
import { useSession } from '../../features/session/session';
import { fetchHeldSend, type HeldSend } from '../../features/pay/held-send';
import { fetchSentSend, SENT_NOT_FOUND, type SentSend } from '../../features/pay/sent-send';
import { createPersonalPayApi } from '../../features/pay/pay-api';
import { decodedSegment, type PersonalRoomMatch } from '../../features/pay/personal/rooms/rooms';
import { roomsCopy } from '../../features/pay/personal/rooms/rooms-copy';

/**
 * The personal Pay rooms on the record-list template: Scheduled, Cases, one case, one payment and one bill (PP-order-02).
 * Each keeps its address, its words and its controls; where nothing stands behind a room yet it says what is missing and
 * keeps its controls off. A signed-out visitor never reaches these: `PersonalRoom` sends them to sign in first.
 */
const READY: RoomState = { kind: 'ready' };

/** The way back to Pay, under the room's records. */
function Back() {
  const { t } = roomsCopy.useCopy();
  return (
    <a className="lt-link" href="/pay" data-testid="pay-room-back">
      {t('back')}
    </a>
  );
}

/** A list room (its records, then the way back), or with `detail` a record's own page. */
function Room({ title, line, list, detail }: { title: string; line: string; list?: ReactNode; detail?: ReactNode }) {
  return (
    <div data-testid="pay-room">
      {detail !== undefined ? (
        <RecordListTemplate
          title={title}
          description={line}
          state={READY}
          list={null}
          detailOnly
          detail={
            <>
              {detail}
              <Back />
            </>
          }
        />
      ) : (
        <RecordListTemplate
          title={title}
          description={line}
          state={READY}
          list={
            <>
              {list}
              <Back />
            </>
          }
        />
      )}
    </div>
  );
}

/** Why a room has nothing behind it yet, always on screen. `slice` is the work that connects it. */
function Blocked({ slice, body }: { slice: string; body: string }) {
  const { t } = roomsCopy.useCopy();
  return (
    <div id="pay-room-reason" role="note" data-testid="pay-reason" data-slice={slice}>
      <RefusalBox refusal={{ variant: 'parked', title: t('blockedTitle'), body }} />
    </div>
  );
}

/** A control that cannot run yet: visible, off, and tied to the reason on screen. */
function Off({ children }: { children: ReactNode }) {
  return (
    <Button disabled aria-describedby="pay-room-reason">
      {children}
    </Button>
  );
}

/** A list with nothing in it yet, said plainly, with its one control off. */
function Section({ title, empty, off }: { title: string; empty: string; off: string }) {
  return (
    <div>
      <h3>{title}</h3>
      <EmptyState title={empty} action={<Off>{off}</Off>} />
    </div>
  );
}

function ScheduledRoom({ slice }: { slice: string }) {
  const { t } = roomsCopy.useCopy();
  return (
    <Room
      title={t('scheduledTitle')}
      line={t('scheduledLine')}
      list={
        <>
          <Blocked slice={slice} body={t('scheduledReason')} />
          <Section title={t('scheduledListTitle')} empty={t('scheduledEmpty')} off={t('scheduledNew')} />
        </>
      }
    />
  );
}

/** A send the owner's review holds, as its sender reads it: its state, the reason class, and what it would send. */
function HeldStatus({ held }: { held: HeldSend }) {
  const { t } = roomsCopy.useCopy();
  const { timeZone } = usePreferences();
  const state = held.status === 'in_review' ? t('heldInReview') : held.status === 'rejected' ? t('heldRejected') : t('heldReleased');
  const reason = held.reasonClass === 'amount_over_review_line' ? t('heldReason_amount_over_review_line') : t('heldReasonOther');
  return (
    <>
      <p role="status" data-testid="payment-status" data-status={held.status}>
        {state}
      </p>
      <KeyValue
        rows={[
          { label: t('heldStatusRow'), value: <span data-testid="payment-status-word">{state}</span> },
          {
            label: t('heldReasonRow'),
            value: (
              <span data-testid="payment-review-reason" data-reason={held.reasonClass}>
                {reason}
              </span>
            ),
          },
          {
            label: t('requestAmount'),
            value: (
              <span lang="zxx">
                {fmtAmount(held.amount, { places: 18 })} {held.assetId}
              </span>
            ),
          },
          { label: t('heldTo'), value: held.toHandle ? `@${held.toHandle}` : t('notSet'), unset: !held.toHandle },
          { label: t('requestMade'), value: <span lang="zxx">{stamp(held.createdAt, timeZone, Date.now())}</span> },
          { label: t('reference'), value: <span lang="zxx">{held.transferId}</span>, ltr: true },
        ]}
      />
      <p className="lt-hint" data-testid="payment-held-note">
        {held.status === 'in_review' ? t('heldNote') : held.status === 'rejected' ? t('heldRejectedNote') : t('heldReleasedNote')}
      </p>
    </>
  );
}

/**
 * The sender's own send as the bank knows it (J-pay-01 #6): Confirming while the bank does not yet know the move was
 * made, then Completed with the partner's or the ledger's reference. Confirming has one control, to ask again.
 */
function SentStatus({ sent, checkAgain }: { sent: SentSend; checkAgain: () => void }) {
  const { t } = roomsCopy.useCopy();
  const { timeZone } = usePreferences();
  const done = sent.status === 'completed';
  const state = done ? t('sentCompleted') : t('sentConfirming');
  const rows: KeyValueRow[] = [
    { label: t('heldStatusRow'), value: <span data-testid="payment-status-word">{state}</span> },
    {
      label: t('requestAmount'),
      value: (
        <span lang="zxx">
          {fmtAmount(sent.amount, { places: 18 })} {sent.assetId}
        </span>
      ),
    },
    { label: t('heldTo'), value: sent.toHandle ? `@${sent.toHandle}` : t('notSet'), unset: !sent.toHandle },
    ...(sent.note ? [{ label: t('requestNote'), value: sent.note }] : []),
    { label: t('requestMade'), value: <span lang="zxx">{stamp(sent.createdAt, timeZone, Date.now())}</span> },
    ...(sent.partnerMove
      ? [
          {
            label: t('sentPartnerReference', { bank: sent.partnerMove.label }),
            value: (
              <span lang="zxx" data-testid="payment-partner-reference">
                {sent.partnerMove.id}
              </span>
            ),
            ltr: true,
          },
        ]
      : []),
    ...(sent.ledgerTxId
      ? [
          {
            label: t('reference'),
            value: (
              <span lang="zxx" data-testid="payment-ledger-reference">
                {sent.ledgerTxId}
              </span>
            ),
            ltr: true,
          },
        ]
      : []),
    { label: t('sentTransferId'), value: <span lang="zxx">{sent.transferId}</span>, ltr: true },
  ];
  return (
    <>
      <p role="status" data-testid="payment-status" data-status={sent.status}>
        {state}
      </p>
      <KeyValue rows={rows} />
      <p className="lt-hint" data-testid="payment-sent-note">
        {done ? t('sentCompletedNote') : t('sentConfirmingNote')}
      </p>
      {done ? null : (
        <div className="lt-actions">
          <Button onClick={checkAgain} data-testid="payment-check-again">
            {t('sentCheckAgain')}
          </Button>
        </div>
      )}
    </>
  );
}

/** A read that failed, with its one way to try again. */
function ReadFailed({ title, retry }: { title: string; retry: () => void }) {
  const { t } = roomsCopy.useCopy();
  return (
    <div role="alert">
      <p>{title}</p>
      <Button onClick={retry}>{t('tryAgain')}</Button>
    </div>
  );
}

function PaymentRoom({ id, slice }: { id: string | null; slice: string }) {
  const { t } = roomsCopy.useCopy();
  const { api, userId } = useSession();
  const { timeZone } = usePreferences();
  // A send the review holds is not in the ledger's activity: the bank's own record of it is read first. Not found means
  // it was never held, and the activity is read; any other failure says so, never "not in your activity".
  // Then the bank's record of the person's own send by its id: Confirming until the bank knows the move was made.
  const [held, setHeld] = useState<
    { state: 'loading' } | { state: 'none' } | { state: 'failed' } | { state: 'held'; data: HeldSend } | { state: 'sent'; data: SentSend }
  >({
    state: 'loading',
  });
  const [heldTry, retryHeld] = useState(0);
  const pay = useMemo(() => createPersonalPayApi(api, userId), [api, userId]);
  useEffect(() => {
    if (!id) return setHeld({ state: 'none' });
    setHeld({ state: 'loading' });
    const controller = new AbortController();
    void (async () => {
      const result = await fetchHeldSend(api, id, controller.signal);
      if (controller.signal.aborted) return;
      if (result.ok) return setHeld({ state: 'held', data: result.data });
      if (result.code !== 'bank.held_send_not_found') return setHeld({ state: 'failed' });
      const sent = await fetchSentSend(api, id, controller.signal);
      if (controller.signal.aborted) return;
      if (!sent.ok) return setHeld(sent.code === SENT_NOT_FOUND ? { state: 'none' } : { state: 'failed' });
      setHeld({ state: 'sent', data: sent.data });
      // The send this device was still confirming is settled by the bank's own Completed for it, so Send stops waiting.
      if (sent.data.status === 'completed' && pay.unsettledSend() === id) await pay.settleSend(() => !controller.signal.aborted);
    })();
    return () => controller.abort();
  }, [api, id, userId, heldTry, pay]);
  const source = useMemo(() => createActivityFeed(api, { pageSize: 50 }), [api, userId]);
  const feed = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const item = feed.status === 'ready' && id ? (feed.data.items.find((row) => row.id === id || row.txId === id) ?? null) : null;
  const body =
    held.state === 'held' ? (
      <HeldStatus held={held.data} />
    ) : held.state === 'sent' ? (
      <SentStatus sent={held.data} checkAgain={() => retryHeld((n) => n + 1)} />
    ) : held.state === 'failed' ? (
      <ReadFailed title={t('paymentFailed')} retry={() => retryHeld((n) => n + 1)} />
    ) : held.state === 'loading' || feed.status === 'loading' ? (
      <div role="status" aria-busy="true" aria-label={t('paymentTitle')}>
        <Skeleton shape="rows" count={3} />
      </div>
    ) : feed.status === 'refused' ? (
      (() => {
        const words = refusalCopy(feed.code);
        return (
          <RefusalBox
            refusal={{ variant: 'refused', title: words.title, body: words.body, reference: words.reference, action: words.action }}
          />
        );
      })()
    ) : feed.status === 'error' ? (
      <ReadFailed title={t('paymentFailed')} retry={feed.retry} />
    ) : item ? (
      <>
        <KeyValue
          rows={[
            {
              label: t('requestAmount'),
              value: (
                <span lang="zxx">{`${item.direction === 'out' ? '−' : '+'}${fmtAmount(item.amount, { places: 18 })} ${item.asset}`}</span>
              ),
            },
            { label: t('requestMade'), value: <span lang="zxx">{stamp(item.postedAt, timeZone, Date.now())}</span> },
            { label: t('linkFrom'), value: item.counterparty ? `@${item.counterparty.handle}` : t('notSet'), unset: !item.counterparty },
            { label: t('reference'), value: <span lang="zxx">{item.txId}</span>, ltr: true },
          ]}
        />
        <div className="lt-actions">
          <a className="lt-button lt-button-secondary" href={`/money/activity/${encodeURIComponent(item.id)}`}>
            {t('paymentReceipt')}
          </a>
        </div>
        <p className="lt-hint">{t('paymentReceiptNote')}</p>
      </>
    ) : (
      <EmptyState
        title={t('paymentMissingTitle')}
        body={t('paymentMissingBody')}
        action={
          <a className="lt-button lt-button-primary" href="/money/activity?tab=transfers">
            {t('paymentActivity')}
          </a>
        }
      />
    );
  return (
    <Room
      title={t('paymentTitle')}
      line={t('paymentLine')}
      detail={
        <>
          {body}
          <div className="lt-actions">
            <Off>{t('paymentProblem')}</Off>
          </div>
          <Blocked slice={slice} body={t('paymentReason')} />
        </>
      }
    />
  );
}

function CasesRoom({ slice }: { slice: string }) {
  const { t } = roomsCopy.useCopy();
  return (
    <Room
      title={t('casesTitle')}
      line={t('casesLine')}
      list={
        <>
          <Section title={t('casesListTitle')} empty={t('casesEmpty')} off={t('casesOpen')} />
          <Blocked slice={slice} body={t('casesReason')} />
        </>
      }
    />
  );
}

function CaseRoom({ id, slice }: { id: string | null; slice: string }) {
  const { t } = roomsCopy.useCopy();
  const rows: KeyValueRow[] = [
    { label: t('reference'), value: id ?? t('notSet'), unset: id === null, ltr: id !== null },
    { label: t('caseStatus'), value: t('notSet'), unset: true },
  ];
  return (
    <Room
      title={t('caseTitle')}
      line={t('caseLine')}
      detail={
        <>
          <KeyValue rows={rows} />
          <Section title={t('caseMessages')} empty={t('caseMessagesEmpty')} off={t('caseReply')} />
          <Blocked slice={slice} body={t('casesReason')} />
        </>
      }
    />
  );
}

function InvoiceRoom({ id, slice }: { id: string | null; slice: string }) {
  const { t } = roomsCopy.useCopy();
  const rows: KeyValueRow[] = [
    { label: t('reference'), value: id ?? t('notSet'), unset: id === null, ltr: id !== null },
    { label: t('invoiceBiller'), value: t('notSet'), unset: true },
    { label: t('invoiceAmount'), value: t('notSet'), unset: true },
    { label: t('invoiceDue'), value: t('notSet'), unset: true },
  ];
  return (
    <Room
      title={t('invoiceTitle')}
      line={t('invoiceLine')}
      detail={
        <>
          <KeyValue rows={rows} />
          <Button tone="primary" size="lg" block disabled aria-describedby="pay-room-reason">
            {t('invoicePay')}
          </Button>
          <Blocked slice={slice} body={t('invoiceReason')} />
        </>
      }
    />
  );
}

/** One personal Pay room on the record-list template, picked by the matched address. */
export function PersonalRecordRoom({ match }: { match: PersonalRoomMatch }) {
  const { room, params } = match;
  const slice = room.slice;
  switch (room.id) {
    case 'scheduled':
      return <ScheduledRoom slice={slice} />;
    case 'cases':
      return <CasesRoom slice={slice} />;
    case 'case':
      return <CaseRoom id={decodedSegment(params.caseId)} slice={slice} />;
    case 'payment':
      return <PaymentRoom id={decodedSegment(params.transferId)} slice={slice} />;
    case 'invoice':
      return <InvoiceRoom id={decodedSegment(params.invoiceId)} slice={slice} />;
    default:
      return null;
  }
}
