import { quantPaperListSchema, quantPaperRunSchema } from '@intafaced/contracts/quant-algo';
import { quantSharedListSchema, quantSharedOpenSchema, type QuantSharedOpen } from '@intafaced/contracts/quant-team';
import { useState } from 'react';
import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, DataTable, EmptyState, Failure, Field, Panel } from '../../shared/ui';
import { Read, Select, TextArea } from '../more/common';
import { preservePaperHref } from '../more/trade-context';
import { useApi } from '../session/session';
import { QuantRooms } from './QuantRooms';
import { QuotaAwareFailure } from './quota-refusal';
import { EditLock, lockedUntil, refusalCode, useLastReady } from './StrategyTeam';
import { teamCopy } from './team-copy';
import './algo.css';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
const utcText = (iso: string) => iso.slice(0, 19).replace('T', ' ');

/** Strategies other people shared with the caller (AL-team-01), and the caller's own account id to be added by. */
export function SharedRoom({ paper }: { paper: boolean }) {
  const api = useApi();
  const { t } = teamCopy.useCopy();
  const list = useResource((signal) => api.query('quant', 'team.shared', {}, quantSharedListSchema, { signal }), 'quant-shared');
  return (
    <>
      <QuantRooms active="strategies" paper={paper} />
      <Panel title={t('sharedTitle')}>
        <div data-testid="quant-shared">
          <p className="muted">{t('sharedIntro')}</p>
          <Read resource={list.resource} retry={list.reload}>
            {(data) => (
              <>
                <p data-testid="quant-my-account-id" data-id={data.accountId}>
                  {t('yourId', { id: data.accountId })}
                </p>
                <p className="muted">{t('yourIdHint')}</p>
                {data.strategies.length === 0 ? (
                  <EmptyState title={t('noShared')} />
                ) : (
                  <DataTable label={t('sharedTitle')} headers={[t('name'), t('version'), t('permission'), t('owner'), '']}>
                    {data.strategies.map((row) => (
                      <tr key={row.strategyId} data-testid="quant-shared-row" data-id={row.strategyId} data-role={row.role}>
                        <td lang="und">{row.name}</td>
                        <td>{t('versionOf', { version: row.version })}</td>
                        <td>{t(row.role)}</td>
                        <td lang="zxx">{row.ownerId}</td>
                        <td>
                          <a className="text-link" href={preservePaperHref(`/quant/shared/${encodeURIComponent(row.strategyId)}`, paper)}>
                            {t('open', { name: row.name })}
                          </a>
                        </td>
                      </tr>
                    ))}
                  </DataTable>
                )}
              </>
            )}
          </Read>
        </div>
      </Panel>
    </>
  );
}

/** One strategy shared with the caller: its source, the edit lock, a save under their permission, and the owner's paper runs. */
export function SharedStrategy({ strategyId, paper }: { strategyId: string; paper: boolean }) {
  const api = useApi();
  const { t } = teamCopy.useCopy();
  const [revision, setRevision] = useState(0);
  const opened = useResource(
    (signal) => api.query('quant', 'team.open', { strategyId }, quantSharedOpenSchema, { signal }),
    `quant-shared:${strategyId}:${revision}`,
  );
  const reload = () => setRevision((n) => n + 1);
  const kept = useLastReady(opened.resource);
  return (
    <>
      <QuantRooms active="strategies" paper={paper} />
      <p>
        <a className="text-link" href={preservePaperHref('/quant/shared', paper)}>
          {t('back')}
        </a>
      </p>
      {opened.resource.status === 'failed' && refusalCode(opened.resource.failure) === 'quant.studio_not_found' ? (
        <p role="alert" data-testid="quant-shared-gone">
          {t('gone')}
        </p>
      ) : (
        <Read resource={kept ? { status: 'ready', data: kept } : opened.resource} retry={opened.reload}>
          {(data) => (
            <Panel title={t('sharedStrategyTitle', { name: data.name })}>
              <div data-testid="quant-shared-strategy" data-id={data.strategyId} data-role={data.role} data-version={data.version}>
                <p>
                  {t('sharedAs', {
                    owner: data.ownerId,
                    permission: t(data.role),
                    live: data.liveControl ? t('liveYes') : t('liveNo'),
                  })}
                </p>
                <h4>{t('source', { version: data.version })}</h4>
                <pre lang="zxx" className="quant-source" tabIndex={0} data-testid="quant-shared-source">
                  {data.source}
                </pre>
                {data.role === 'edit' && <EditLock strategyId={data.strategyId} lock={data.lock} onChange={reload} />}
                <SharedSave data={data} onSaved={reload} />
                <OwnerRuns strategyId={data.strategyId} />
              </div>
            </Panel>
          )}
        </Read>
      )}
    </>
  );
}

function SharedSave({ data, onSaved }: { data: QuantSharedOpen; onSaved: () => void }) {
  const api = useApi();
  const { t } = teamCopy.useCopy();
  const [name, setName] = useState(data.name);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ code: string; text: string } | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  async function save() {
    if (busy) return;
    setBusy(true);
    setDone(null);
    setRefused(null);
    setFailure(null);
    const res = await api.mutate(
      'quant',
      'team.save',
      { strategyId: data.strategyId, baseVersion: data.version, name, ...(note.trim() ? { releaseNote: note } : {}) },
      quantSharedOpenSchema,
    );
    setBusy(false);
    if (res.ok) {
      setDone(t('saved', { version: res.data.version }));
      setNote('');
      onSaved();
      return;
    }
    const code = refusalCode(res);
    if (code === 'quant.permission_denied') setRefused({ code, text: t('viewOnly') });
    else if (code === 'quant.edit_locked') setRefused({ code, text: t('lockRefused', { until: utcText(lockedUntil(res)) }) });
    else if (code === 'quant.edit_lock_unset') setRefused({ code, text: t('lockUnset') });
    else setFailure(res);
  }
  return (
    <form
      data-testid="quant-shared-save"
      aria-label={t('saveTitle')}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h4>{t('saveTitle')}</h4>
      <Field label={t('saveName')} value={name} onChange={(event) => setName(event.currentTarget.value)} />
      <TextArea label={t('saveNote')} value={note} onChange={setNote} maxLength={2000} />
      <Button type="submit" disabled={busy}>
        {t('save')}
      </Button>
      {done && (
        <p role="status" data-testid="quant-shared-saved">
          {done}
        </p>
      )}
      {refused && (
        <p role="alert" data-testid="quant-shared-refusal" data-code={refused.code}>
          {refused.text}
        </p>
      )}
      {failure && <QuotaAwareFailure result={failure} />}
    </form>
  );
}

