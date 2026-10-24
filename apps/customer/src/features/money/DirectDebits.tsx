import { useState, type FormEvent } from 'react';
import { Button, Dialog, EmptyState, Failure, Loading } from '../../shared/ui';
import { useSession } from '../session/session';
import { amount, date, useBankRead } from './components';
import { directDebitWrites, type DirectDebitCollection, type DirectDebitMandate, type DirectDebitsView } from './contracts';
import { DepthPanel, DisabledActions } from './DepthParts';
import { directDebitsCopy } from './direct-debits-copy';
import './bank-depth.css';

/**
 * `/bank/direct-debits` (J-bank-06 #4, BK-xfer-11): the companies that may collect from the person's main balance, what
 * each will collect in the next month, and what each collected or tried to. A mandate can be blocked, and unblocked; a
 * collected debit can be asked back inside the guarantee period. With no scheme wired every control stays on the screen,
 * refused with `rail.bank`. On the test stack the mandates come from a labelled TEST stand-in.
 */

type Copy = ReturnType<typeof directDebitsCopy.useCopy>['t'];

type RefusalKey = 'refused_rail' | 'refused_notFound' | 'refused_window' | 'refused_guarantee' | 'refused_notCollected';
const refusalWords: Record<string, RefusalKey> = {
  'rail.bank': 'refused_rail',
  'bank.dd_mandate_not_found': 'refused_notFound',
  'bank.dd_collection_not_found': 'refused_notFound',
  'bank.dd_refund_window_closed': 'refused_window',
  'bank.dd_guarantee_unset': 'refused_guarantee',
  'bank.dd_refund_not_collected': 'refused_notCollected',
};

function refusal(t: Copy, answer: { code?: string; message: string }): string {
  const words = answer.code ? refusalWords[answer.code] : undefined;
  return words ? `${t(words)} ${t('reference', { code: answer.code! })}` : answer.message;
}

function reasonOf(t: Copy, code: string | null): string {
  switch (code) {
    case 'bank.insufficient_funds':
      return t('reason_insufficient');
    case 'bank.dd_mandate_blocked':
      return t('reason_blocked');
    case 'bank.dd_account_unavailable':
      return t('reason_account');
    case 'bank.space_locked':
      return t('reason_locked');
    default:
      return t('reason_other');
  }
}

