'use client';

import { useMemo, useState } from 'react';
import { Panel, StatBlock } from '@intafaced/ui';
import { DROPS, MODULES, resolveAll, type Drop } from '@intafaced/config';
import { Chip } from '@/components/chip';
import { DROP_LABELS, dropLabel, flagsTurnedOnAt, isDrop, offClockFlags } from '@/lib/drops';
import { flagStates } from '@/lib/flag-state';

/**
 * LAUNCH SEQUENCE — §11 "the drop sequence is configuration, not deployment
 * risk", rendered so an operator can check that claim before pulling the lever.
 *
 * The table is derived from `FLAG_REGISTRY` (each flag's `drop`) and every
 * cumulative count comes from `resolveAll()`. The only thing this file adds is
 * the six human drop names, which live in the doctrine table and not yet in
 * `flags.ts` — see `src/lib/drops.ts`.
 */

export interface LaunchSequenceProps {
  currentDrop: Drop;
  flagEnv: Record<string, string>;
}

export function LaunchSequence({ currentDrop, flagEnv }: LaunchSequenceProps) {
  const [preview, setPreview] = useState<Drop>(currentDrop);

  const now = useMemo(() => flagStates({ drop: currentDrop, env: flagEnv }), [currentDrop, flagEnv]);
  const then = useMemo(() => flagStates({ drop: preview, env: flagEnv }), [preview, flagEnv]);

  const rows = useMemo(
    () =>
      DROPS.map((drop) => {
        const resolved = resolveAll({ drop, env: flagEnv });
        const turnsOn = flagsTurnedOnAt(drop);
        return {
          drop,
          turnsOn,
          liveTotal: Object.values(resolved).filter(Boolean).length,
        };
      }),
    [flagEnv],
  );

  const nowLive = new Set(now.filter((s) => s.enabled).map((s) => s.def.key));
  const newlyLive = then.filter((s) => s.enabled && !nowLive.has(s.def.key));
  const stillDark = then.filter((s) => !s.enabled);
  const offClock = useMemo(() => offClockFlags(), []);
  const envPinned = Object.keys(flagEnv).length;

  return (
    <>
      <div className="adm-pagehead">
        <div>
          <h1>Launch sequence</h1>
          <p>
            The §11 drop table as the registry actually holds it. Each row lists the flags that <em>first</em> switch on at that drop and
            the total that would be live once it is reached. The platform is at {dropLabel(currentDrop)}.
          </p>
        </div>
        <div className="adm-field">
          <label htmlFor="preview-drop">Preview drop</label>
          <select
            id="preview-drop"
            className="adm-select"
            value={preview}
            onChange={(event) => {
              if (isDrop(event.target.value)) setPreview(event.target.value);
            }}
          >
            {DROPS.map((drop) => (
              <option key={drop} value={drop}>
                {dropLabel(drop)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {envPinned > 0 && (
        <div className="adm-banner">
          <Chip tone="warn" dot>
            Env pinned
          </Chip>
          {envPinned} <code>INTAFACED_FLAG_*</code> variable(s) are set on this process. Those flags do not follow the drop clock, and the
          counts below already account for them.
        </div>
      )}

      <Panel title="§11 drop table" className="adm-flush">
        <div className="adm-scroll" tabIndex={0} role="region" aria-label="Launch flags table">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Drop</th>
                <th>Phase</th>
                <th>Turns on</th>
                <th className="adm-num">New</th>
                <th className="adm-num">Live after</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isCurrent = row.drop === currentDrop;
                const isPreview = row.drop === preview;
                return (
                  <tr key={row.drop}>
                    <td className="adm-key">{row.drop}</td>
                    <td>{DROP_LABELS[row.drop]}</td>
                    <td>
                      {row.turnsOn.length === 0 ? (
                        <span className="adm-desc">nothing new</span>
                      ) : (
                        <span className="adm-inline">
                          {row.turnsOn.map((flag) => (
                            <Chip key={flag.key} tone="neutral" title={`${flag.module} · ${flag.description}`}>
                              {flag.key}
                            </Chip>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="adm-num">{row.turnsOn.length}</td>
                    <td className="adm-num">
                      {row.liveTotal} / {now.length}
                    </td>
                    <td>
                      <span className="adm-inline">
                        {isCurrent && (
                          <Chip tone="live" dot>
                            Current
                          </Chip>
                        )}
                        {isPreview && !isCurrent && <Chip tone="info">Previewing</Chip>}
                        {!isCurrent && !isPreview && (
                          // `DROP_ORDER` is private to flags.ts, so ordering is read
                          // off the exported `DROPS` tuple rather than guessed at.
                          <Chip tone="dark">{DROPS.indexOf(row.drop) < DROPS.indexOf(currentDrop) ? 'Passed' : 'Ahead'}</Chip>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title={`Preview — what would be live at drop ${preview}`} live={preview !== currentDrop}>
        <div className="adm-statrow">
          <StatBlock label="Live now" value={nowLive.size} deltaLabel={dropLabel(currentDrop)} />
          <StatBlock label={`Live at ${preview}`} value={then.filter((s) => s.enabled).length} deltaLabel={DROP_LABELS[preview]} />
          <StatBlock label="Newly live" value={newlyLive.length} delta={newlyLive.length} />
          <StatBlock label="Still dark" value={stillDark.length} />
        </div>
      </Panel>

      <div className="adm-split">
        <Panel title={`Newly live at ${dropLabel(preview)}`} className="adm-flush">
          {newlyLive.length === 0 ? (
            <p className="adm-empty">Nothing changes. Drop {preview} turns on no flag that is not already live.</p>
          ) : (
            <div className="adm-scroll" tabIndex={0} role="region" aria-label="Launch flags table">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Flag</th>
                    <th>Module</th>
                    <th>Description</th>
                    <th>Custody</th>
                  </tr>
                </thead>
                <tbody>
                  {newlyLive.map((state) => (
                    <tr key={state.def.key}>
                      <td className="adm-key">{state.def.key}</td>
                      <td>{state.def.module}</td>
                      <td className="adm-desc">{state.def.description}</td>
                      <td>
                        {MODULES[state.def.module].custodial ? <Chip tone="warn">Custodial</Chip> : <Chip tone="info">Non-custodial</Chip>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Never on the drop clock" className="adm-panel--warn">
          <div className="adm-stack">
            <div className="adm-callout" data-tone="warn">
              <strong>
                {offClock.length} of {now.length} flags have <code>drop: null</code>
              </strong>
              Reaching drop V does not turn these on. They are the §13 sockets and the licence-gated surfaces, and each needs an explicit
              override — from this console or from <code>INTAFACED_FLAG_*</code> — or the registry reports it off forever. That is a
              statement about the registry and not about the platform: most of these flags are read by nothing, so their capability serves
              at every drop regardless of what this table says. The Kill-switches page marks which is which.
            </div>
            <div className="adm-inline">
              {offClock.map((flag) => (
                <Chip key={flag.key} tone="dark" title={flag.description}>
                  {flag.key}
                </Chip>
              ))}
            </div>
          </div>
        </Panel>
      </div>
    </>
  );
}