function OwnerRuns({ strategyId }: { strategyId: string }) {
  const api = useApi();
  const { t } = teamCopy.useCopy();
  const [revision, setRevision] = useState(0);
  const runs = useResource(
    (signal) => api.query('quant', 'team.paperRuns', { strategyId }, quantPaperListSchema, { signal }),
    `quant-shared-runs:${strategyId}:${revision}`,
  );
  const [note, setNote] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  async function stop(runId: string) {
    setNote(null);
    setRefused(null);
    setFailure(null);
    const res = await api.mutate('quant', 'team.stop', { strategyId, runId }, quantPaperRunSchema);
    if (res.ok) {
      setNote(t('stoppedNote'));
      setRevision((n) => n + 1);
      return;
    }
    if (refusalCode(res) === 'quant.permission_denied') setRefused(t('noLiveControl'));
    else setFailure(res);
  }
  return (
    <section aria-label={t('runsTitle')} data-testid="quant-shared-runs">
      <h4>{t('runsTitle')}</h4>
      <Read resource={runs.resource} retry={runs.reload}>
        {(data) =>
          data.runs.length === 0 ? (
            <EmptyState title={t('noRuns')} />
          ) : (
            <DataTable label={t('runsTitle')} headers={[t('started'), t('version'), t('runState'), '']}>
              {data.runs.map((row) => (
                <tr key={row.runId} data-testid="quant-shared-run" data-run-id={row.runId} data-state={row.state}>
                  <td lang="zxx">{utcText(row.startedAt)}</td>
                  <td>{t('versionOf', { version: row.strategyVersion })}</td>
                  <td>{row.state === 'running' ? t('running') : t('stopped')}</td>
                  <td>
                    {row.state === 'running' && (
                      <Button variant="danger" onClick={() => void stop(row.runId)}>
                        {t('stop', { run: row.runId.slice(0, 8) })}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
          )
        }
      </Read>
      <Read resource={runs.resource} retry={runs.reload}>
        {(data) => {
          const running = data.runs.filter((row) => row.state === 'running');
          return running.length ? <SharedManualOrder strategyId={strategyId} runIds={running.map((row) => row.runId)} /> : null;
        }}
      </Read>
      {note && (
        <p role="status" data-testid="quant-shared-run-note">
          {note}
        </p>
      )}
      {refused && (
        <p role="alert" data-testid="quant-shared-run-refusal" data-code="quant.permission_denied">
          {refused}
        </p>
      )}
      {failure && <Failure result={failure} />}
    </section>
  );
}

/**
 * A manual order to one of the owner's running paper runs. Without live control it is refused as permission denied; with
 * it, refused by name, since a paper run trades only by its own rules. Nothing is ever sent.
 */
function SharedManualOrder({ strategyId, runIds }: { strategyId: string; runIds: string[] }) {
  const api = useApi();
  const { t } = teamCopy.useCopy();
  const [runId, setRunId] = useState(runIds[0] ?? '');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [size, setSize] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ code: string; text: string } | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  const chosen = runIds.includes(runId) ? runId : (runIds[0] ?? '');
  async function send() {
    if (busy) return;
    setBusy(true);
    setRefused(null);
    setFailure(null);
    const res = await api.mutate('quant', 'team.order', { strategyId, runId: chosen, side, size: size.trim() }, z.never());
    setBusy(false);
    if (res.ok) return;
    const code = refusalCode(res);
    if (code === 'quant.permission_denied') setRefused({ code, text: t('orderNoLiveControl') });
    else if (code === 'quant.paper_manual_order_unsupported') setRefused({ code, text: t('orderPaperOnly') });
    else setFailure(res);
  }
  return (
    <form
      data-testid="quant-shared-order"
      aria-label={t('orderTitle')}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <h4>{t('orderTitle')}</h4>
      <p className="muted">{t('orderIntro')}</p>
      <Select
        label={t('orderRun')}
        value={chosen}
        onChange={setRunId}
        options={runIds.map((id) => ({ value: id, label: t('orderRunOf', { run: id.slice(0, 8) }) }))}
      />
      <Select
        label={t('orderSide')}
        value={side}
        onChange={(v) => setSide(v as 'buy' | 'sell')}
        options={[
          { value: 'buy', label: t('orderBuy') },
          { value: 'sell', label: t('orderSell') },
        ]}
      />
      <Field label={t('orderSize')} inputMode="decimal" value={size} onChange={(event) => setSize(event.currentTarget.value)} />
      <Button type="submit" disabled={busy}>
        {t('orderSend')}
      </Button>
      {refused && (
        <p role="alert" data-testid="quant-shared-order-refusal" data-code={refused.code}>
          {refused.text}
        </p>
      )}
      {failure && <Failure result={failure} />}
    </form>
  );
}
