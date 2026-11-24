import { useRef, useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session';
import { defaultDeskPair } from '../../../app/navigation';
import { BusySheet } from '../../../screens/trade/futures/close-all/CloseAllDialog';
import { readStatusFeed } from '../../../shared/notify-reads';
import { Section, Waiting } from '../../more';
import { openIncidents, type CancelEverythingVerdict } from './risk-model';
import { riskCopy } from './risk-copy';

// The parts the Risk room draws the same on the venue and on our own book.

export type T = ReturnType<typeof riskCopy.useCopy>['t'];

/** The words of a refused cancel: who said no, and that nothing was cancelled. */
function refusedText(t: T, verdict: Extract<CancelEverythingVerdict, { kind: 'refused' }>): string {
  switch (verdict.reason) {
    case 'wallet_rejected':
      return t('cancelWalletRejected');
    case 'waiting':
      return t('cancelWaiting');
    case 'wallet_failed':
      return t('cancelWalletFailed', { detail: verdict.detail });
    case 'no_batch':
      return t('cancelNoBatch');
    case 'venue':
      return t('cancelRefused', { detail: verdict.detail });
  }
}

/**
 * Asked first, then one request; the answer in words. `hidden` steps the sheet aside, its state kept, while a wallet asks
 * (the wallet's own "Check before you sign" sheet renders in the page).
 */
export function CancelEverything({
  count,
  onSend,
  onDone,
  t,
  hidden = false,
}: {
  count: number;
  onSend: () => Promise<CancelEverythingVerdict>;
  onDone: () => void;
  t: T;
  hidden?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [verdict, setVerdict] = useState<CancelEverythingVerdict | null>(null);
  async function confirm() {
    // One request per confirm, and never a second while the first has no answer.
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setVerdict(await onSend());
    busyRef.current = false;
    setBusy(false);
    onDone();
  }
  function close() {
    if (busyRef.current) return;
    setOpen(false);
    setVerdict(null);
  }
  const note =
    verdict === null
      ? null
      : verdict.kind === 'done'
        ? { tone: 'good', text: t('cancelDone', { count: String(verdict.cancelled) }) }
        : verdict.kind === 'partial'
          ? { tone: 'bad', text: t('cancelPartial', { count: String(verdict.cancelled), left: String(verdict.left) }) }
          : verdict.kind === 'refused'
            ? { tone: 'bad', text: refusedText(t, verdict) }
            : { tone: 'bad', text: t('cancelUncertain') };
  const good = note?.tone === 'good';
  return (
    <>
      <Button tone="secondary" disabled={count === 0} onClick={() => setOpen(true)}>
        {t('cancelButton')}
      </Button>
      {open && !hidden ? (
        <BusySheet title={t('cancelTitle')} busy={busy} onClose={close}>
          <div className="lt-stack">
            <p className="lt-hint">{count === 1 ? t('cancelIntroOne') : t('cancelIntro', { count: String(count) })}</p>
            {note ? (
              <p className={good ? undefined : 'lt-refusal'} role={good ? 'status' : 'alert'}>
                {note.text}
              </p>
            ) : null}
            <div className="lt-actions" data-testid="risk-cancel-actions">
              <Button tone="secondary" disabled={busy} onClick={close}>
                {verdict ? t('cancelClose') : t('cancelKeep')}
              </Button>
              {verdict ? null : (
                <Button tone="primary" aria-busy={busy || undefined} disabled={busy} onClick={() => void confirm()}>
                  {t('cancelConfirm')}
                </Button>
              )}
            </div>
          </div>
        </BusySheet>
      ) : null}
    </>
  );
}

/** Alerts, Approvals and Platform incidents: the same on the venue and on our own book. */
export function OtherSections({ t }: { t: T }) {
  return (
    <>
      <Section title={t('alertsHeading')}>
        <p>{t('alertsLead')}</p>
        <div className="lt-actions">
          <a className="lt-link" href="/notifications">
            {t('alertsOpenNotifications')}
          </a>
          <a className="lt-link" href={`/trade/spot/${defaultDeskPair}`}>
            {t('alertsOpenChart')}
          </a>
        </div>
      </Section>
      <Section title={t('approvalsHeading')}>
        <p>{t('approvalsBlocker')}</p>
        <p className="lt-hint">
          {t('codeLabel')}: <code>{t('approvalsCode')}</code>
        </p>
        <Button tone="secondary" disabled>
          {t('approvalsButton')}
        </Button>
      </Section>
      <Section title={t('incidentsHeading')}>
        <Incidents t={t} />
      </Section>
    </>
  );
}

function Incidents({ t }: { t: T }) {
  const { api } = useSession();
  const { resource, reload } = useResource((signal) => readStatusFeed(api, signal), 'risk-incidents');
  if (resource.status === 'loading') return <Waiting label={t('incidentsLoading')} />;
  if (resource.status === 'failed')
    return (
      <div role="alert">
        <p>{t('incidentsFailed')}</p>
        <p className="lt-hint">
          {t('codeLabel')}: <code>{t('incidentsFailedCode')}</code>
        </p>
        <Button tone="secondary" onClick={reload}>
          {t('retry')}
        </Button>
      </div>
    );
  const incidents = openIncidents(resource.data);
  return incidents.length === 0 ? (
    <p>{t('incidentsNone')}</p>
  ) : (
    <>
      <ul className="lt-rows">
        {incidents.map((incident) => (
          <li key={incident.id}>
            <strong>{incident.title}</strong>
            <span className="lt-hint"> · {t('incidentsOpen', { since: incident.openedAt })}</span>
          </li>
        ))}
      </ul>
      <a className="lt-link" href="/developers/status">
        {t('incidentsOpenPage')}
      </a>
    </>
  );
}
