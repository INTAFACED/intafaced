import { type QuantReport, type QuantShareCreated, type QuantShareState } from '@intafaced/contracts/quant-algo';
import {
  QUANT_BACKTEST_REPORT,
  QUANT_RESULT_SHARE_CREATE,
  QUANT_RESULT_SHARE_GET,
  QUANT_RESULT_SHARE_REVOKE,
} from '@intafaced/contracts/quant-result-share-procedures';
import { type Dispatch, type SetStateAction, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button } from '@intafaced/ui/lit';
import { Read } from '../more';
import { useApi } from '../session';
import { reportCopy } from './report-copy';
import { KitFailure, KitLoading, KitTable } from './kit-parts';
import { quantCode } from './result-words';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** The share refusals this room words itself; any other answer goes to the shared refusal catalogue. */
const SHARE_REFUSALS: Readonly<Record<string, 'shareRateUnset' | 'shareWindowUnset'>> = {
  'quant.share_rate_unset': 'shareRateUnset',
  'quant.share_window_unset': 'shareWindowUnset',
};

/**
 * The printable report of one stored run (AL-report-03): the six sections the service builds from the stored run on
 * each read, under the simulation label. Print opens the browser's print window, which also saves a PDF.
 */
export function ReportTab({ runId }: { runId: string }) {
  const api = useApi();
  const { t } = reportCopy.useCopy();
  const report = useResource((signal) => api.call(QUANT_BACKTEST_REPORT, { runId }, { signal }), `quant-report:${runId}`);
  return (
    <div data-testid="quant-report">
      <h4>{t('reportTitle')}</h4>
      <p className="lt-hint lt-no-print">{t('reportIntro')}</p>
      {report.resource.status === 'loading' ? (
        <KitLoading label={t('reportLoading')} />
      ) : (
        <Read resource={report.resource} retry={report.reload}>
          {(data) => <ReportDocument report={data} />}
        </Read>
      )}
    </div>
  );
}

function ReportDocument({ report }: { report: QuantReport }) {
  const { t } = reportCopy.useCopy();
  return (
    <article className="lt-print-alone lt-stack" data-testid="quant-report-document" data-run-id={report.runId}>
      <p className="lt-no-print">
        <Button tone="primary" onClick={() => window.print()} data-testid="quant-report-print">
          {t('print')}
        </Button>
      </p>
      <p role="note" data-testid="quant-report-claim" data-simulated={String(report.simulated)} data-live={String(report.live)}>
        {report.claimLabel}
      </p>
      {report.sections.map((section) => (
        <section key={section.id} aria-label={t(`section_${section.id}`)} data-testid={`quant-report-section-${section.id}`}>
          <h5>{t(`section_${section.id}`)}</h5>
          <KitTable label={t(`section_${section.id}`)} headers={[t('rowName'), t('rowValue')]}>
            {section.rows.map((row, i) => (
              <tr key={`${row.name}:${i}`} data-testid="quant-report-row" data-name={row.name}>
                <th scope="row">{row.name}</th>
                <td>{row.value}</td>
              </tr>
            ))}
          </KitTable>
        </section>
      ))}
    </article>
  );
}

/** The once-only link a create returned, kept by the result above the tabs so moving between tabs does not lose it. */
export type CreatedShare = [QuantShareCreated | null, Dispatch<SetStateAction<QuantShareCreated | null>>];

/**
 * Share one stored run by link or embed (AL-report-03). Create sends the link count the service last read as `seq`,
 * so a press after a lost reply stores no second link; the address is shown only by the call that stored it. Revoke
 * stops the link opening. A blank read limit refuses by name; a blank frame list refuses only the embed code.
 */
