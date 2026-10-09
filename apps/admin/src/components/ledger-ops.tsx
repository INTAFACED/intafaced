'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Panel } from '@intafaced/ui';
import { consoleCopy } from '@/lib/console-copy';
import type { AuthorityStatus } from '@/lib/console-status';
import { fetchFreeze, type FreezeResult } from '@/lib/ledger-freeze-browser';
import { decodeFreezeState, freezeUnavailable } from '@/lib/ledger-freeze-contract';
import { ledgerCopy, type LedgerLocale } from '@/lib/ledger-ops-copy';
import { reconcileLedger, SIMULATED_NOTICE, type ReconcileReport, type SimulatedResult } from '@/lib/operator-commands';
import './ledger-ops.css';

export const FREEZE_CONFIRM_PHRASE = 'FREEZE LEDGER';
export const UNFREEZE_CONFIRM_PHRASE = 'UNFREEZE LEDGER';
export interface LedgerOpsProps {
  treasury: AuthorityStatus;
  initialFreeze: FreezeResult;
}

/** Read-only desk. The deployment transport is distinct from human action authority. */
export function LedgerOps({ treasury, initialFreeze }: LedgerOpsProps) {
  const [freeze, setRead] = useState(initialFreeze);
  const [reconcile, setReconcile] = useState<SimulatedResult<ReconcileReport> | null>(null);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const read = useCallback(async () => {
    const request = ++sequence.current;
    controller.current?.abort();
    const own = new AbortController();
    controller.current = own;
    setRead(freezeUnavailable('loading', 'Reading the ledger posting record.', 'admin.ledger_read_loading', 0));
    const result = await fetchFreeze(own.signal);
    if (request === sequence.current && !own.signal.aborted) setRead(result);
  }, []);
  useEffect(() => {
    void read();
    return () => {
      sequence.current += 1;
      controller.current?.abort();
    };
  }, [read]);
  return (
    <LedgerOpsView
      treasury={treasury}
      freeze={freeze}
      reconcile={reconcile}
      onRead={() => void read()}
      onReconcile={() => setReconcile(reconcileLedger())}
    />
  );
}

