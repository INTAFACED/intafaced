'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import { ControlDesk, type ControlAction } from '@/components/control-desk';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchConsoleMode } from '@/lib/console-mode/browser';
import { consoleModeHeadline } from '@/lib/console-mode/model';
import type { ConsoleModeRead } from '@/lib/console-mode/server';
import './desk.css';

/**
 * MAINTENANCE MODE (OPS-admin-access-08).
 *
 * The console's own read-only switch, kept by svc-ops. Turning it on (with a reason) and off each need a second founder:
 * one asks, the other approves the same packet, the first runs it. While it is on, every console write refuses
 * `ops.console_read_only`; reads, the halts and this desk stay open. It never touches the posting freeze or an account.
 */

const ON_NOTE =
  'This console becomes read-only for everyone: every write refuses until the mode is turned off, which also needs two founders. Reads still work, and so do the halts (posting freeze, module kill, payment halts). The posting freeze and every account stay as they are.';
const OFF_NOTE = 'This console takes writes again. Nothing else changes.';

export function ConsoleModeDesk({ initial, userId }: { initial: ConsoleModeRead; userId: string }) {
  const router = useRouter();
  const [read, setRead] = useState<ConsoleModeRead>(initial);
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++sequence.current;
    setLoading(true);
    const next = await fetchConsoleMode();
    if (mine !== sequence.current) return;
    if (next) setRead(next);
    setLoading(false);
    // The banner lives in the console layout: re-render it with the mode now in force.
    router.refresh();
  }, [router]);

  const { view } = read;
  const mode = view.kind === 'read' ? view.mode : null;
  const action: ControlAction | null = !mode
    ? null
    : mode.readOnly
      ? {
          heading: 'Turn maintenance mode off',
          submitLabel: 'Ask a second founder to approve turning it off',
          needsReason: false,
          reasonLabel: '',
          build: () => ({ kind: 'ops.console_mode.off' }),
        }
      : {
          heading: 'Turn maintenance mode on',
          submitLabel: 'Ask a second founder to approve turning it on',
          needsReason: true,
          reasonLabel: 'Why the console goes read-only (12 to 500 characters)',
          build: (reason) => ({ kind: 'ops.console_mode.on', reason }),
          danger: true,
        };
  const blocked =
    view.kind === 'unconfigured'
      ? 'svc-ops has no storage for the console mode (ops.console_mode_storage_unconfigured), so it cannot be turned on. It is off.'
      : view.kind === 'unknown'
        ? `${view.message} The mode cannot be changed until it can be read.`
        : null;

  return (
    <div className="dk" data-testid="console-mode-desk">
      <div className="adm-pagehead">
        <div>
          <h1>Maintenance mode</h1>
          <p>Make this console read-only while maintenance runs. Two founders turn it on, and two turn it off.</p>
        </div>
      </div>
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={() => void reload()} disabled={loading}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
        <span className="dk-asof">As of {formatAsOf(read.asOf)} (when this console read svc-ops)</span>
      </div>
      <section
        className="adm-callout dk-stack"
        data-tone={mode?.readOnly ? 'warn' : view.kind === 'unknown' ? 'danger' : 'info'}
        data-testid="console-mode-state"
        data-state={mode ? (mode.readOnly ? 'on' : 'off') : view.kind}
      >
        <strong>{consoleModeHeadline(view)}</strong>
        {view.kind === 'unknown' && view.code && <p className="dk-muted">Code: {view.code}</p>}
        {mode && mode.changedAt && (
          <dl className="dk-kv">
            {mode.readOnly && (
              <>
                <dt>Reason</dt>
                <dd data-testid="console-mode-reason">{mode.reason}</dd>
              </>
            )}
            <dt>Last changed</dt>
            <dd>{formatWhen(mode.changedAt)}</dd>
            <dt>Asked by</dt>
            <dd className="dk-packet">{mode.requesterId}</dd>
            <dt>Approved by</dt>
            <dd className="dk-packet">{mode.approverId}</dd>
            <dt>Change number</dt>
            <dd>{mode.revision}</dd>
          </dl>
        )}
        {mode && !mode.changedAt && <p className="dk-muted">It has never been turned on.</p>}
      </section>
      <ControlDesk
        // One desk for both directions, so the run's reply stays on screen after the mode flips.
        key="console-mode"
        endpoint="/api/console-mode"
        userId={userId}
        blockedReason={blocked}
        action={action}
        consequence={mode?.readOnly ? OFF_NOTE : ON_NOTE}
        blockedButtonLabel="Change unavailable"
        onChanged={() => void reload()}
      />
    </div>
  );
}