export function ShareTab({ runId, created: [created, setCreated] }: { runId: string; created: CreatedShare }) {
  const api = useApi();
  const { t } = reportCopy.useCopy();
  const state = useResource((signal) => api.call(QUANT_RESULT_SHARE_GET, { runId }, { signal }), `quant-share:${runId}`);
  const [busy, setBusy] = useState<'create' | 'revoke' | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  const [revoked, setRevoked] = useState(false);

  async function create(current: QuantShareState) {
    if (busy) return;
    setBusy('create');
    setFailure(null);
    setRevoked(false);
    const res = await api.call(QUANT_RESULT_SHARE_CREATE, { runId, seq: current.links });
    setBusy(null);
    if (res.ok) setCreated(res.data);
    else setFailure(res);
    state.reload();
  }

  async function revoke() {
    if (busy) return;
    setBusy('revoke');
    setFailure(null);
    const res = await api.call(QUANT_RESULT_SHARE_REVOKE, { runId });
    setBusy(null);
    if (res.ok) {
      setCreated(null);
      setRevoked(true);
    } else setFailure(res);
    state.reload();
  }

  const refusal = (failed: Failed) => {
    const code = quantCode(failed);
    const own = code ? SHARE_REFUSALS[code] : undefined;
    return own ? (
      <p role="alert" data-testid="quant-share-refusal" data-code={code}>
        {t(own)}
      </p>
    ) : (
      <KitFailure result={failed} retry={state.reload} />
    );
  };

  return (
    <div data-testid="quant-share">
      <h4>{t('shareTitle')}</h4>
      <p className="lt-hint">{t('shareIntro')}</p>
      {state.resource.status === 'loading' && <KitLoading label={t('shareLoading')} />}
      {state.resource.status === 'failed' && refusal(state.resource.failure)}
      {state.resource.status === 'ready' && (
        <ShareState
          state={state.resource.data}
          busy={busy !== null}
          onCreate={(current) => void create(current)}
          onRevoke={() => void revoke()}
        />
      )}
      {busy && <KitLoading label={busy === 'create' ? t('creating') : t('revoking')} />}
      {revoked && (
        <p role="status" data-testid="quant-share-revoked">
          {t('revoked')}
        </p>
      )}
      {failure && refusal(failure)}
      {created && <CreatedLink created={created} />}
    </div>
  );
}

function ShareState(props: { state: QuantShareState; busy: boolean; onCreate: (state: QuantShareState) => void; onRevoke: () => void }) {
  const { t } = reportCopy.useCopy();
  const { state } = props;
  return (
    <div data-testid="quant-share-state" data-active={String(state.active)} data-links={state.links}>
      <p>{state.active ? t('shareActive') : t('shareNone')}</p>
      <p className="lt-hint">{t('shareCount', { count: state.links })}</p>
      {state.active ? (
        <Button tone="primary" onClick={props.onRevoke} disabled={props.busy} data-testid="quant-share-revoke">
          {t('revoke')}
        </Button>
      ) : (
        <Button tone="primary" onClick={() => props.onCreate(state)} disabled={props.busy} data-testid="quant-share-create">
          {t('create')}
        </Button>
      )}
    </div>
  );
}

/** The service's snippet frames a path on this site; another site needs the full address. */
function absoluteSnippet(snippet: string): string {
  return snippet.replace(/src="(\/[^"]*)"/, (_, path: string) => `src="${new URL(path, location.origin).toString()}"`);
}

function CreatedLink({ created }: { created: QuantShareCreated }) {
  const { t } = reportCopy.useCopy();
  if (!created.path) {
    return (
      <p role="note" data-testid="quant-share-link-lost">
        {t('linkLost')}
      </p>
    );
  }
  const url = new URL(created.path, location.origin).toString();
  return (
    <div data-testid="quant-share-created">
      <label>
        {t('linkLabel')}
        <input readOnly value={url} data-testid="quant-share-link" onFocus={(event) => event.currentTarget.select()} />
      </label>
      <p role="note" className="lt-hint">
        {t('linkOnce')}
      </p>
      {created.embed ? (
        <div data-testid="quant-share-embed">
          <label>
            {t('embedLabel')}
            <textarea readOnly rows={3} value={absoluteSnippet(created.embed.snippet)} data-testid="quant-share-embed-code" />
          </label>
          <p className="lt-hint">{t('embedOrigins', { origins: created.embed.origins.join(', ') })}</p>
          <p role="note" data-testid="quant-share-embed-blocked">
            {t('embedFramePolicy')}
          </p>
        </div>
      ) : (
        <p role="note" data-testid="quant-share-embed-refusal" data-code={created.embedRefusal ?? ''}>
          {t('embedUnset')}
        </p>
      )}
    </div>
  );
}