export interface LedgerOpsViewProps {
  treasury: AuthorityStatus;
  freeze: FreezeResult;
  reconcile: SimulatedResult<ReconcileReport> | null;
  onRead: () => void;
  onReconcile: () => void;
  /** Admin has no mounted locale selection; this seam supports the local copy family. */
  locale?: LedgerLocale;
}
export function LedgerOpsView({ treasury, freeze, reconcile, onRead, onReconcile, locale = 'en' }: LedgerOpsViewProps) {
  const c = ledgerCopy(locale);
  const state = freeze.ok && freeze.kind === 'reachable' ? decodeFreezeState(freeze.state) : null;
  const loading = freeze.kind === 'loading';
  const title = state
    ? state.frozen
      ? c.frozen
      : c.open
    : loading
      ? c.loading
      : freeze.kind === 'invalid_response'
        ? c.invalid
        : freeze.kind === 'absent'
          ? c.absent
          : freeze.kind === 'refused'
            ? c.refused
            : freeze.kind === 'unreachable'
              ? c.unreachable
              : c.unconfigured;
  return (
    <div className="lo" lang={locale}>
      <div className="adm-pagehead">
        <div>
          <h1>{c.title}</h1>
          <p>{c.intro}</p>
        </div>
      </div>
      <div className="lo-layout">
        <div className="lo-record-lane">
          <Panel
            title={c.record}
            className="lo-record"
            actions={
              <button type="button" className="adm-btn" onClick={onRead}>
                {state || loading ? c.refresh : c.retry}
              </button>
            }
          >
            <div className="lo-stack">
              {state && <p className="lo-muted">{c.completed}</p>}
              <div role="status" aria-live="polite" className="lo-status">
                <strong>{title}</strong>
                <p className="lo-muted" lang={!state && !loading && typeof freeze.detail === 'string' ? 'und' : undefined}>
                  {state ? c.recordOnly : loading ? c.noSnapshot : (freeze.detail ?? c.noSnapshot)}
                </p>
              </div>
              {state ? (
                <dl className="lo-values" data-testid="posting-record">
                  <div>
                    <dt>{c.reason}</dt>
                    <dd lang={state.reason === null ? undefined : 'und'}>{state.reason ?? c.nullReason}</dd>
                  </div>
                  <div>
                    <dt>{c.actor}</dt>
                    <dd lang={state.actor === null ? undefined : 'zxx'}>{state.actor ?? c.nullActor}</dd>
                  </div>
                  <div>
                    <dt>{c.changed}</dt>
                    <dd lang="zxx">
                      <time dateTime={state.changedAt}>{state.changedAt}</time>
                    </dd>
                  </div>
                </dl>
              ) : (
                <>
                  {!loading && (
                    <p className="lo-diagnostic" lang="zxx">
                      HTTP {freeze.upstreamStatus ?? freeze.status}
                      {freeze.code ? ` · ${freeze.code}` : ''}
                    </p>
                  )}
                  {!loading && <p className="lo-muted">{c.noSnapshot}</p>}
                </>
              )}
            </div>
          </Panel>
          <section className="lo-section" aria-labelledby="lo-original">
            <h2 id="lo-original">{c.original}</h2>
            <p className="lo-muted">{c.historyMissing}</p>
            <p className="lo-muted">{c.privateMissing}</p>
          </section>
        </div>
        <div className="lo-procedures">
          <Panel title={c.commands} className="lo-commands">
            <div className="lo-stack">
              <p className="lo-muted" id="lo-command-boundary">
                {c.missingAuthority}
              </p>
              <div className="lo-transport">
                <h3>{c.transport}</h3>
                <p className="lo-muted">
                  {treasury.configured ? (
                    c.configured
                  ) : (
                    <>
                      {c.notConfigured} <span lang="zxx">{treasury.missing.join(', ')}</span>
                    </>
                  )}
                </p>
              <p className="lo-muted">{consoleCopy('admin.console.transport.treasury.guards', {}, locale)}</p>
              </div>
              <details className="lo-requirements">
                <summary>{c.requirements}</summary>
                <div className="lo-stack">
                  <p className="lo-muted">{c.consequence}</p>
                  <div className="adm-field">
                    <label htmlFor="freeze-reason">{c.inputReason}</label>
                    <textarea id="freeze-reason" className="adm-textarea" disabled value="" placeholder={c.reasonPlaceholder} readOnly />
                  </div>
                  <div className="adm-field">
                    <label htmlFor="freeze-confirm">
                      {c.confirm} <code lang="en">{FREEZE_CONFIRM_PHRASE}</code> {c.confirmEnd}
                    </label>
                    <input id="freeze-confirm" className="adm-input" disabled value="" readOnly autoComplete="off" spellCheck={false} />
                  </div>
                  <label className="adm-check">
                    <input type="checkbox" disabled checked={false} readOnly />
                    <span>{c.freezeAck}</span>
                  </label>
                  <label className="adm-check">
                    <input type="checkbox" disabled checked={false} readOnly />
                    <span>{c.thawAck}</span>
                  </label>
                  <div className="adm-field">
                    <label htmlFor="unfreeze-confirm">
                      {c.confirm} <code lang="en">{UNFREEZE_CONFIRM_PHRASE}</code> {c.confirmEnd}
                    </label>
                    <input id="unfreeze-confirm" className="adm-input" disabled value="" readOnly autoComplete="off" spellCheck={false} />
                  </div>
                </div>
              </details>
              <div className="lo-buttons">
                <button type="button" className="adm-btn" disabled aria-describedby="lo-command-boundary">
                  {c.freezeButton}
                </button>
                <button type="button" className="adm-btn" disabled aria-describedby="lo-command-boundary">
                  {c.thawButton}
                </button>
              </div>
            </div>
          </Panel>
          <section className="lo-section" aria-labelledby="lo-reconcile">
            <h2 id="lo-reconcile">{c.reconcile}</h2>
            <p className="lo-muted">{c.reconcileMissing}</p>
            <button type="button" className="adm-btn" onClick={onReconcile}>
              {c.reconcileButton}
            </button>
            {reconcile && (
              <div className="lo-stack" data-testid="reconcile-preview">
                <strong>{c.simulated}</strong>
                <p className="lo-muted">{c.delivered}</p>
                <dl className="lo-values">
                  <div>
                    <dt>{c.accounts}</dt>
                    <dd>{c.notCounted}</dd>
                  </div>
                  <div>
                    <dt>{c.chain}</dt>
                    <dd>{c.notCounted}</dd>
                  </div>
                  <div>
                    <dt>{c.assets}</dt>
                    <dd>{c.notChecked}</dd>
                  </div>
                </dl>
                <p className="lo-muted" lang="en">{SIMULATED_NOTICE}</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
