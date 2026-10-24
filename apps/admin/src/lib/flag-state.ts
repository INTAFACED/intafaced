import {
  FLAG_REGISTRY,
  MODULE_IDS,
  MODULES,
  enforcementNote,
  enforcementOf,
  isEnabled,
  resolveAll,
  type FlagContext,
  type FlagDef,
  type FlagEnforcement,
  type ModuleId,
} from '@intafaced/config';

/**
 * Flag state, as an operator needs to read it.
 *
 * `resolveAll()` answers "is it on?". It does not answer "why?", and on a
 * kill-switch board the second question is the one that matters — an operator
 * who cannot tell an env override from a drop default will flip the wrong
 * thing. Everything below DERIVES the answer by re-asking the real
 * `isEnabled()` with narrowed contexts. No resolution logic is reimplemented
 * here, and no flag is listed here that is not in `FLAG_REGISTRY`.
 *
 * ── The third question, and why this file changed ───────────────────────────
 *
 * "Is it on?" and "why?" were both answered, and the board was still wrong,
 * because it never asked **"does this state describe the platform?"**.
 *
 * No file under `services/*` resolves a flag. So `resolveAll()` returned
 * `protocol.amm: false` at the default `LAUNCH_DROP=0`, the board rendered
 * that as a `Dark` chip next to a switch, and the AMM procedures answered
 * every request anyway. An operator reading this console believed a capability
 * was off. It was serving.
 *
 * `ControlEffect` is that third answer, and the board renders it beside every
 * state. A row whose effect is `none` is a launch-plan entry: it gets no chip
 * that could be read as "this capability is off", and its switch is disabled —
 * a control that moves and does nothing is the exact failure found here.
 */

export type Provenance =
  /** Module kill-switch is off — beats everything else (§14). */
  | 'kill-switch'
  /** An explicit override in this console session. */
  | 'override'
  /** An `INTAFACED_FLAG_*` variable on the running process. */
  | 'env'
  /** The current LAUNCH_DROP has reached the flag's drop. */
  | 'drop'
  /** The drop clock has not reached it yet. */
  | 'awaiting-drop'
  /** `drop === null` — never on by default, at any drop. */
  | 'off-clock';

export const PROVENANCE_LABEL: Readonly<Record<Provenance, string>> = {
  'kill-switch': 'Module kill-switch',
  override: 'Operator override',
  env: 'Env override',
  drop: 'Drop reached',
  'awaiting-drop': 'Awaiting drop',
  'off-clock': 'Off the drop clock',
};

/**
 * What happens if an operator moves this control.
 *
 * Not a restatement of `Provenance`. Provenance says which input decided the
 * registry's value; this says whether the platform is listening at all.
 */
export type ControlEffect =
  /** Reachable now, from this console, without a deploy. `ledger.posting` only. */
  | 'live'
  /** A real refusal exists, but it follows a service env var — needs a restart. */
  | 'restart'
  /** Nothing reads this flag. Moving anything here changes nothing. */
  | 'none';

export const CONTROL_EFFECT_LABEL: Readonly<Record<ControlEffect, string>> = {
  live: 'Live control',
  restart: 'Restart to apply',
  none: 'Not a control',
};

/**
 * WHOSE ANSWER IS THE `State` COLUMN?
 *
 * The half the enforcement model above still got wrong. Knowing that
 * `NOTIFY_FANOUT_ENABLED` is the real switch does not tell this page which way
 * that switch is set — the console reads `INTAFACED_FLAG_*` off **its own**
 * process (`operator-env.ts`) and has never read a service's environment. So
 * for `notify.fanout` and `indexer.ingest` the board drew a `Dark` chip from a
 * registry value while the variable that actually decides defaults to ON and
 * the fan-out was running. A smaller lie than `protocol.amm`, told the same way.
 *
 * There is exactly one thing on this page that IS read back from the platform:
 * the killed-module set, fetched from svc-edge. When a module is killed the
 * perimeter really is refusing new commitments, so that row may speak about the
 * capability. Every other row may speak only about the registry, and now says
 * which it is doing.
 */
