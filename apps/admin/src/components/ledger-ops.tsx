'use client';

import { consoleCopy } from '@/lib/console-copy';
import { useRef, useState, useTransition } from 'react';
import { Panel, StatBlock } from '@intafaced/ui';
import { Chip } from '@/components/chip';
import type { AuthorityStatus } from '@/lib/console-status';
import { fetchFreeze, postFreeze, type FreezeResult, type FreezeState } from '@/lib/ledger-freeze-browser';
import { reconcileLedger, SIMULATED_NOTICE, type ReconcileReport, type SimulatedResult } from '@/lib/operator-commands';

/**
 * LEDGER OPERATIONS — and the difference between a control and a picture of one.
 *
 * ── What this screen used to be ─────────────────────────────────────────────
 *
 * Every button called `src/lib/operator-commands.ts`, whose own header said "They
 * do NOT call them." Pressing "Freeze ledger" set React state; the posting panel
 * then read **HALTED**, in the danger colour, with a line in an audit-shaped
 * log. An operator halting the money plane during an incident got a screen that
 * was indistinguishable from success and a platform that was still settling.
 *
 * Meanwhile `src/app/api/ledger-freeze/route.ts` — a complete BFF onto svc-edge's
 * `admin:treasury` freeze — had no callers at all.
 *
 * Freeze and unfreeze now go through that route. Reconcile does not, because
 * svc-edge exposes no reconcile route to go through (see `operator-commands.ts`),
 * and it is labelled at the control rather than in a doc.
 *
 * ── Three rules this file holds ─────────────────────────────────────────────
 *
 * 1. The posting state is only ever svc-ledger's answer. There is no local
 *    `postingEnabled` any more. The old component seeded one from the
 *    `ledger.posting` FLAG, which is a drop-clock default and not the book's
 *    state — so a console with no credential rendered a confident "ACCEPTING"
 *    for a ledger it had never spoken to.
 * 2. A failure is never a success. `ok: false` renders UNKNOWN and the reason,
 *    never "accepting" and never "halted".
 * 3. A control that cannot act says so beside itself. Not disabled-and-silent;
 *    disabled with the variable name that would make it live.
 *
 * The view is split from the container on purpose — `renderToStaticMarkup` runs
 * no effects and dispatches no events, so the only way to assert on the markup
 * an operator sees AFTER a command is to hand the view that state directly. The
 * same argument, and the same shape, as `apps/web`'s `MarketPulseView`.
 */

export const FREEZE_CONFIRM_PHRASE = 'FREEZE LEDGER';
export const UNFREEZE_CONFIRM_PHRASE = 'UNFREEZE LEDGER';
const MIN_REASON_LENGTH = 12;

export interface LedgerCommandReceipt {
  readonly action: 'freeze' | 'unfreeze';
  readonly status: number;
  /** Exactly the durable state returned by svc-ledger through the BFF. */
  readonly state: FreezeState;
}

// ── Container ───────────────────────────────────────────────────────────────

export interface LedgerOpsProps {
  /** Whether this console holds `EDGE_URL` + `ADMIN_TREASURY_TOKEN`. */
  treasury: AuthorityStatus;
  /** Server-loaded first paint, so the screen never starts from a guess. */
  initialFreeze: FreezeResult;
}

export function LedgerOps({ treasury, initialFreeze }: LedgerOpsProps) {
  const [freeze, setFreeze] = useState<FreezeResult>(initialFreeze);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reconcile, setReconcile] = useState<SimulatedResult<ReconcileReport> | null>(null);
  const [receipt, setReceipt] = useState<LedgerCommandReceipt | null>(null);
  const [isPending, startTransition] = useTransition();
  const commandLockRef = useRef(false);

  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [resumeConfirmation, setResumeConfirmation] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [resumeAcknowledged, setResumeAcknowledged] = useState(false);

  function apply(next: boolean, why?: string) {
    if (commandLockRef.current) return;
    commandLockRef.current = true;
    setReceipt(null);
    startTransition(async () => {
      try {
        const result = await postFreeze({ frozen: next, reason: why });
        if (!result.ok || !result.state) {
          // The command failed. The displayed state is NOT advanced — it is
          // re-read, so what the screen shows is what the money plane says and not
          // what the operator asked for.
          setActionError(result.detail ?? `ledger freeze refused (${result.status})`);
          setFreeze(await fetchFreeze());
          return;
        }
        setFreeze(result);
        setReceipt({ action: next ? 'freeze' : 'unfreeze', status: result.status, state: result.state });
        setActionError(null);
        setReason('');
        setConfirmation('');
        setResumeConfirmation('');
        setAcknowledged(false);
        setResumeAcknowledged(false);
      } finally {
        commandLockRef.current = false;
      }
    });
  }

  return (
    <LedgerOpsView
      treasury={treasury}
      freeze={freeze}
      pending={isPending}
      actionError={actionError}
      receipt={receipt}
      reconcile={reconcile}
      reason={reason}
      confirmation={confirmation}
      resumeConfirmation={resumeConfirmation}
      acknowledged={acknowledged}
      resumeAcknowledged={resumeAcknowledged}
      onReason={setReason}
      onConfirmation={setConfirmation}
      onResumeConfirmation={setResumeConfirmation}
      onAcknowledge={setAcknowledged}
      onResumeAcknowledge={setResumeAcknowledged}
      onFreeze={() => apply(true, reason.trim())}
      onUnfreeze={() => apply(false)}
      onReconcile={() => setReconcile(reconcileLedger())}
    />
  );
}

