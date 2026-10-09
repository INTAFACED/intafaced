'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import { Panel, StatBlock } from '@intafaced/ui';
import type { Drop, ModuleId } from '@intafaced/config';
import { Chip } from '@/components/chip';
import { consoleCopy } from '@/lib/console-copy';
import { dropLabel } from '@/lib/drops';
import { ModuleStateInspector } from '@/components/module-state-inspector';
import { MODULE_WRITE_UNAVAILABLE, decodeSnapshot, unavailable, type ToggleInput } from '@/lib/control-plane-contract';
import { type ControlPlaneState, type KillSwitchSnapshot, postKillSwitch } from '@/lib/control-plane-browser';
import {
  CONTROL_EFFECT_LABEL,
  CRITICAL_FLAG_KEY,
  PROVENANCE_LABEL,
  darkButServing,
  diffStates,
  flagStates,
  groupByModule,
  isCritical,
  isEdgePerimeterModule,
  modulesWithoutKillSwitch,
  runtimeUnknown,
  type FlagState,
} from '@/lib/flag-state';

/**
 * KILL-SWITCH BOARD — §14.6 "Admin controls: kill-switch + config surface".
 *
 * Two kinds of switch on one board, and telling them apart is the whole job:
 *
 *   · MODULE rows inspect svc-edge. New writes require a human operator session,
 *     an identity-issued approval and original operation context, unavailable here.
 *   · FLAG rows are a session preview of what an override WOULD do. There is no
 *     durable flag store yet (§13), so flipping one changes this browser tab and
 *     nothing else, for ever, no matter how the console is configured.
 *
 * The second fact used to be stated in a footnote that appeared only AFTER a
 * flag had been flipped, and on the `ledger.posting` panel — the switch labelled
 * "halts ALL value movement platform-wide" — not at all. So the most dangerous
 * control on the board was also the one whose inertness was hardest to discover.
 * Every preview control now carries the word at the control (#447).
 *
 * ── THE OTHER HALF: what a row MEANS, not what its switch does ──────────────
 *
 * The paragraph above is about the SWITCH. This one is about the STATE beside
 * it, and they are different lies with different fixes — knowing that flipping a
 * row does nothing tells you nothing about whether the capability is running.
 *
 * #186 fixed WHERE a flip goes. #447 said what a flip is worth. Neither fixed
 * what a row REPORTS. Every flag was drawn the same way — a `Live`/`Dark` chip —
 * and only seven of them are read by anything at all. At the default
 * `LAUNCH_DROP=0` this board showed `protocol.amm`, `academy.inviteLobbies` and
 * `edge.gateway` as `Dark` while those procedures served traffic. An operator
 * does not distinguish "the registry says off" from "the capability is off";
 * nothing on the page invited them to. A preview switch that correctly says it
 * changes nothing, sitting beside a chip that says the capability is dark, still
 * sends an operator away believing the platform is stopped.
 *
 * So a row now also carries its `ControlEffect`, and an unenforced row is not
 * dressed as a control: no `Dark` chip, a disabled switch, and its planned value
 * shown as a plan. See `flag-state.ts` for the reasoning; see
 * `kill-switch-board.test.tsx` for the assertions that keep it true.
 *
 * This is deliberately NOT the kill-switch. A module kill is an emergency stop
 * and it is enforced at svc-edge; a launch flag is a staged rollout and mostly
 * is not enforced anywhere. Merging them would give the operator one lever with
 * two meanings, which is how the first lie got written.
 */

export interface KillSwitchBoardProps {
  drop: Drop;
  flagEnv: Record<string, string>;
  /** Server-loaded snapshot so first paint matches the edge. */
  initialControlPlane: ControlPlaneState;
}

export function moduleTogglePhrase(module: ModuleId, currentlyDisabled: boolean): string {
  return currentlyDisabled ? `RE-ENABLE ${module}` : `KILL ${module}`;
}

export interface ModuleCommandReceipt {
  readonly module: ModuleId;
  readonly disabled: boolean;
  readonly status: number;
  /** The snapshot returned by svc-edge, never a locally advanced state. */
  readonly snapshot: KillSwitchSnapshot;
}