export type StateAuthority =
  /** Read back from svc-edge — the perimeter is refusing this module right now. */
  | 'perimeter'
  /** Resolved from `FLAG_REGISTRY`. Nothing on this page read the capability. */
  | 'registry';

/**
 * FAILS CLOSED, in the honesty direction.
 *
 * `enforcementOf()` returns `NOT_ENFORCED` for anything it cannot place, so a
 * key this console cannot resolve is drawn as a plan entry — never as a live
 * gate. The console must never claim more control than the platform has.
 */
export function controlEffect(enforcement: FlagEnforcement): ControlEffect {
  switch (enforcement.kind) {
    case 'operator-api':
      return 'live';
    case 'service-env':
      return 'restart';
    default:
      return 'none';
  }
}

export interface FlagState {
  readonly def: FlagDef;
  readonly enabled: boolean;
  readonly provenance: Provenance;
  /** What this flag would be with no overrides at all — the drop-clock answer. */
  readonly baseline: boolean;
  /** What refuses when this is off, from the registry. */
  readonly enforcement: FlagEnforcement;
  /** Whether moving this control does anything. */
  readonly effect: ControlEffect;
  /** One sentence for the operator, at the control rather than in a doc. */
  readonly note: string;
  /** Whether `enabled` describes the platform or only the registry. */
  readonly stateAuthority: StateAuthority;
  /**
   * True when the registry says off and nothing is holding it off — i.e. the
   * capability is serving while the board reports it dark. This is the lie the
   * board used to tell, named so it can be rendered and counted.
   */
  readonly darkButServing: boolean;
  /**
   * True when a real switch exists but this console cannot see which way it is
   * set — a service env var, read at that service's boot, defaulting to on.
   *
   * Weaker than `darkButServing`, and kept separate for that reason: there we
   * can prove the capability is serving, here we can only prove we do not know.
   * Both are dishonest to render as `Dark`; only one is dishonest to render as
   * "not a control".
   */
  readonly runtimeUnknown: boolean;
}

/** The blast radius of the ledger's posting switch is the whole platform. */
export const CRITICAL_FLAG_KEY = 'ledger.posting';

export function isCritical(key: string): boolean {
  return key === CRITICAL_FLAG_KEY;
}

function provenanceOf(def: FlagDef, ctx: FlagContext): Provenance {
  if (ctx.disabledModules?.includes(def.module)) return 'kill-switch';
  if (ctx.overrides?.[def.key] !== undefined) return 'override';

  // Ask the real resolver whether env alone changes the answer. If dropping the
  // env slice flips the result, the env slice is what decided it.
  const withEnv = isEnabled(def.key, { drop: ctx.drop, env: ctx.env });
  const withoutEnv = isEnabled(def.key, { drop: ctx.drop });
  if (withEnv !== withoutEnv) return 'env';

  if (def.drop === null) return 'off-clock';
  return withoutEnv ? 'drop' : 'awaiting-drop';
}

export function flagStates(ctx: FlagContext): FlagState[] {
  const resolved = resolveAll(ctx);
  return FLAG_REGISTRY.map((def) => {
    const enabled = resolved[def.key] === true;
    const enforcement = enforcementOf(def.key);
    const provenance = provenanceOf(def, ctx);

    // A module kill-switch IS enforced at svc-edge, so a killed module on an
    // edge-routed prefix is genuinely refusing new commitments even when the
    // flag itself gates nothing. That is the one row on this page whose state
    // was read back from the platform rather than computed from the registry.
    const killedAtPerimeter = provenance === 'kill-switch' && isEdgePerimeterModule(def.module);

    return {
      def,
      enabled,
      provenance,
      baseline: isEnabled(def.key, { drop: ctx.drop }),
      enforcement,
      effect: controlEffect(enforcement),
      note: enforcementNote(def.key),
      stateAuthority: killedAtPerimeter ? 'perimeter' : 'registry',
      darkButServing: !enabled && enforcement.kind === 'none' && provenance !== 'kill-switch',
      runtimeUnknown: enforcement.kind === 'service-env' && !killedAtPerimeter,
    };
  });
}