function MandateTable({
  rows,
  live,
  onToggle,
}: {
  rows: readonly DirectDebitMandate[];
  live: boolean;
  onToggle: (row: DirectDebitMandate) => void;
}) {
  const { t } = directDebitsCopy.useCopy();
  return (
    <>
      <div className="withdrawal-address-scroll">
        <table className="bd-table" data-testid="dd-mandates">
          <thead>
            <tr>
              <th scope="col">{t('colCreditor')}</th>
              <th scope="col">{t('colReference')}</th>
              <th scope="col">{t('colState')}</th>
              <th scope="col">{t('colUpcoming')}</th>
              <th scope="col">{t('colActions')}</th>
            </tr>
          </thead>
          {rows.length > 0 && (
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid={`dd-mandate-${row.id}`}>
                  <td lang="und">{row.creditorName}</td>
                  <td lang="und">{row.reference}</td>
                  <td>{row.status === 'active' ? t('state_active') : t('state_blocked', { time: date(row.blockedAt) })}</td>
                  <td>
                    {row.upcoming.length === 0 ? (
                      t('noUpcoming')
                    ) : (
                      <ul className="bd-list">
                        {row.upcoming.map((c) => (
                          <li key={c.id}>{t('upcomingLine', { amount: amount(c.amount, c.assetId), time: date(c.dueAt) })}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td>
                    {live && (
                      <Button variant="secondary" onClick={() => onToggle(row)}>
                        {row.status === 'active' ? t('block') : t('unblock')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          )}
        </table>
      </div>
      {rows.length === 0 && <EmptyState title={t('emptyMandates')}>{t('emptyMandatesBody')}</EmptyState>}
    </>
  );
}

function RefundCell({ row, onRefund }: { row: DirectDebitCollection; onRefund: (row: DirectDebitCollection) => void }) {
  const { t } = directDebitsCopy.useCopy();
  switch (row.refund.state) {
    case 'available':
      return (
        <>
          <Button variant="secondary" onClick={() => onRefund(row)}>
            {t('refundAvailable')}
          </Button>{' '}
          <small className="muted">{t('refundUntil', { time: date(row.refund.endsAt) })}</small>
        </>
      );
    case 'requested':
      return <>{t('refundRequested', { time: date(row.refund.requestedAt) })}</>;
    case 'closed':
      return <>{t('refundClosed', { time: date(row.refund.endsAt) })}</>;
    case 'unset':
      return (
        <>
          {t('refundUnset')} <small className="muted">{t('reference', { code: 'bank.dd_guarantee_unset' })}</small>
        </>
      );
    default:
      return <>{t('refundNone')}</>;
  }
}

function CollectionTable({ rows, onRefund }: { rows: readonly DirectDebitCollection[]; onRefund: (row: DirectDebitCollection) => void }) {
  const { t } = directDebitsCopy.useCopy();
  return (
    <>
      <div className="withdrawal-address-scroll">
        <table className="bd-table" data-testid="dd-collections">
          <thead>
            <tr>
              <th scope="col">{t('colCreditor')}</th>
              <th scope="col">{t('colAmount')}</th>
              <th scope="col">{t('colDue')}</th>
              <th scope="col">{t('colStatus')}</th>
              <th scope="col">{t('colReason')}</th>
              <th scope="col">{t('colFee')}</th>
              <th scope="col">{t('colRefund')}</th>
            </tr>
          </thead>
          {rows.length > 0 && (
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid={`dd-collection-${row.collectionId}`}>
                  <td lang="und">{row.creditorName}</td>
                  <td className="numeric">{amount(row.amount, row.assetId)}</td>
                  <td>{date(row.dueAt)}</td>
                  <td>{t(`status_${row.status}`)}</td>
                  <td>
                    {row.failureCode ? (
                      <>
                        {reasonOf(t, row.failureCode)} <small className="muted">{t('reference', { code: row.failureCode })}</small>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    {row.failureFeeBlocker ? (
                      <>
                        {t('feeNotSet')} <small className="muted">{t('reference', { code: row.failureFeeBlocker })}</small>
                      </>
                    ) : (
                      t('feeNone')
                    )}
                  </td>
                  <td>
                    <RefundCell row={row} onRefund={onRefund} />
                  </td>
                </tr>
              ))}
            </tbody>
          )}
        </table>
      </div>
      {rows.length === 0 && <EmptyState title={t('emptyCollections')}>{t('emptyCollectionsBody')}</EmptyState>}
    </>
  );
}

function ToggleDialog({ row, onDone, onCancel }: { row: DirectDebitMandate; onDone: (words: string) => void; onCancel: () => void }) {
  const { t } = directDebitsCopy.useCopy();
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocking = row.status === 'active';
  async function confirm() {
    setBusy(true);
    setError(null);
    const input = { mandateId: row.id };
    if (blocking) {
      const answer = await api.mutate('bank', 'directDebits.block', input, directDebitWrites.block);
      setBusy(false);
      if (!answer.ok) return setError(refusal(t, answer));
      const late = answer.data.tooLate.map((one) => t('tooLate', { id: one.collectionId })).join(' ');
      return onDone(`${t('blocked', { creditor: row.creditorName, count: String(answer.data.rejected.length) })}${late ? ` ${late}` : ''}`);
    }
    const answer = await api.mutate('bank', 'directDebits.unblock', input, directDebitWrites.unblock);
    setBusy(false);
    if (!answer.ok) return setError(refusal(t, answer));
    return onDone(t('unblocked', { creditor: row.creditorName }));
  }
  return (
    <Dialog title={blocking ? t('blockConfirm') : t('unblockConfirm')} onClose={onCancel}>
      <p>{t(blocking ? 'blockWhy' : 'unblockWhy', { creditor: row.creditorName, reference: row.reference })}</p>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <div className="actions">
        <Button variant={blocking ? 'danger' : 'primary'} disabled={busy} onClick={() => void confirm()}>
          {blocking ? t('blockConfirm') : t('unblockConfirm')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </Dialog>
  );
}

function RefundDialog({ row, onDone, onCancel }: { row: DirectDebitCollection; onDone: (words: string) => void; onCancel: () => void }) {
  const { t } = directDebitsCopy.useCopy();
  const { api } = useSession();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bad = reason.trim().length < 1 || reason.trim().length > 500;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (bad) return;
    setBusy(true);
    setError(null);
    const answer = await api.mutate(
      'bank',
      'directDebits.requestRefund',
      { collectionId: row.id, reason: reason.trim() },
      directDebitWrites.requestRefund,
    );
    setBusy(false);
    if (!answer.ok) return setError(refusal(t, answer));
    onDone(answer.data.created ? t('refundSent', { amount: amount(row.amount, row.assetId) }) : t('refundAgain'));
  }
  return (
    <Dialog title={t('refundTitle')} onClose={onCancel}>
      <form className="bd-stack" onSubmit={(event) => void submit(event)} noValidate>
        <p>{t('refundLead', { amount: amount(row.amount, row.assetId), creditor: row.creditorName, time: date(row.settledAt) })}</p>
        <label className="field">
          <span>{t('refundReason')}</span>
          <textarea
            value={reason}
            maxLength={500}
            rows={3}
            onChange={(event) => setReason(event.target.value)}
            aria-invalid={tried && bad}
          />
          <small className={tried && bad ? 'error-text' : ''}>{tried && bad ? t('refundReasonBad') : t('refundReasonHint')}</small>
        </label>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <div className="actions">
          <Button type="submit" variant="primary" disabled={busy}>
            {t('refundSend')}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            {t('cancel')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function SchemeNotice({ scheme }: { scheme: DirectDebitsView['scheme'] }) {
  const { t } = directDebitsCopy.useCopy();
  return (
    <div className="bd-stack" data-testid="dd-scheme">
      {scheme.status === 'unset' ? (
        <p role="note">
          {t('schemeUnset', { rail: scheme.blocker ?? 'rail.bank' })}{' '}
          <small className="muted">{t('reference', { code: 'rail.bank' })}</small>
        </p>
      ) : (
        scheme.standIn && <p role="note">{t('schemeStandIn', { label: scheme.standIn })}</p>
      )}
      <p className="money-caption">
        {scheme.guaranteeDays === null ? t('guaranteeUnset') : t('guarantee', { days: String(scheme.guaranteeDays) })}
      </p>
    </div>
  );
}

export function DirectDebits() {
  const { t } = directDebitsCopy.useCopy();
  const list = useBankRead('directDebits.list', undefined);
  const [toggling, setToggling] = useState<DirectDebitMandate | null>(null);
  const [refunding, setRefunding] = useState<DirectDebitCollection | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (list.resource.status === 'loading') return <Loading />;
  if (list.resource.status === 'failed') return <Failure result={list.resource.failure} retry={list.reload} />;
  const view = list.resource.data;
  const live = view.scheme.status === 'live';
  const finish = (words: string) => {
    setDone(words);
    setToggling(null);
    setRefunding(null);
    list.reload();
  };
  return (
    <div className="bd-stack">
      <SchemeNotice scheme={view.scheme} />
      {done && <p role="status">{done}</p>}
      <DepthPanel title={t('mandatesTitle')} lead={t('mandatesLead')}>
        <MandateTable rows={view.mandates} live={live} onToggle={(row) => (setDone(null), setToggling(row))} />
        {!live && <DisabledActions labels={[t('block'), t('unblock')]} reason={t('schemeUnset', { rail: 'rail.bank' })} />}
      </DepthPanel>
      <DepthPanel title={t('collectionsTitle')} lead={t('collectionsLead')}>
        <CollectionTable rows={view.collections} onRefund={(row) => (setDone(null), setRefunding(row))} />
        {!live && <DisabledActions labels={[t('refundAvailable')]} reason={t('schemeUnset', { rail: 'rail.bank' })} />}
      </DepthPanel>
      {toggling && <ToggleDialog row={toggling} onDone={finish} onCancel={() => setToggling(null)} />}
      {refunding && <RefundDialog row={refunding} onDone={finish} onCancel={() => setRefunding(null)} />}
      <p>
        <a className="text-link" href="/bank/transfers">
          {t('back')}
        </a>
      </p>
    </div>
  );
}
