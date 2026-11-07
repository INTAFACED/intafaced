import {
  QUANT_PAPER_LIST_MAX,
  quantPaperListSchema,
  quantPaperRunSchema,
  type QuantPaperRun,
  type QuantStrategyDetail,
} from '@intafaced/contracts/quant-algo';
import { useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, DataTable, EmptyState, Field, Loading } from '../../shared/ui';
import { Read, Select } from '../more/common';
import { useApi } from '../session/session';
import { paperCopy } from './paper-copy';
import { QuotaAwareFailure } from './quota-refusal';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
const utcText = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/**
 * A strategy's paper runs (AL-live-01): start one on the exchange's own prices, watch its fills, position and equity,
 * and stop it. Each start is keyed by the run count the dialog read when it opened, so a press after a lost reply reads
 * the same run instead of starting a second one.
 */
export function PaperRuns({ strategy }: { strategy: QuantStrategyDetail }) {
  const api = useApi();
  const { t } = paperCopy.useCopy();
  const [revision, setRevision] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  const list = useResource(
    (signal) =>
      api.query('quant', 'paper.list', { strategyId: strategy.id, limit: QUANT_PAPER_LIST_MAX }, quantPaperListSchema, { signal }),
    `quant-paper:${strategy.id}:${revision}`,
  );
  async function stop(runId: string) {
    if (busy) return;
    setBusy(runId);
    setFailure(null);
    const res = await api.mutate('quant', 'paper.stop', { runId }, quantPaperRunSchema);
    setBusy(null);
    if (!res.ok) return setFailure(res);
    setNote(t('stopped'));
    setRevision((n) => n + 1);
  }
  return (
    <section aria-label={t('title')} data-testid="quant-paper">
      <h3>{t('title')}</h3>
      <p className="muted">{t('label')}</p>
      <p className="muted">{t('intro')}</p>
      {note && (
        <p role="status" data-testid="quant-paper-note">
          {note}
        </p>
      )}
      <Read resource={list.resource} retry={list.reload}>
        {(data) => (
          <>
            {opening ? (
              <StartForm
                strategy={strategy}
                counts={data.counts}
                onCancel={() => setOpening(false)}
                onStarted={(run) => {
                  setOpening(false);
                  setNote(t('started', { version: run.strategyVersion }));
                  setShown(run.runId);
                  setRevision((n) => n + 1);
                }}
              />
            ) : (
              <Button
                onClick={() => {
                  setNote(null);
                  setOpening(true);
                }}
              >
                {t('start')}
              </Button>
            )}
            {failure && <QuotaAwareFailure result={failure} />}
            {data.runs.length === 0 ? (
              <EmptyState title={t('none')} />
            ) : (
              <DataTable label={t('title')} headers={[t('startedAt'), t('version'), t('state'), t('stoppedAt'), t('actions')]}>
                {data.runs.map((run) => (
                  <tr
                    key={run.runId}
                    data-testid="quant-paper-run"
                    data-run-id={run.runId}
                    data-state={run.state}
                    data-version={run.strategyVersion}
                  >
                    <td lang="zxx">{utcText(run.startedAt)}</td>
                    <td>{t('versionOf', { version: run.strategyVersion })}</td>
                    <td>{run.state === 'running' ? t('running') : t('stoppedState')}</td>
                    <td lang="zxx">{run.stoppedAt ? utcText(run.stoppedAt) : ''}</td>
                    <td>
                      <Button variant="secondary" onClick={() => setShown(shown === run.runId ? null : run.runId)}>
                        {t('open', { at: utcText(run.startedAt) })}
                      </Button>
                      {run.state === 'running' && (
                        <Button variant="secondary" onClick={() => void stop(run.runId)} disabled={busy !== null}>
                          {t('stop', { at: utcText(run.startedAt) })}
                        </Button>
                      )}
                      {busy === run.runId && <Loading label={t('stopping')} />}
                    </td>
                  </tr>
                ))}
              </DataTable>
            )}
            {shown && <PaperRunView key={`${shown}:${revision}`} runId={shown} />}
          </>
        )}
      </Read>
    </section>
  );
}

