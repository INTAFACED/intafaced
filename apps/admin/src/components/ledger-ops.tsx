'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Panel } from '@intafaced/ui';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { founderName, useFounderOwners, type FounderOwner } from '@/components/founder-names';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import { consoleCopy } from '@/lib/console-copy';
import { describeUnconfigured, type AuthorityStatus } from '@/lib/console-status';
import { fetchFreeze, type FreezeResult } from '@/lib/ledger-freeze-browser';
import { decodeFreezeState, freezeUnavailable, type FreezeState } from '@/lib/ledger-freeze-contract';
import { ledgerCopy, type LedgerLocale } from '@/lib/ledger-ops-copy';
import './ledger-ops.css';

export const FREEZE_CONFIRM_PHRASE = 'FREEZE LEDGER';
export const UNFREEZE_CONFIRM_PHRASE = 'UNFREEZE LEDGER';
export interface LedgerOpsProps {
  treasury: AuthorityStatus;
  initialFreeze: FreezeResult;
  /**
   * When the server received that first read, stamped where the read happened. It must not be made while rendering: the server
   * and the browser would print different times (React error 418) and the page would claim a read it never made.
   */
  initialReadAt: string | null;
  /** The signed-in founder's identity user id: tells the requester from the second founder. */
  userId: string;
}

/**
 * The ledger desk. It reads the posting record and asks two founders to freeze or unfreeze it; the deployment
 * transport is distinct from the people who must agree.
 */
export function LedgerOps({ treasury, initialFreeze, initialReadAt, userId }: LedgerOpsProps) {
  const [freeze, setRead] = useState(initialFreeze);
  const [readAt, setReadAt] = useState<string | null>(initialFreeze.kind === 'reachable' ? initialReadAt : null);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const read = useCallback(async () => {
    const request = ++sequence.current;
    controller.current?.abort();
    const own = new AbortController();
    controller.current = own;
    setRead(freezeUnavailable('loading', 'Reading the ledger posting record.', 'admin.ledger_read_loading', 0));
    const result = await fetchFreeze(own.signal);
    if (request === sequence.current && !own.signal.aborted) {
      setReadAt(result.kind === 'reachable' ? new Date().toISOString() : null);
      setRead(result);
    }
  }, []);
  useEffect(() => {
    void read();
    return () => {
      sequence.current += 1;
      controller.current?.abort();
    };
  }, [read]);
  const owners = useFounderOwners();
  return <LedgerOpsView treasury={treasury} freeze={freeze} readAt={readAt} userId={userId} owners={owners} onRead={() => void read()} />;
}

export interface LedgerOpsViewProps {
  treasury: AuthorityStatus;
  freeze: FreezeResult;
  /** When this console received the posting record, or null when there is no usable read. */
  readAt: string | null;
  userId: string;
  /** The two founders' names when the founder directory answered; otherwise an actor id is shown as a short reference. */
  owners?: FounderOwner[];
  onRead: () => void;
  /** Admin has no mounted locale selection; this seam supports the local copy family. */
  locale?: LedgerLocale;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function LedgerOpsView({ treasury, freeze, readAt, userId, owners = [], onRead, locale = 'en' }: LedgerOpsViewProps) {
  const c = ledgerCopy(locale);
  /** An identity id becomes a name when the founder directory gave one, else a short reference labelled as an id; other opaque text is kept as is. */
  const actorText = (actor: string): string => {
    if (!UUID.test(actor)) return actor;
    if (actor.toLowerCase() === userId.toLowerCase()) return c.actorSelf;
    const named = owners.find((owner) => owner.userId.toLowerCase() === actor.toLowerCase());
    return named ? founderName(owners, named.userId) : `${c.actorUnnamed} …${actor.slice(-4)}`;
  };
  const state = freeze.ok && freeze.kind === 'reachable' ? decodeFreezeState(freeze.state) : null;
  const loading = freeze.kind === 'loading';
  const blocked = !treasury.configured
    ? describeUnconfigured(treasury)
    : !state
      ? c.stateUnknown
      : state.version === undefined
        ? c.versionMissing
        : null;
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
                    <dd lang={state.actor === null || UUID.test(state.actor) ? undefined : 'zxx'}>
                      {state.actor === null ? c.nullActor : actorText(state.actor)}
                    </dd>
                  </div>
                  <div>
                    <dt>{c.changed}</dt>
                    <dd lang="zxx">
                      <time dateTime={state.changedAt}>{formatWhen(state.changedAt)}</time>
                    </dd>
                  </div>
                  {readAt && (
                    <div>
                      <dt>{c.asOf}</dt>
                      <dd lang="zxx">
                        <time dateTime={readAt}>{formatAsOf(readAt)}</time>
                      </dd>
                    </div>
                  )}
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
              <div lang="en">
                <ControlDesk
                  endpoint="/api/ledger-freeze"
                  userId={userId}
                  blockedReason={blocked}
                  action={blocked || !state ? null : freezeAction(state)}
                  consequence={state?.frozen ? c.consequenceThaw : c.consequenceFreeze}
                  blockedButtonLabel={state?.frozen ? 'Unfreeze ledger unavailable' : 'Freeze ledger unavailable'}
                  onChanged={onRead}
                />
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

/**
 * The one request that makes sense for the current record: unfreeze when frozen, freeze when not. Both are bound to
 * the ledger's own version token, which `blocked` has already required to be present.
 */
function freezeAction(state: FreezeState): ControlAction | null {
  const version = state.version;
  if (version === undefined) return null;
  return state.frozen
    ? {
        heading: 'Unfreeze the ledger',
        submitLabel: 'Ask a second founder to approve the unfreeze',
        needsReason: false,
        reasonLabel: '',
        build: () => ({ kind: 'ledger.unfreeze', version }),
      }
    : {
        heading: 'Freeze the ledger',
        submitLabel: 'Ask a second founder to approve the freeze',
        needsReason: true,
        reasonLabel: 'Why (recorded with the freeze, 12 to 500 characters)',
        build: (reason) => ({ kind: 'ledger.freeze', reason, version }),
        danger: true,
      };
}
