'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MODULE_IDS, isModuleId, type ModuleId } from '@intafaced/config';
import { Panel } from '@intafaced/ui';
import { fetchKillSwitches, type ControlPlaneState } from '@/lib/control-plane-browser';
import { decodeSnapshot, unavailable } from '@/lib/control-plane-contract';
import { ModuleKillDesk } from '@/components/module-kill-desk';
import './module-state-inspector.css';

function hashSelection(): ModuleId {
  const value = new URLSearchParams(location.hash.slice(1)).get('module');
  return value && isModuleId(value) ? value : 'trade';
}
export interface ModuleStateInspectorProps {
  plane: ControlPlaneState;
  onRead: (state: ControlPlaneState) => void;
  /** Deployment reason module writes are off, or null when the console can send. */
  writesBlocked: string | null;
  /** The signed-in founder, so the desk can tell the requester from the second founder. */
  userId: string;
}

export function ModuleStateInspector({ plane, onRead, writesBlocked, userId }: ModuleStateInspectorProps) {
  const [module, setModule] = useState<ModuleId>('trade');
  const [filter, setFilter] = useState('all');
  const [limit, setLimit] = useState(12);
  const [readAt, setReadAt] = useState<string | null>(null);
  const sequence = useRef(0),
    controller = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    onRead(unavailable('loading', 'Reading the original module state…', 'admin.kill_read_loading'));
    const result = await fetchKillSwitches({ signal: next.signal });
    if (request === sequence.current && !next.signal.aborted) {
      setReadAt(result.status === 'reachable' ? new Date().toISOString() : null);
      onRead(result);
    }
  }, [onRead]);
  useEffect(() => {
    setModule(hashSelection());
    void reload();
    const changed = () => {
      setModule(hashSelection());
      setLimit(12);
      void reload();
    };
    window.addEventListener('hashchange', changed);
    return () => {
      ++sequence.current;
      controller.current?.abort();
      window.removeEventListener('hashchange', changed);
    };
  }, [reload]);
  function choose(value: string) {
    if (!isModuleId(value)) return;
    setModule(value);
    setLimit(12);
    const hash = new URLSearchParams();
    hash.set('module', value);
    history.replaceState(history.state, '', location.pathname + location.search + '#' + hash);
    void reload();
  }
  const snapshot = plane.status === 'reachable' ? decodeSnapshot(plane.snapshot) : null;
  const ready = Boolean(snapshot);
  const rows = MODULE_IDS.filter((id) => !snapshot || filter === 'all' || (filter === 'killed') === snapshot.disabledModules.includes(id));
  const entries = snapshot?.audit.filter((entry) => entry.module === module) ?? [];
  const killed = snapshot?.disabledModules.includes(module);
  return (
    <Panel title="Module state" className="module-inspector">
      <div className="mi-heading">
        <p>
          Read the current edge state and its audit, and ask two founders to kill or re-enable a module. Reading never changes anything.
        </p>
        <button className="adm-btn" type="button" onClick={() => void reload()}>
          Refresh module state
        </button>
      </div>
      <div className="mi-layout">
        <div className="mi-discovery">
          <label className="adm-field">
            <span>Inspect module</span>
            <select className="adm-input" aria-label="Inspect module" value={module} onChange={(e) => choose(e.target.value)}>
              {MODULE_IDS.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <label className="adm-field">
            <span>Show returned state</span>
            <select
              className="adm-input"
              aria-label="Show returned state"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              disabled={!ready}
            >
              <option value="all">All modules</option>
              <option value="killed">Listed as killed</option>
              <option value="not-listed">Not listed as killed</option>
            </select>
          </label>
          <div className="mi-modules" role="region" tabIndex={0} aria-label="Known modules" aria-describedby="module-catalogue-hint">
            {rows.map((id) => (
              <button
                className="adm-btn mi-module"
                type="button"
                key={id}
                aria-label={`Inspect ${id}`}
                aria-pressed={id === module}
                aria-controls="original-module-state"
                onClick={() => choose(id)}
              >
                <strong>{id}</strong>
                <span>{!snapshot ? 'Unknown' : snapshot.disabledModules.includes(id) ? 'Killed' : 'Not listed'}</span>
              </button>
            ))}
          </div>
          <p id="module-catalogue-hint" className="mi-catalogue-hint">
            {ready
              ? `${rows.length} of ${MODULE_IDS.length} known modules match this filter.`
              : `${MODULE_IDS.length} known modules available for selection; current state is unavailable.`}{' '}
            Scroll the list or use Inspect module above.
          </p>
        </div>
        <div id="original-module-state" className="mi-original">
          <p className="adm-meta">Selected original module</p>
          <h2>{module}</h2>
          {!snapshot ? (
            <div className="mi-read-failure" role="status">
              <h3>{plane.status === 'loading' ? 'Reading module state' : 'Module read unavailable'}</h3>
              <p>{plane.detail ?? 'Current module state was not returned in a usable shape.'}</p>
              {plane.code && <code>{plane.code}</code>}
              {plane.httpStatus && <p>HTTP {plane.httpStatus}</p>}
              <p>Earlier state and audit are hidden. Retry reads this original module; it does not send or replay a kill command.</p>
              {plane.status !== 'loading' && (
                <button className="adm-btn" data-tone="primary" type="button" onClick={() => void reload()}>
                  Retry module read
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="mi-current" data-testid="current-module-state">
                <h3>{killed ? 'Listed as killed by this edge' : 'Not listed as killed in this snapshot'}</h3>
                <p lang="und">
                  {snapshot.reasons[module] ||
                    (killed ? 'The snapshot returned no reason for this module.' : 'No current kill reason was returned for this module.')}
                </p>
                <p className="adm-footnote">
                  Current edge snapshot. It does not establish direct service health, fleet-wide control or the outcome of an original
                  command.
                </p>
              </div>
              <section className="mi-history" aria-label={`Historical audit for ${module}`}>
                <h3>Historical audit · {module}</h3>
                <p className="adm-footnote">
                  This history does not identify the current operator or resolve an original command. No original-operation lookup is
                  available here.
                </p>
                {entries.length === 0 ? (
                  <p>No historical audit for this module was returned.</p>
                ) : (
                  entries.slice(0, limit).map((entry, index) => (
                    <article key={`${entry.at}:${index}`} className="mi-audit">
                      <time dateTime={entry.at} lang="zxx">
                        {entry.at}
                      </time>
                      <p>
                        {entry.previous ? 'Killed' : 'Not listed'} → {entry.next ? 'killed' : 'not listed'} ·{' '}
                        {entry.changed ? 'changed' : 'no-op'}
                      </p>
                      <dl>
                        <div>
                          <dt>Actor in this historical event</dt>
                          <dd lang="und">{entry.actor}</dd>
                        </div>
                        <div>
                          <dt>Confirming operator in this event</dt>
                          <dd lang="und">{entry.confirmOperatorId ?? 'Not returned'}</dd>
                        </div>
                        <div>
                          <dt>Historical reason</dt>
                          <dd lang="und">{entry.reason}</dd>
                        </div>
                      </dl>
                    </article>
                  ))
                )}
                {entries.length > limit && (
                  <button className="adm-btn" type="button" onClick={() => setLimit((n) => n + 12)}>
                    Show more returned history
                  </button>
                )}
                <p className="adm-footnote">
                  Only history present in this returned snapshot is available. This contract publishes no continuation cursor or complete
                  incident-history guarantee.
                </p>
              </section>
            </>
          )}
          <section className="mi-controls" aria-label={`Controls for ${module}`}>
            <h3>Module controls</h3>
            <ModuleKillDesk
              key={module}
              module={module}
              snapshot={snapshot}
              readAt={readAt}
              loading={plane.status === 'loading'}
              writesBlocked={writesBlocked}
              userId={userId}
              onReload={() => void reload()}
            />
          </section>
        </div>
      </div>
    </Panel>
  );
}