// ── The view ────────────────────────────────────────────────────────────────

export interface LedgerOpsViewProps {
  treasury: AuthorityStatus;
  freeze: FreezeResult;
  pending: boolean;
  actionError: string | null;
  receipt: LedgerCommandReceipt | null;
  reconcile: SimulatedResult<ReconcileReport> | null;
  reason: string;
  confirmation: string;
  resumeConfirmation: string;
  acknowledged: boolean;
  resumeAcknowledged: boolean;
  onReason: (value: string) => void;
  onConfirmation: (value: string) => void;
  onResumeConfirmation: (value: string) => void;
  onAcknowledge: (value: boolean) => void;
  onResumeAcknowledge: (value: boolean) => void;
  onFreeze: () => void;
  onUnfreeze: () => void;
  onReconcile: () => void;
}

export function LedgerOpsView(props: LedgerOpsViewProps) {
  const { treasury, freeze, pending, actionError, reconcile } = props;

  // `state` is the ONLY gate on rendering a posting state, and it is non-null
  // exactly when svc-ledger answered. Unconfigured and unreachable are both "we
  // do not know", and they must look like it rather than like "accepting".
  const state = freeze.ok ? freeze.state : null;
  const known = state !== null;
  const frozen = state !== null && state.frozen;
  const blocked = treasury.configured ? null : `Disabled — ${treasury.missing.join(' and ')} not set on this console.`;

  const trimmedReason = props.reason.trim();
  const reasonOk = trimmedReason.length >= MIN_REASON_LENGTH;
  const phraseOk = props.confirmation === FREEZE_CONFIRM_PHRASE;
  const resumePhraseOk = props.resumeConfirmation === UNFREEZE_CONFIRM_PHRASE;
  // Every clause must hold. Note `known && !frozen`: a console that cannot read
  // the freeze state cannot arm the freeze either, because "already halted" and
  // "we have no idea" are not the same and only one of them is safe to act on.
  const canFreeze = treasury.configured && known && !frozen && reasonOk && phraseOk && props.acknowledged && !pending;
  const canUnfreeze = treasury.configured && known && frozen && resumePhraseOk && props.resumeAcknowledged && !pending;

  return (
    <>
      <div className="adm-pagehead">
        <div>
          <h1>Ledger operations</h1>
          <p>
            Freeze, unfreeze and reconcile — the operator procedures svc-ledger exposes under the <code>admin:treasury</code> scope. This
            console issues commands; it never computes a balance and never posts an entry.
          </p>
        </div>
      </div>

      <PostingStatusPanel treasury={treasury} freeze={freeze} state={state} />

      {actionError && (
        <div className="adm-callout" data-tone="danger">
          <strong>Not applied — the platform did not change</strong>
          {actionError} The state shown above was re-read from the money plane after the failure; it is not what you asked for.
        </div>
      )}

      <div className="adm-split">
        <div className="adm-stack">
          {/* ── FREEZE — the destructive one ─────────────────────────────── */}
          <Panel title="Freeze — halt all posting" className="adm-panel--danger" actions={<Chip tone="danger">Platform-wide</Chip>}>
            <div className="adm-stack">
              <div className="adm-callout" data-tone="danger">
                <strong>This stops the entire platform</strong>
                Every module moves value by posting to the ledger. A freeze halts trade fills, payouts, escrow releases, card
                authorisations, staking and settlement at once, for every user, with no warning. §4.2 makes it the correct response to a
                reconciliation mismatch — a book we cannot verify must stop accepting writes — and the wrong response to anything smaller.
              </div>

              <div className="adm-field">
                <label htmlFor="freeze-reason">Reason (recorded with the freeze, minimum {MIN_REASON_LENGTH} characters)</label>
                <textarea
                  id="freeze-reason"
                  className="adm-textarea"
                  value={props.reason}
                  disabled={!treasury.configured || !known || frozen || pending}
                  placeholder="e.g. reconciliation mismatch on IFC — snapshot vs replay diverged at tx 41220"
                  onChange={(event) => props.onReason(event.target.value)}
                />
                <span className="adm-footnote">
                  {reasonOk ? (
                    <Chip tone="live">Reason accepted</Chip>
                  ) : (
                    <Chip tone="dark">
                      {trimmedReason.length} / {MIN_REASON_LENGTH} characters
                    </Chip>
                  )}{' '}
                  svc-ledger requires a non-empty reason and the BFF route requires {MIN_REASON_LENGTH}. This console requires one that will
                  still make sense to whoever reads the incident record.
                </span>
              </div>

              <div className="adm-field">
                <label htmlFor="freeze-confirm">
                  Type <code>{FREEZE_CONFIRM_PHRASE}</code> to confirm
                </label>
                <input
                  id="freeze-confirm"
                  className="adm-input"
                  value={props.confirmation}
                  disabled={!treasury.configured || !known || frozen || pending}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => props.onConfirmation(event.target.value)}
                />
              </div>

              <label className="adm-check">
                <input
                  type="checkbox"
                  checked={props.acknowledged}
                  disabled={!treasury.configured || !known || frozen || pending}
                  onChange={(event) => props.onAcknowledge(event.target.checked)}
                />
                <span>
                  I understand this halts all value movement platform-wide, immediately, and that resuming requires a separate deliberate
                  action.
                </span>
              </label>

              <div className="adm-inline">
                <button type="button" className="adm-btn" data-tone="danger" disabled={!canFreeze} onClick={props.onFreeze}>
                  {pending ? 'Sending…' : 'Freeze ledger'}
                </button>
                {known && frozen && <Chip tone="danger">Already halted</Chip>}
                {!known && treasury.configured && <Chip tone="warn">Money-plane state unknown</Chip>}
              </div>
              {blocked && <span className="adm-blocked">{blocked}</span>}
              {!blocked && !known && (
                <span className="adm-blocked">
                  Disabled — this console could not read the ledger freeze state, so it will not send a command whose result it cannot
                  confirm.
                </span>
              )}
            </div>
          </Panel>

          {/* ── UNFREEZE ─────────────────────────────────────────────────── */}
          <Panel title="Unfreeze — resume posting">
            <div className="adm-stack">
              <p className="adm-desc">
                Resuming lets every module write to the book again. §4.2: do not resume on a book that has not reconciled clean — run
                reconcile first and read the report.
              </p>
              <label className="adm-check">
                <input
                  type="checkbox"
                  checked={props.resumeAcknowledged}
                  disabled={!treasury.configured || !known || !frozen || pending}
                  onChange={(event) => props.onResumeAcknowledge(event.target.checked)}
                />
                <span>Reconciliation is clean and the cause of the freeze is resolved.</span>
              </label>
              <div className="adm-field">
                <label htmlFor="unfreeze-confirm">
                  Type <code>{UNFREEZE_CONFIRM_PHRASE}</code> to confirm
                </label>
                <input
                  id="unfreeze-confirm"
                  className="adm-input"
                  value={props.resumeConfirmation}
                  disabled={!treasury.configured || !known || !frozen || pending}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => props.onResumeConfirmation(event.target.value)}
                />
              </div>
              <div className="adm-inline">
                <button type="button" className="adm-btn" data-tone="primary" disabled={!canUnfreeze} onClick={props.onUnfreeze}>
                  {pending ? 'Sending…' : 'Unfreeze ledger'}
                </button>
                {known && !frozen && <Chip tone="live">Already accepting</Chip>}
              </div>
              {blocked && <span className="adm-blocked">{blocked}</span>}
            </div>
          </Panel>

          {/* ── RECONCILE — the one that is still theatre, and says so ────── */}
          <Panel
            title="Reconcile — snapshot + replay"
            className="adm-panel--warn"
            actions={
              <Chip tone="warn" dot>
                Simulated
              </Chip>
            }
          >
            <div className="adm-stack">
              <div className="adm-callout" data-tone="warn">
                <strong>This button does not reach the ledger</strong>
                svc-ledger implements <code>ledger.reconcile</code> under <code>admin:treasury</code>, but svc-edge exposes no route to it —
                only <code>/admin/kill-switches</code>, <code>/admin/status</code> and the two ledger freeze paths. Pressing this records
                the request locally and returns zeroes. It is left visible rather than hidden so the gap is on the screen an operator uses,
                and it is marked rather than dressed up.
              </div>
              <p className="adm-desc">
                When the route exists this is read-only on the ledger&rsquo;s side: replays the chain, recomputes balances and compares. A
                non-ok report is a freeze decision, not a warning.
              </p>
              <div className="adm-inline">
                <button type="button" className="adm-btn" onClick={props.onReconcile}>
                  Run reconcile (simulated)
                </button>
              </div>

              {reconcile && (
                <>
                  <div className="adm-inline">
                    <Chip tone="warn" dot>
                      Simulated — not the book
                    </Chip>
                    <Chip tone="dark">Nothing was asked</Chip>
                  </div>
                  <dl className="adm-kv">
                    <dt>Accounts checked</dt>
                    <dd>{reconcile.simulated.accountsChecked}</dd>
                    <dt>Chain length</dt>
                    <dd>{reconcile.simulated.chainLength}</dd>
                    <dt>Unbalanced assets</dt>
                    <dd>
                      {reconcile.simulated.unbalancedAssets.length === 0 ? 'not checked' : reconcile.simulated.unbalancedAssets.join(', ')}
                    </dd>
                  </dl>
                  <p className="adm-footnote">{reconcile.simulatedNotice}</p>
                </>
              )}
            </div>
          </Panel>
        </div>

        {/* ── Where the freeze actually went ─────────────────────────────── */}
        <Panel title="Money-plane record">
          <div className="adm-stack">
            <p className="adm-footnote">
              There is no local command log on this screen any more. The freeze is a durable row in svc-ledger with an <code>actor</code>{' '}
              column written from svc-ledger&rsquo;s own token verification — the record below is that row, not this browser&rsquo;s memory
              of what was clicked.
            </p>
            <dl className="adm-kv">
              <dt>Frozen</dt>
              <dd>{state ? (state.frozen ? 'yes' : 'no') : 'unknown'}</dd>
              <dt>Reason</dt>
              <dd>{state ? (state.reason ?? '—') : 'unknown'}</dd>
              <dt>Actor</dt>
              <dd>{state ? (state.actor ?? '—') : 'unknown'}</dd>
              <dt>Changed at</dt>
              <dd>{state ? (state.changedAt ?? '—') : 'unknown'}</dd>
            </dl>
            <p className="adm-footnote">Reconcile is the only control on this page that does not reach a service. {SIMULATED_NOTICE}</p>
          </div>
        </Panel>

        {props.receipt && (
          <Panel title="Service command receipt" actions={<Chip tone="live">svc-ledger answered</Chip>}>
            <div className="adm-stack" data-testid="ledger-command-receipt">
              <p className="adm-footnote">
                This receipt is the state returned by svc-ledger through the BFF, not a browser-generated command log.
              </p>
              <dl className="adm-kv">
                <dt>Command</dt>
                <dd>{props.receipt.action}</dd>
                <dt>Transport</dt>
                <dd>HTTP {props.receipt.status}</dd>
                <dt>Frozen</dt>
                <dd>{props.receipt.state.frozen ? 'yes' : 'no'}</dd>
                <dt>Reason</dt>
                <dd>{props.receipt.state.reason ?? '—'}</dd>
                <dt>Actor</dt>
                <dd>{props.receipt.state.actor ?? '—'}</dd>
                <dt>Changed at</dt>
                <dd>{props.receipt.state.changedAt ?? '—'}</dd>
              </dl>
            </div>
          </Panel>
        )}
      </div>
    </>
  );
}