export function KillSwitchBoard({ drop, flagEnv, initialControlPlane }: KillSwitchBoardProps) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [plane, setPlane] = useState(initialControlPlane);
  const [pendingModule, setPendingModule] = useState<ModuleId | null>(null);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ModuleCommandReceipt | null>(null);
  const [unresolvedIntent, setUnresolvedIntent] = useState<ToggleInput | null>(null);
  const [criticalArmed, setCriticalArmed] = useState(false);
  const [isPending, startTransition] = useTransition();
  const moduleCommandLockRef = useRef(false);

  const liveModules = plane.status === 'reachable' && decodeSnapshot(plane.snapshot) !== null;
  const disabledModules: ModuleId[] = liveModules ? [...plane.snapshot.disabledModules] : [];
  // Deployment credentials and a readable snapshot do not provide human authority.
  const moduleWritesAvailable = false;

  const baseline = useMemo(() => flagStates({ drop, env: flagEnv }), [drop, flagEnv]);
  const staged = useMemo(() => flagStates({ drop, env: flagEnv, overrides, disabledModules }), [drop, flagEnv, overrides, disabledModules]);

  const groups = useMemo(() => groupByModule(staged, disabledModules), [staged, disabledModules]);
  const changes = useMemo(() => diffStates(baseline, staged), [baseline, staged]);
  const uncovered = useMemo(() => modulesWithoutKillSwitch(), []);

  const liveCount = staged.filter((s) => s.enabled).length;
  const offClockCount = staged.filter((s) => s.def.drop === null).length;
  const critical = staged.find((s) => s.def.key === CRITICAL_FLAG_KEY);
  const enforcedCount = staged.filter((s) => s.effect !== 'none').length;
  const serving = useMemo(() => darkButServing(staged), [staged]);
  const unknown = useMemo(() => runtimeUnknown(staged), [staged]);
  const readFromPlatform = staged.filter((s) => s.stateAuthority === 'perimeter').length;

  function setFlag(key: string, value: boolean) {
    setOverrides((prev) => ({ ...prev, [key]: value }));
  }

  function clearFlag(key: string) {
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function requestModuleToggle(module: ModuleId) {
    if (!moduleWritesAvailable || !liveModules || unresolvedIntent) return;
    setPendingModule(module);
    setReason('');
    setConfirmation('');
    setActionError(null);
    setReceipt(null);
  }

  function applyModuleToggle() {
    if (!moduleWritesAvailable || unresolvedIntent) return;
    if (!pendingModule) return;
    if (moduleCommandLockRef.current) return;
    const trimmed = reason.trim();
    if (trimmed.length < 12) {
      setActionError('Reason must be at least 12 characters — an outage nobody can explain is worse.');
      return;
    }

    const nextDisabled = !disabledModules.includes(pendingModule);
    const expectedPhrase = moduleTogglePhrase(pendingModule, !nextDisabled);
    if (confirmation !== expectedPhrase) {
      setActionError(`Type ${expectedPhrase} exactly to confirm.`);
      return;
    }

    const commandModule = pendingModule;
    moduleCommandLockRef.current = true;
    setReceipt(null);
    startTransition(async () => {
      let outcomeUnresolved = false;
      try {
        const result = await postKillSwitch({ module: commandModule, disabled: nextDisabled, reason: trimmed });
        if (!result.ok) {
          if (result.uncertain) {
            outcomeUnresolved = true;
            setUnresolvedIntent(result.intent ?? { module: commandModule, disabled: nextDisabled, reason: trimmed });
            setPlane(
              unavailable(
                'unreachable',
                result.detail ?? 'Original module outcome is unresolved.',
                result.code ?? 'admin.kill_outcome_unknown',
              ),
            );
          }
          setActionError(result.detail ?? `kill-switch refused (${result.status})`);
          return;
        }
        setPlane({ status: 'reachable', snapshot: result.snapshot, detail: null });
        setReceipt({ module: commandModule, disabled: nextDisabled, status: result.status, snapshot: result.snapshot });
        setPendingModule(null);
        setReason('');
        setConfirmation('');
        setActionError(null);
      } finally {
        // A transport failure does not authorize replay. The helper retains its
        // original intent; a later read or audit cannot settle that operation.
        if (!outcomeUnresolved) moduleCommandLockRef.current = false;
      }
    });
  }

  function reset() {
    if (unresolvedIntent || moduleCommandLockRef.current) return;
    setOverrides({});
    setCriticalArmed(false);
    setPendingModule(null);
    setReason('');
    setConfirmation('');
    setActionError(null);
    setReceipt(null);
  }

  return (
    <>
      <div className="adm-pagehead">
        <div>
          <h1>Kill-switches</h1>
          <p>
            {FLAG_COUNT_COPY} Resolved at {dropLabel(drop)} <em>from the registry</em>.{' '}
            <strong>
              {enforcedCount} of {staged.length}
            </strong>{' '}
            of these flags are read by anything; the rest are §11 launch-plan entries whose capability serves whatever this page says. Of
            the ones that are enforced, none is enforced <em>from here</em> — they follow a service environment variable this console cannot
            see. The inspector reads <strong>module</strong> state from svc-edge; module writes require operator and approval prerequisites
            unavailable in this desk. Per-flag overrides stay session-staged until the flag store lands.
          </p>
        </div>
        <div className="adm-inline">
          <button
            type="button"
            className="adm-btn"
            onClick={reset}
            disabled={!!unresolvedIntent || (changes.length === 0 && !pendingModule)}
          >
            Reset staged flags
          </button>
        </div>
      </div>

      <ModuleStateInspector plane={plane} onRead={setPlane} />

      <details className="mi-registry">
        <summary>Flag registry and session previews</summary>
        <ControlPlanePanel plane={plane} />

        <ServingWhileDarkPanel states={serving} total={staged.length} />

        <RuntimeUnknownPanel states={unknown} />

        <Panel title="Platform state" live={liveModules}>
          <div className="adm-statrow">
            {/* "Flags live" is a registry count and says so. It was previously the
              first number on the page and read as a count of live CAPABILITIES,
              which is what made every other panel plausible. */}
            <StatBlock label="Flags on in registry" value={`${liveCount} / ${staged.length}`} deltaLabel="not a capability count" />
            <StatBlock label="Flags anything reads" value={`${enforcedCount} / ${staged.length}`} deltaLabel="the rest gate nothing" />
            <StatBlock
              label="States read from the platform"
              value={liveModules ? `${readFromPlatform} / ${staged.length}` : 'Unknown'}
              deltaLabel="the rest are registry values"
            />
            <StatBlock label="Off the drop clock" value={offClockCount} deltaLabel="never on by default" />
            <StatBlock label="Modules killed (returned snapshot)" value={liveModules ? disabledModules.length : 'Unknown'} />
            <StatBlock label="Staged flag changes" value={changes.length} />
            <StatBlock label="Env overrides" value={Object.keys(flagEnv).length} deltaLabel="INTAFACED_FLAG_*" />
          </div>
        </Panel>

        {pendingModule && (
          <Panel
            title={`Confirm module ${disabledModules.includes(pendingModule) ? 're-enable' : 'kill'}: ${pendingModule}`}
            className="adm-panel--warn"
          >
            <div className="adm-stack">
              <p className="adm-footnote">
                This hits <code>POST /api/kill-switch</code> → svc-edge. Cancels and reads still pass; new commitments on this module refuse
                with 503. Reason is required on the edge (≥ 12 characters).
              </p>
              <label className="adm-stack">
                <span className="adm-meta">Reason</span>
                <textarea
                  className="adm-textarea"
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. incident: halt new trade risk while investigating fill anomaly"
                  disabled={isPending}
                />
              </label>
              <div className="adm-field">
                <label htmlFor="module-toggle-confirmation">
                  Type <code>{moduleTogglePhrase(pendingModule, disabledModules.includes(pendingModule))}</code> to confirm
                </label>
                <input
                  id="module-toggle-confirmation"
                  className="adm-input"
                  value={confirmation}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={isPending}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </div>
              {actionError && (
                <div className="adm-callout" data-tone="danger">
                  <strong>{unresolvedIntent ? 'Original outcome unresolved' : 'Request refused'}</strong>
                  {actionError}
                </div>
              )}
              <div className="adm-inline">
                <button
                  type="button"
                  className="adm-btn"
                  data-tone="danger"
                  onClick={applyModuleToggle}
                  disabled={
                    !moduleWritesAvailable ||
                    !!unresolvedIntent ||
                    isPending ||
                    reason.trim().length < 12 ||
                    confirmation !== moduleTogglePhrase(pendingModule, disabledModules.includes(pendingModule))
                  }
                >
                  {isPending ? 'Sending…' : disabledModules.includes(pendingModule) ? 'Re-enable module' : 'Kill module now'}
                </button>
                <button
                  type="button"
                  className="adm-btn"
                  onClick={() => {
                    setPendingModule(null);
                    setConfirmation('');
                    setActionError(null);
                  }}
                  disabled={isPending || !!unresolvedIntent}
                >
                  Cancel
                </button>
              </div>
            </div>
          </Panel>
        )}

        {receipt && (
          <Panel title="Returned service snapshot" actions={<Chip tone="info">transport answered</Chip>}>
            <ModuleCommandReceiptView receipt={receipt} />
          </Panel>
        )}

        {critical && <CriticalSwitch state={critical} armed={criticalArmed} onArm={setCriticalArmed} onSet={setFlag} onClear={clearFlag} />}

        {changes.length > 0 && (
          <Panel title={`Staged — ${changes.length} flag${changes.length === 1 ? '' : 's'} would change`} className="adm-panel--warn">
            <div className="adm-stack">
              <div className="adm-scroll" tabIndex={0} role="region" aria-label="Flag and module inspector table">
                <table className="adm-table">
                  <thead>
                    <tr>
                      <th>Flag</th>
                      <th>Now</th>
                      <th>After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {changes.map((change) => (
                      <tr key={change.key} data-critical={isCritical(change.key)}>
                        <td className="adm-key">{change.key}</td>
                        <td>
                          <StateChip on={change.from} />
                        </td>
                        <td>
                          <StateChip on={change.to} critical={isCritical(change.key) && !change.to} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="adm-footnote">{stageNotice}</p>
            </div>
          </Panel>
        )}

        {liveModules && plane.snapshot.audit.length > 0 && (
          <Panel title="Historical kill-switch audit (returned order)">
            <div className="adm-scroll" tabIndex={0} role="region" aria-label="Flag and module inspector table">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Module</th>
                    <th>Actor</th>
                    <th>Change</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {plane.snapshot.audit.slice(0, 12).map((entry, i) => (
                    <tr key={`${entry.at}-${entry.module}-${i}`}>
                      <td className="adm-meta">{entry.at}</td>
                      <td className="adm-key">{entry.module}</td>
                      <td className="adm-meta">{entry.actor}</td>
                      <td>
                        {entry.previous ? 'killed' : 'live'} → {entry.next ? 'killed' : 'live'}
                        {!entry.changed && <span className="adm-meta"> (no-op)</span>}
                      </td>
                      <td className="adm-desc">{entry.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}

        <Panel
          title="Flags by module"
          actions={
            <Chip tone="warn" dot>
              Flag switches: preview only
            </Chip>
          }
        >
          <div className="adm-callout" data-tone="warn">
            <strong>The per-flag switches in this table change nothing outside this browser tab</strong>
            {stageNotice}
          </div>
          <div className="adm-scroll" tabIndex={0} role="region" aria-label="Flag and module inspector table">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Flag</th>
                  <th>Description</th>
                  <th>Drop</th>
                  <th>State</th>
                  {/* Added because the four columns to the left described the
                    registry and nothing described the platform. */}
                  <th>Enforced by</th>
                  <th>Decided by</th>
                  <th>Switch — preview only</th>
                </tr>
              </thead>
              {groups.map((group) => (
                <tbody key={group.module}>
                  <tr>
                    <td className="adm-subhead" colSpan={7}>
                      <span className="adm-subhead__row">
                        <span>{group.module}</span>
                        <span className="adm-meta">
                          {group.service} · phase {group.phase} · {group.planes.join(' + ')}
                        </span>
                        {group.custodial ? <Chip tone="warn">Custodial</Chip> : <Chip tone="info">Non-custodial</Chip>}
                        <Chip tone={group.flags.some((f) => f.enabled) ? 'live' : 'dark'}>
                          {group.flags.filter((f) => f.enabled).length} / {group.flags.length} live
                        </Chip>
                        <span className="adm-topbar__spacer" />
                        {group.killed && <Chip tone="danger">Module killed</Chip>}
                        {isEdgePerimeterModule(group.module) ? (
                          <Chip tone="live">Edge perimeter</Chip>
                        ) : (
                          <Chip tone="warn">Not edge-enforced</Chip>
                        )}
                        <Chip tone="warn">Module write unavailable</Chip>
                        <Switch
                          on={!group.killed}
                          onLabel={liveModules ? 'Not listed as killed' : 'Unknown'}
                          offLabel="Listed as killed"
                          disabled={!moduleWritesAvailable || isPending || !!unresolvedIntent}
                          // The reason travels with the control. A disabled switch
                          // with no explanation reads as a broken console.
                          title={MODULE_WRITE_UNAVAILABLE}
                          onToggle={() => requestModuleToggle(group.module)}
                        />
                      </span>
                    </td>
                  </tr>

                  {group.flags.map((state) => (
                    <FlagRow
                      key={state.def.key}
                      state={state}
                      moduleKilled={group.killed}
                      criticalArmed={criticalArmed}
                      onSet={setFlag}
                      onClear={clearFlag}
                    />
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        </Panel>
      </details>

      <Panel title="Modules with no kill-switch" className="adm-panel--warn">
        {uncovered.length === 0 ? (
          <p className="adm-footnote">Every module in the registry declares at least one flag.</p>
        ) : (
          <div className="adm-stack">
            <div className="adm-callout" data-tone="warn">
              <strong>{uncovered.length} module(s) cannot satisfy §14.6 as written</strong>
              These module ids appear in <code>MODULES</code> but in no entry of <code>FLAG_REGISTRY</code>, so there is nothing for an
              operator to switch off. <code>tooling/ci/dod-gate.mjs</code> fails a service on exactly this condition, so each of these is a
              blocked Definition of Done the day its service lands.
            </div>
            <div className="adm-inline">
              {uncovered.map((id) => (
                <Chip key={id} tone="warn">
                  {id}
                </Chip>
              ))}
            </div>
          </div>
        )}
      </Panel>
    </>
  );
}

export function ModuleCommandReceiptView({ receipt }: { receipt: ModuleCommandReceipt }) {
  const audit = receipt.snapshot.audit.find((entry) => entry.module === receipt.module);
  const returnedDisabled = receipt.snapshot.disabledModules.includes(receipt.module);

  return (
    <div className="adm-stack" data-testid="module-command-receipt">
      <p className="adm-footnote">
        Returned snapshot only. Historical audit is not a current command receipt. The original operation and current human identity cannot
        be looked up through this contract.
      </p>
      <dl className="adm-kv">
        <dt>Module</dt>
        <dd>{receipt.module}</dd>
        <dt>Requested</dt>
        <dd>{receipt.disabled ? 'killed' : 'live'}</dd>
        <dt>Returned state</dt>
        <dd>{returnedDisabled ? 'killed' : 'live'}</dd>
        <dt>Transport</dt>
        <dd>HTTP {receipt.status}</dd>
        <dt>Historical change</dt>
        <dd>{audit ? (audit.changed ? 'changed' : 'no-op') : 'not returned'}</dd>
        <dt>Historical actor</dt>
        <dd>{audit?.actor ?? 'not returned'}</dd>
        <dt>Historical time</dt>
        <dd>{audit?.at ?? 'not returned'}</dd>
        <dt>Historical reason</dt>
        <dd>{audit?.reason ?? receipt.snapshot.reasons[receipt.module] ?? 'not returned'}</dd>
      </dl>
    </div>
  );
}

function ControlPlanePanel({ plane }: { plane: ControlPlaneState }) {
  const tone = plane.status === 'reachable' ? 'info' : plane.status === 'unconfigured' ? 'warn' : 'danger';
  const title = consoleCopy(
    plane.status === 'reachable'
      ? 'admin.console.plane.reachable'
      : plane.status === 'unconfigured'
        ? 'admin.console.plane.unconfigured'
        : 'admin.console.plane.unreachable',
  );

  return (
    <Panel title={title} className={plane.status === 'reachable' ? undefined : 'adm-panel--warn'}>
      <div className="adm-stack">
        <div className="adm-callout" data-tone={tone}>
          <strong>{plane.status}</strong>
          {plane.status === 'reachable' && (
            <>
              This snapshot was read from svc-edge. It reports <b>{plane.snapshot.disabledModules.length}</b> modules listed as killed; it
              does not report fleet or service health. {MODULE_WRITE_UNAVAILABLE} Per-flag staging stays local.
            </>
          )}
          {plane.status === 'unconfigured' && (
            <>
              {/* `detail` names the variable that is ACTUALLY missing. The old
                  copy always said "set EDGE_URL and ADMIN_OPERATOR_TOKEN", which
                  sends an operator to check a setting that was already right. */}
              {plane.detail ?? 'This console holds no credential for the control plane.'} No current module state was read.{' '}
              {MODULE_WRITE_UNAVAILABLE}
            </>
          )}
          {plane.status !== 'reachable' && plane.status !== 'unconfigured' && (
            <>
              {plane.detail ?? 'No valid current module snapshot was returned.'} No current module state is shown.{' '}
              {MODULE_WRITE_UNAVAILABLE}
            </>
          )}
        </div>
        {plane.detail && plane.status === 'reachable' && <p className="adm-footnote">{plane.detail}</p>}
        <p className="adm-footnote">
          Operator runbook: <code>docs/OPS-KILL-SWITCH-RUNBOOK.md</code>
        </p>
      </div>
    </Panel>
  );
}

const FLAG_COUNT_COPY = 'Every flag declared in the registry, grouped by the module that owns it.';

const stageNotice =
  'Per-flag switches stage a preview in this browser session and are read by no service — there is no durable flag store yet (§13 socket). ' +
  'Module writes are unavailable here until real operator, approval and original operation prerequisites are supplied. ' +
  'To halt all value movement use Ledger ops, which writes an attributed freeze row in svc-ledger. ' +
  'And note that the flag store would change nothing for a flag marked "Not a control": no service resolves flags, ' +
  'so there is nothing on the far end to push to.';

// ── Rows ────────────────────────────────────────────────────────────────────

function FlagRow({
  state,
  moduleKilled,
  criticalArmed,
  onSet,
  onClear,
}: {
  state: FlagState;
  moduleKilled: boolean;
  criticalArmed: boolean;
  onSet: (key: string, value: boolean) => void;
  onClear: (key: string) => void;
}) {
  const critical = isCritical(state.def.key);
  const unenforced = state.effect === 'none';
  // Turning the ledger's posting switch off is the one action on this board with
  // a platform-wide blast radius, so it stays locked until the operator has
  // acknowledged that in the panel above.
  //
  // `unenforced` joins that list for the opposite reason: not because the action
  // is dangerous, but because it is inert. A switch that moves and changes
  // nothing teaches an operator that the board works.
  const locked = moduleKilled || unenforced || (critical && state.enabled && !criticalArmed);

  return (
    <tr data-critical={critical} data-killed={moduleKilled} data-effect={state.effect}>
      <td className="adm-key">{state.def.key}</td>
      <td className="adm-desc">
        {state.def.description}
        {critical && <strong> — flipping this OFF halts ALL value movement platform-wide.</strong>}
      </td>
      <td className="adm-num">{state.def.drop === null ? '—' : state.def.drop}</td>
      <td>
        <RowStateCell state={state} critical={critical} />
      </td>
      <td>
        <EnforcementCell state={state} />
      </td>
      <td>
        <Chip tone={state.provenance === 'kill-switch' ? 'danger' : state.provenance === 'override' ? 'warn' : 'neutral'}>
          {PROVENANCE_LABEL[state.provenance]}
        </Chip>
      </td>
      <td>
        <span className="adm-inline">
          <Switch
            on={state.enabled}
            critical={critical}
            disabled={locked}
            preview
            // Both, and the order matters: `Switch` prefers an explicit `title`
            // over the generic preview text, so an inert row explains WHY it is
            // disabled and every other row still says it is preview-only.
            title={unenforced ? state.note : undefined}
            onLabel="On"
            offLabel="Off"
            onToggle={() => onSet(state.def.key, !state.enabled)}
          />
          <Chip tone="dark">Preview</Chip>
          {state.provenance === 'override' && (
            <button type="button" className="adm-btn" onClick={() => onClear(state.def.key)}>
              Clear
            </button>
          )}
        </span>
      </td>
    </tr>
  );
}

/**
 * THE `State` CELL — and the one place on this board that must not overclaim.
 *
 * `Live` and `Dark` are words about a CAPABILITY. Only one row on this page has
 * earned them: a module the operator killed, where the killed set was read back
 * from svc-edge and the perimeter is refusing right now. Everything else is a
 * `FLAG_REGISTRY` value, and says so:
 *
 *   · nothing reads the flag        → `Planned on/off`, and it is serving
 *   · a service env var reads it    → `Registry on/off`, and we cannot see it
 *
 * The second case is the one the enforcement column alone still got wrong.
 * Naming `NOTIFY_FANOUT_ENABLED` as the real switch is not the same as knowing
 * which way it is set — it lives on svc-notify, defaults to on, and this
 * console has never read a service's environment.
 */
function RowStateCell({ state, critical }: { state: FlagState; critical: boolean }) {
  if (state.stateAuthority === 'perimeter') {
    return (
      <span className="adm-inline">
        <StateChip on={state.enabled} critical={critical && !state.enabled} />
        <span className="adm-meta">read from svc-edge</span>
      </span>
    );
  }

  if (state.effect === 'none') {
    return (
      <span className="adm-inline">
        <Chip tone="neutral" title={state.note}>
          {state.enabled ? 'Planned on' : 'Planned off'}
        </Chip>
        <span className="adm-meta">serving</span>
      </span>
    );
  }

  return (
    <span className="adm-inline">
      <Chip tone="neutral" title={state.note}>
        {state.enabled ? 'Registry on' : 'Registry off'}
      </Chip>
      <span className="adm-meta">not read from the service</span>
    </span>
  );
}

function EnforcementCell({ state }: { state: FlagState }) {
  const { enforcement, note } = state;

  if (enforcement.kind === 'none') {
    return (
      <Chip tone="warn" title={note}>
        {CONTROL_EFFECT_LABEL.none}
      </Chip>
    );
  }

  return (
    <span className="adm-inline">
      <Chip tone={enforcement.kind === 'operator-api' ? 'live' : 'info'} title={note}>
        {CONTROL_EFFECT_LABEL[state.effect]}
      </Chip>
      <code className="adm-meta">{enforcement.envVar}</code>
    </span>
  );
}

/**
 * The count an operator needs before trusting anything else on this page.
 *
 * Rendered near the top rather than as a footnote: the number this panel
 * reports was 39 of 46 at the drop the platform actually runs at, and a
 * footnote-sized disclosure of that is another way of not saying it.
 */
function ServingWhileDarkPanel({ states, total }: { states: readonly FlagState[]; total: number }) {
  if (states.length === 0) {
    return (
      <Panel title="Flags that gate nothing">
        <p className="adm-footnote">Every flag reported off on this page is held off by something. Nothing here is decoration.</p>
      </Panel>
    );
  }

  return (
    <Panel title={`${states.length} of ${total} flags read off — and the capability is serving`} className="adm-panel--warn">
      <div className="adm-stack">
        <div className="adm-callout" data-tone="warn">
          <strong>These rows are launch plan, not control</strong>
          Nothing in <code>services/*</code> resolves a feature flag. For the flags below, <code>isEnabled()</code> returns false and the
          procedure answers anyway — <code>protocol.amm</code> quotes, <code>academy.inviteLobbies</code> seats users,{' '}
          <code>edge.gateway</code> proxies every request in the platform. Their switches are disabled here because there is nothing on the
          other end of them. To actually stop one of these, kill its <strong>module</strong> above through an authorized operator and
          approval workflow (unavailable in this desk), or take the service down.
        </div>
        <div className="adm-inline">
          {states.map((state) => (
            <Chip key={state.def.key} tone="dark" title={`${state.def.module} · ${state.def.description}`}>
              {state.def.key}
            </Chip>
          ))}
        </div>
      </div>
    </Panel>
  );
}

/**
 * The rows with a real switch that this console cannot see the position of.
 *
 * Separate from the panel above on purpose. There, the honest answer is "this
 * will not stop, ever, from here". Here it is "something can stop it, and you
 * must ask the service which way it is set" — and the two send an operator to
 * different places. Collapsing them into one "we are not sure" list would lose
 * the only actionable half.
 *
 * `NOTIFY_FANOUT_ENABLED` and `INDEXER_INGEST_ENABLED` both default to on, so
 * the likeliest reading of a `Dark` chip here was also the wrong one.
 */
function RuntimeUnknownPanel({ states }: { states: readonly FlagState[] }) {
  if (states.length === 0) return null;

  return (
    <Panel title={`${states.length} flags whose real state this console cannot read`}>
      <div className="adm-stack">
        <div className="adm-callout" data-tone="warn">
          <strong>Enforced, but not from here</strong>
          Each of these is genuinely gated — by an environment variable read once at that service&rsquo;s boot, defaulting to on. This
          console reads <code>INTAFACED_FLAG_*</code> off its own process only, so it has never seen those variables. The state beside them
          is what the registry resolves, not what the service is doing. To learn the truth, read the variable on the service; to change it,
          set it and restart.
        </div>
        <div className="adm-inline">
          {states.map((state) => (
            <Chip key={state.def.key} tone="info" title={state.note}>
              {state.def.key} · {state.enforcement.kind === 'none' ? '—' : state.enforcement.envVar}
            </Chip>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function StateChip({ on, critical = false }: { on: boolean; critical?: boolean }) {
  if (on)
    return (
      <Chip tone="live" dot>
        {'Live'}
      </Chip>
    );
  return (
    <Chip tone={critical ? 'danger' : 'dark'} dot={critical}>
      {critical ? 'HALTED' : 'Dark'}
    </Chip>
  );
}

function Switch({
  on,
  onLabel,
  offLabel,
  onToggle,
  critical = false,
  disabled = false,
  preview = false,
  title,
}: {
  on: boolean;
  onLabel: string;
  offLabel: string;
  onToggle: () => void;
  critical?: boolean;
  disabled?: boolean;
  /** True when flipping this changes only this browser session. */
  preview?: boolean;
  /**
   * Why this switch is disabled. A dead control must say so on hover, not only
   * in a panel. Takes precedence over the generic preview text below: "nothing
   * reads this flag" is more specific than "this is a preview", and the operator
   * hovering a greyed-out switch is asking the specific question.
   */
  title?: string;
}) {
  return (
    <button
      type="button"
      className="adm-switch"
      data-on={on}
      data-critical={critical}
      data-preview={preview}
      disabled={disabled}
      aria-pressed={on}
      // Announced by a screen reader and shown on hover. A switch that stages a
      // preview and a switch that halts a market must not present identically.
      aria-description={preview ? 'Preview only — changes this browser session, not the platform' : undefined}
      title={title ?? (preview ? 'Preview only — changes this browser session, not the platform' : undefined)}
      onClick={onToggle}
    >
      <span>{onLabel}</span>
      <span>{offLabel}</span>
    </button>
  );
}

// ── The one switch that stops the platform ──────────────────────────────────

function CriticalSwitch({
  state,
  armed,
  onArm,
  onSet,
  onClear,
}: {
  state: FlagState;
  armed: boolean;
  onArm: (value: boolean) => void;
  onSet: (key: string, value: boolean) => void;
  onClear: (key: string) => void;
}) {
  return (
    <Panel
      title="ledger.posting — platform-wide value movement"
      className="adm-panel--warn"
      // Two claims to get right, and #447 only fixed the first. "Preview only"
      // is about the BUTTONS — flipping them changes this browser tab. The chip
      // beside it is about the STATE, and a bare `StateChip` here would say
      // HALTED/Live as if the console had asked svc-ledger, which it has not:
      // `posting_freeze` is a durable row on that service and `Ledger ops` is
      // what reaches it. `RowStateCell` reports the registry's answer AS the
      // registry's answer.
      actions={
        <span className="adm-inline">
          <Chip tone="warn" dot>
            Preview only
          </Chip>
          <RowStateCell state={state} critical />
        </span>
      }
    >
      <div className="adm-stack">
        {/*
          THE MOST MISLEADING CONTROL IN THE CONSOLE, BEFORE THIS.

          A panel styled as the platform's emergency stop, a "Halt posting"
          button behind an acknowledgement checkbox, and a flag switch underneath
          it — all of which set `overrides` in this component's React state. It
          read exactly like the money plane's kill and it was a browser boolean,
          and nothing on the panel said otherwise.

          It is kept, because seeing the resolved value of `ledger.posting` and
          WHY it resolved that way is genuinely useful. It is de-escalated: warn
          rather than danger, "preview" in the title bar, and the real control
          named with a link, so an operator who came here to stop the platform
          leaves this panel and goes to the one that can.
        */}
        <div className="adm-callout" data-tone="warn">
          <strong>This panel halts nothing — it previews a flag</strong>
          The buttons below stage a value for <code>ledger.posting</code> in this browser session. There is no durable flag store (§13), so
          no service ever reads what is staged here. <b>To actually stop value movement, use Ledger ops</b> — that screen posts to
          <code> /api/ledger-freeze</code> and svc-ledger writes a durable, attributed <code>posting_freeze</code> row.
        </div>

        <div className="adm-callout" data-tone="danger">
          <strong>What the real freeze does</strong>
          Every module posts through the ledger. Freezing it halts ALL value movement platform-wide — trade fills, payouts, escrow releases,
          card authorisations, staking, settlement — at once and without warning to users. It is the correct action after a reconciliation
          mismatch (§4.2: an unverifiable book must stop accepting writes) and the wrong action for anything smaller.
        </div>

        <div className="adm-inline">
          <a className="adm-btn" data-tone="danger" href="/ledger">
            Go to Ledger ops — the freeze that works
          </a>
        </div>

        <div className="adm-inline">
          <label className="adm-check">
            <input type="checkbox" checked={armed} onChange={(event) => onArm(event.target.checked)} />
            <span>I understand the two buttons below only stage a preview in this browser and halt nothing.</span>
          </label>
        </div>

        <div className="adm-inline">
          <button
            type="button"
            className="adm-btn"
            disabled={!armed || !state.enabled}
            title="Preview only — changes this browser session, not the platform"
            onClick={() => onSet(state.def.key, false)}
          >
            Preview OFF
          </button>
          <button
            type="button"
            className="adm-btn"
            disabled={state.enabled}
            title="Preview only — changes this browser session, not the platform"
            onClick={() => onSet(state.def.key, true)}
          >
            Preview ON
          </button>
          {state.provenance === 'override' && (
            <button type="button" className="adm-btn" onClick={() => onClear(state.def.key)}>
              Clear override
            </button>
          )}
          <span className="adm-footnote">
            Decided by <b>{PROVENANCE_LABEL[state.provenance]}</b>.
          </span>
        </div>
      </div>
    </Panel>
  );
}
