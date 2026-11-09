import { useMemo, useState, type FormEvent } from 'react';
import {
  ADDRESS_REPORT_EVIDENCE_MAX,
  ADDRESS_REPORT_KINDS,
  ADDRESS_REPORT_NOTE_MAX,
  type AddressReportKind,
} from '@intafaced/contracts/protocol-address-risk';
import type { ProtocolAddressRisk } from '@intafaced/contracts/protocol-address-risk';
import { safeReturnTo } from '../../../app/navigation';
import { Button, Dialog, Failure, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { useApi, useSession } from '../../session/session';
import { createProtocolApi } from '../api';
import { riskCopy } from './risk-copy';

type Api = Pick<ReturnType<typeof createProtocolApi>, 'addressRisk' | 'reportAddress'>;

/**
 * The risk card on an address page (D-developer-compliance-01): the highest reputation among the published labels, each
 * label with its reason, the open-report count (a count only) and the screening state. With no screening list connected
 * it says the list is not loaded, never that the address is clear. A signed-in person can report the address once.
 */
export function AddressRisk({ address }: { address: string }) {
  const { language } = usePreferences();
  const { t } = riskCopy.forLocale(language);
  const { userId } = useSession();
  const transport = useApi();
  const api = useMemo(() => createProtocolApi(transport), [transport]);
  const { resource, reload } = useResource((signal) => api.addressRisk(address, signal), `address-risk:${address.toLowerCase()}`);
  const [open, setOpen] = useState(false);
  const [thanks, setThanks] = useState(false);
  // After a report the count is read again quietly: the card keeps showing what it had until the new read lands.
  const [fresh, setFresh] = useState<ProtocolAddressRisk | null>(null);
  const risk = fresh ?? (resource.status === 'ready' ? resource.data : null);
  return (
    <section aria-label={t('title')}>
      <Panel title={t('title')}>
        {resource.status === 'loading' && <p role="status">{t('reading')}</p>}
        {resource.status === 'failed' && <Failure result={resource.failure} retry={reload} />}
        {risk && (
          <>
            <p data-reputation={risk.reputation}>
              <strong>{t('reputation', { level: t(`rep_${risk.reputation}`) })}</strong>
            </p>
            {risk.labels.length === 0 ? (
              <p className="muted">{t('noLabels')}</p>
            ) : (
              <ul>
                {risk.labels.map((label) => (
                  <li key={label.kind}>
                    {t('label', { value: label.value, kind: t(`kind_${label.kind}`), reason: label.reason })}{' '}
                    {label.evidenceUrl && /^https?:\/\//.test(label.evidenceUrl) && (
                      <a href={label.evidenceUrl} rel="noreferrer noopener" target="_blank">
                        {t('evidence')}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p>
              {risk.openReports === 0
                ? t('reportsNone')
                : risk.openReports === 1
                  ? t('reportsOne')
                  : t('reportsMany', { count: String(risk.openReports) })}{' '}
              <span className="muted">{t('reportsNote')}</span>
            </p>
            <p data-code={risk.screening.code ?? undefined}>
              {risk.screening.status === 'not_loaded' ? t('screeningNotLoaded') : t('screeningLoaded')}
            </p>
            <p className="muted">{t('verdict')}</p>
          </>
        )}
        {userId ? (
          <Button variant="secondary" onClick={() => setOpen(true)}>
            {t('report')}
          </Button>
        ) : (
          <p>
            {t('reportSignIn')}{' '}
            <a href={`/login?redirect=${encodeURIComponent(safeReturnTo(`/chain/address/${address}`))}`}>{t('signIn')}</a>
          </p>
        )}
        {thanks && <p role="status">{t('received')}</p>}
        {open && (
          <ReportDialog
            address={address}
            api={api}
            onClose={() => setOpen(false)}
            onSent={() => {
              setOpen(false);
              setThanks(true);
              void api.addressRisk(address).then((next) => {
                if (next.ok) setFresh(next.data);
              });
            }}
          />
        )}
      </Panel>
    </section>
  );
}

export function ReportDialog({ address, api, onClose, onSent }: { address: string; api: Api; onClose: () => void; onSent: () => void }) {
  const { language } = usePreferences();
  const { t } = riskCopy.forLocale(language);
  const [kind, setKind] = useState<AddressReportKind>('scam');
  const [evidence, setEvidence] = useState('');
  const [note, setNote] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'duplicate' | 'evidence' | 'failed'>('idle');
  async function send(event: FormEvent) {
    event.preventDefault();
    setState('sending');
    let result: Awaited<ReturnType<Api['reportAddress']>>;
    try {
      result = await api.reportAddress({
        address,
        kind,
        ...(evidence.trim() ? { evidenceUrl: evidence.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
    } catch {
      return setState('failed');
    }
    if (result.ok) return onSent();
    const code = result.code ?? result.message;
    setState(
      code.startsWith('protocol.reports.duplicate')
        ? 'duplicate'
        : code.startsWith('protocol.reports.evidence_invalid')
          ? 'evidence'
          : 'failed',
    );
  }
  return (
    <Dialog title={t('report')} onClose={onClose}>
      <form className="protocol-quote" onSubmit={send}>
        <label>
          <span>{t('reason')}</span>
          <select value={kind} onChange={(event) => setKind(event.target.value as AddressReportKind)}>
            {ADDRESS_REPORT_KINDS.map((option) => (
              <option key={option} value={option}>
                {t(`reason_${option}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('evidenceLabel')}</span>
          <input
            type="url"
            value={evidence}
            maxLength={ADDRESS_REPORT_EVIDENCE_MAX}
            onChange={(event) => setEvidence(event.target.value)}
          />
        </label>
        <label>
          <span>{t('noteLabel')}</span>
          <textarea value={note} maxLength={ADDRESS_REPORT_NOTE_MAX} onChange={(event) => setNote(event.target.value)} />
        </label>
        <small className="muted">{t('noteHint')}</small>
        {state === 'duplicate' && <p role="alert">{t('duplicate')}</p>}
        {state === 'evidence' && <p role="alert">{t('evidenceInvalid')}</p>}
        {state === 'failed' && <p role="alert">{t('failed')}</p>}
        <div className="actions">
          <Button type="submit" disabled={state === 'sending'}>
            {state === 'sending' ? t('sending') : t('send')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