/**
 * Every row where the board would otherwise report a capability as off while it
 * serves. Rendered as a panel — an operator should not have to read a table to
 * find out how much of the board is decoration.
 */
export function darkButServing(states: readonly FlagState[]): FlagState[] {
  return states.filter((s) => s.darkButServing);
}

/**
 * Rows with a real switch this console cannot read. Listed beside the ones that
 * gate nothing, because an operator asking "what is actually off right now?"
 * gets the same useless answer from both — and the honest reply is different in
 * each case: "nothing was ever going to stop" versus "ask the service".
 */
export function runtimeUnknown(states: readonly FlagState[]): FlagState[] {
  return states.filter((s) => s.runtimeUnknown);
}

/**
 * Every row whose `enabled` is a registry fact rather than a platform fact.
 *
 * FAILS CLOSED IN THE HONESTY DIRECTION. Membership is the default: a row earns
 * its way OUT of this set only by being killed at a perimeter this console read
 * back. A flag whose state cannot be determined is therefore never presented as
 * a determined state — in either direction, so a capability is never drawn as
 * off any more than it is drawn as on.
 */
export function stateNotReadFromPlatform(states: readonly FlagState[]): FlagState[] {
  return states.filter((s) => s.stateAuthority === 'registry');
}

export interface ModuleGroup {
  readonly module: ModuleId;
  readonly service: string;
  readonly phase: string;
  readonly planes: readonly string[];
  readonly custodial: boolean;
  readonly killed: boolean;
  readonly flags: readonly FlagState[];
}

/** Grouped in `MODULE_IDS` order, which is phase order — the build order (§12). */
export function groupByModule(states: readonly FlagState[], disabledModules: readonly ModuleId[]): ModuleGroup[] {
  return MODULE_IDS.map((id) => {
    const def = MODULES[id];
    return {
      module: id,
      service: def.service,
      phase: def.phase,
      planes: def.planes,
      custodial: def.custodial,
      killed: disabledModules.includes(id),
      flags: states.filter((s) => s.def.module === id),
    };
  }).filter((g) => g.flags.length > 0);
}

/**
 * Modules that declare no flag at all. §14.6 requires a kill-switch per module,
 * and `tooling/ci/dod-gate.mjs` fails a service whose module id never appears in
 * `flags.ts` — so this list is the set of modules that cannot ship as written.
 */
export function modulesWithoutKillSwitch(): ModuleId[] {
  const covered = new Set(FLAG_REGISTRY.map((f) => f.module));
  return MODULE_IDS.filter((id) => !covered.has(id));
}

/**
 * Modules whose kill is enforced on **svc-edge** `/api/*` (UPSTREAMS map).
 * Killing any other module is still audited on the edge, but **does not** stop
 * that process (e.g. `ws` uses process env; `matching`/`ledger` are not edge
 * prefixes). Operators must not treat those flips as live halt.
 *
 * Keep in sync with `services/svc-edge/src/routes.ts` UPSTREAMS.module values.
 */
export const EDGE_PERIMETER_MODULES: ReadonlySet<ModuleId> = new Set([
  'identity',
  'trade',
  'token',
  'agents',
  'bank',
  'p2p',
  'pay',
  'blueprint',
  'protocol',
  'dex',
  'indexer',
  'notify',
  'academy',
  'mining-pool',
  'support',
  'market',
  'execution',
  'tax',
  'quant',
  'campaigns',
  'core-ops',
]);

export function isEdgePerimeterModule(id: ModuleId): boolean {
  return EDGE_PERIMETER_MODULES.has(id);
}

export interface StateDiff {
  readonly key: string;
  readonly from: boolean;
  readonly to: boolean;
}

/** What the staged overrides would actually change, flag by flag. */
export function diffStates(before: readonly FlagState[], after: readonly FlagState[]): StateDiff[] {
  const previous = new Map(before.map((s) => [s.def.key, s.enabled]));
  const out: StateDiff[] = [];
  for (const state of after) {
    const from = previous.get(state.def.key);
    if (from !== undefined && from !== state.enabled) out.push({ key: state.def.key, from, to: state.enabled });
  }
  return out;
}