// ── Posting status ──────────────────────────────────────────────────────────

function PostingStatusPanel({ treasury, freeze, state }: { treasury: AuthorityStatus; freeze: FreezeResult; state: FreezeState | null }) {
  const accepting = state !== null && !state.frozen;

  return (
    <Panel
      title={state ? 'Posting status (svc-ledger)' : 'Posting status — UNKNOWN'}
      className={accepting ? undefined : 'adm-panel--danger'}
      live={accepting}
    >
      <div className="adm-stack">
        {!state && (
          <div className="adm-callout" data-tone="danger">
            <strong>This console does not know whether the book is accepting writes</strong>
            {freeze.detail ?? 'The ledger freeze state could not be read.'} It is reported as unknown rather than as
            &ldquo;accepting&rdquo;, because a screen that shows a healthy money plane it has never spoken to is the failure this page was
            rebuilt to remove.
          </div>
        )}
        <div className="adm-statrow">
          <StatBlock
            label="Posting"
            value={state ? (state.frozen ? 'HALTED' : 'ACCEPTING') : 'UNKNOWN'}
            deltaLabel={state ? (state.frozen ? 'all value movement stopped' : 'value moves') : 'not read from svc-ledger'}
          />
          <StatBlock label="Source" value={state ? 'svc-ledger' : 'none'} deltaLabel="via /api/ledger-freeze to svc-edge" />
          <StatBlock label="Scope required" value="admin:treasury" deltaLabel={treasury.tokenVar} />
          <StatBlock
            label="Credential transport"
            value={treasury.configured ? 'configured' : 'MISSING'}
            deltaLabel={treasury.configured ? consoleCopy('admin.console.transport.credential.fact') : treasury.missing.join(' + ')}
          />
        </div>
        <p className="adm-footnote">{consoleCopy('admin.console.transport.treasury.guards')}</p>
      </div>
    </Panel>
  );
}