function StartForm(props: {
  strategy: QuantStrategyDetail;
  counts: readonly { strategyVersion: number; runs: number }[];
  onCancel: () => void;
  onStarted: (run: QuantPaperRun) => void;
}) {
  const api = useApi();
  const { t } = paperCopy.useCopy();
  const newest = Math.max(...props.strategy.versions.map((row) => row.version));
  const [version, setVersion] = useState(String(newest));
  const [cash, setCash] = useState('');
  const [feed, setFeed] = useState('own_venue');
  const [feeRole, setFeeRole] = useState('taker');
  const [slippage, setSlippage] = useState('');
  const [delay, setDelay] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed | null>(null);
  // The run count each version had when this dialog opened: the start's key, kept until it is confirmed or cancelled.
  const [ordinals] = useState(() => new Map(props.counts.map((row) => [row.strategyVersion, row.runs])));
  async function start() {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const chosen = Number(version);
    const res = await api.mutate(
      'quant',
      'paper.start',
      {
        strategyId: props.strategy.id,
        strategyVersion: chosen,
        cash,
        holdings: [],
        feed,
        costs: { feeRole, slippageBps: slippage, delayBars: delay },
        ordinal: ordinals.get(chosen) ?? 0,
      },
      quantPaperRunSchema,
    );
    setBusy(false);
    if (res.ok) props.onStarted(res.data);
    else setFailure(res);
  }
  const outside = feed !== 'own_venue';
  return (
    <form
      data-testid="quant-paper-start"
      aria-label={t('startTitle')}
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <Select
        label={t('version')}
        value={version}
        onChange={setVersion}
        options={[...props.strategy.versions]
          .sort((a, b) => b.version - a.version)
          .map((row) => ({ value: String(row.version), label: t('versionOf', { version: row.version }) }))}
      />
      <Field label={t('cash')} value={cash} onChange={(event) => setCash(event.currentTarget.value)} inputMode="decimal" />
      <p data-testid="quant-paper-holdings">
        <strong>{t('holdings')}:</strong> {t('holdingsNone')}
      </p>
      <Select
        label={t('feed')}
        value={feed}
        onChange={setFeed}
        options={[
          { value: 'own_venue', label: t('feedOwn') },
          { value: 'outside_market', label: t('feedOutside') },
        ]}
      />
      {outside && (
        <p role="status" data-testid="quant-paper-feed-notice">
          {t('feedOutsideNotice')}
        </p>
      )}
      <Select
        label={t('feeRole')}
        value={feeRole}
        onChange={setFeeRole}
        options={[
          { value: 'taker', label: t('feeTaker') },
          { value: 'maker', label: t('feeMaker') },
        ]}
      />
      <Field label={t('slippage')} value={slippage} onChange={(event) => setSlippage(event.currentTarget.value)} inputMode="decimal" />
      <Field label={t('delay')} value={delay} onChange={(event) => setDelay(event.currentTarget.value)} inputMode="numeric" />
      <Button type="submit" disabled={busy}>
        {t('go')}
      </Button>
      <Button type="button" variant="secondary" onClick={props.onCancel} disabled={busy}>
        {t('cancel')}
      </Button>
      {busy && <Loading label={t('starting')} />}
      {failure && <QuotaAwareFailure result={failure} retry={() => void start()} />}
    </form>
  );
}

function PaperRunView({ runId }: { runId: string }) {
  const api = useApi();
  const { t } = paperCopy.useCopy();
  const run = useResource(
    (signal) => api.query('quant', 'paper.get', { runId }, quantPaperRunSchema, { signal }),
    `quant-paper-run:${runId}`,
  );
  return (
    <Read resource={run.resource} retry={run.reload}>
      {(data) => (
        <div data-testid="quant-paper-view" data-run-id={data.runId} data-state={data.state} data-priced={String(data.priced)}>
          <p>
            <strong>{data.claimLabel}</strong>
          </p>
          {data.priced ? (
            <p lang="zxx">{t('pricedThrough', { at: utcText(data.pricedThrough ?? ''), symbol: data.symbol, barSize: data.barSize })}</p>
          ) : (
            <p role="status">{t('waiting')}</p>
          )}
          <p data-testid="quant-paper-position" data-qty={data.position.qty}>
            {t('position', { qty: data.position.qty, symbol: data.position.symbol })}
          </p>
          <p data-testid="quant-paper-equity" data-equity={data.totals.endEquity}>
            {t('equity', { equity: data.totals.endEquity, cash: data.totals.startCash })}
          </p>
          <h4>{t('fills')}</h4>
          {data.trades.length === 0 ? (
            <p className="muted">{t('noFills')}</p>
          ) : (
            <DataTable label={t('fills')} headers={[t('at'), t('side'), t('qty'), t('price'), t('fee')]}>
              {data.trades.map((trade, index) => (
                <tr key={`${trade.ts}:${index}`} data-testid="quant-paper-fill">
                  <td lang="zxx">{utcText(trade.ts)}</td>
                  <td>{trade.side === 'buy' ? t('buy') : t('sell')}</td>
                  <td lang="zxx">{trade.qty}</td>
                  <td lang="zxx">{trade.price}</td>
                  <td lang="zxx">{trade.fee}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>
      )}
    </Read>
  );
}
