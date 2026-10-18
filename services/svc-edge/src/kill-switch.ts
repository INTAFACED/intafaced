import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { MODULE_IDS, isModuleId, type ModuleId } from '@intafaced/config';
import { UPSTREAMS } from './routes.js';

/**
 * THE OPERATOR KILL-SWITCH, AT THE FRONT DOOR (§14.6).
 *
 * ── What was actually there before this file ────────────────────────────────
 *
 * `packages/config/src/flags.ts` has held a complete kill-switch model since
 * the beginning: `FlagContext.disabledModules`, and `isEnabled()` giving it
 * precedence over everything else. `services/svc-protocol/src/index.ts` exports
 * `setRelayEnabled(next)`; `services/svc-indexer/src/index.ts` exports
 * `setIngestEnabled(next)`. Both are commented "the kill-switch surface
 * `apps/admin` reaches".
 *
 * **Nothing reached them.** They are module-scope functions in a service entry
 * point, exported to a process that no other process can call. `apps/admin`
 * held its staged overrides in React state and said so on its own face:
 * "Staged changes are held in this browser session and have not been sent
 * anywhere." Every service that mirrors a flag — `TRADE_SPOT_ENABLED`,
 * `WS_GATEWAY_ENABLED`, `PROTOCOL_RELAY_ENABLED`, `EMISSIONS_ENABLED` — reads
 * it from the environment ONCE, at boot. The only way an operator could switch
 * anything off was to edit compose and restart the fleet.
 *
 * A kill-switch that requires a deploy is not a kill-switch. §14.6 asks for one
 * an operator can reach, and this is the first thing in the platform that is
 * reachable.
 *
 * ── Why the edge, and not each service ──────────────────────────────────────
 *
 * Because the edge is the one component every request already passes through,
 * and because a switch that lives in fifteen processes has to be flipped
 * fifteen times — which is exactly the property you do not want in the ninety
 * seconds when you need it.
 *
 * This does NOT replace the in-service switches. `TradeService.placeOrder`
 * still refuses when `trade.spot` is off, and it should: the edge is a
 * perimeter, and a perimeter is not a substitute for the guard on the vault.
 * Defence in depth means both, and the one that can be flipped without a deploy
 * is the one an operator can actually use.
 *
 * ── The rule that makes it a safety control rather than a trap ──────────────
 *
 * A killed module refuses NEW COMMITMENTS and keeps LETTING PEOPLE OUT. That is
 * §14's own example — "`trade.spot` disabled refuses new orders while still
 * allowing cancels" — and `services/svc-trade/src/router.ts` says the same
 * thing about its own cancel path: "An operator who has halted a market must
 * still let users out; a control that traps funds is not a safety control."
 *
 * So: reads always pass, releases always pass, everything else is refused with
 * 503. Both lists are short and explicit rather than clever — an operator
 * reading this file must be able to say what a kill does without running it.
 */

/**
 * The prefix → module map, taken from the route table's own `module` field.
 *
 * Derived from data rather than from the prefix STRING, which is the bug this
 * replaced: `/api/v1` forwards to `svc-trade` but does not spell "trade", so a
 * map built by stripping `/api/` either threw at boot or — worse — left the
 * public CCXT order path with no module and therefore un-killable. See the
 * comment on `Upstream.module` in `routes.ts`.
 */
export const MODULE_BY_PREFIX: ReadonlyMap<string, ModuleId> = new Map(UPSTREAMS.map((u) => [u.prefix, u.module] as const));

/** Prefixes longest-first, so `/api/v1` can never be shadowed by a shorter one. */
const PREFIXES_LONGEST_FIRST: readonly string[] = [...MODULE_BY_PREFIX.keys()].sort((a, b) => b.length - a.length);

/**
 * Procedure leaf names that a killed module must still serve.
 *
 * `cancel` is one order. `cancelAll` and `massCancel` are the same release
 * for the rest of the caller's book: a kill that allows only the leaf `cancel`
 * traps every other open order (TRD-0236). Refunds and escrow release stay off
 * this list; those move value on the platform's authority.
 */
export const ALWAYS_ALLOWED_PROCEDURES: readonly string[] = ['cancel', 'cancelAll', 'massCancel'];

export interface RestRelease {
  readonly method: string;
  readonly pattern: RegExp;
  /** Why this path lets a user out. Read by a human during an incident. */
  readonly what: string;
}

/**
 * Release paths that are NOT tRPC, and the second bug this file had.
 *
 * The tRPC rule above was the entire escape hatch, and `svc-trade` serves its
 * cancels twice: `orders.cancel` over tRPC, and the CCXT REST contract that
 * every ccxt client actually uses —
 *
 *   POST   /api/v1/orders        place
 *   DELETE /api/v1/orders/:id    cancel one
 *   DELETE /api/v1/orders        cancel all (?symbol=)
 *
 * A REST path has no tRPC procedure, so `procedureOf` returned null and the
 * request fell through to "an unknown shape is a commitment" — refused. Halting
 * `trade` would have blocked `DELETE /api/v1/orders/:id`, which is a user with
 * an open order and no way to close it. That is the precise failure the
 * asymmetry exists to prevent, and it failed in the trapping direction: the
 * un-killable-prefix bug let too much through, this one let nothing out.
 *
 * Enumerated rather than generalised to "DELETE is always safe". DELETE happens
 * to be release-shaped across this platform today, but that is a fact about the
 * current routes and not a law, and a safety control should not rest on a
 * coincidence that the next REST endpoint can quietly break.
 */
export const ALWAYS_ALLOWED_REST: readonly RestRelease[] = [
  { method: 'DELETE', pattern: /^\/api\/v1\/orders\/[^/]+$/, what: 'cancel one order (CCXT REST)' },
  { method: 'DELETE', pattern: /^\/api\/v1\/orders$/, what: 'cancel all orders (CCXT REST)' },
  // DELETE /positions/:id is cancel-shaped and does not release margin. The close
  // routes do. A kill that traps open positions is not a safety control.
  {
    method: 'DELETE',
    pattern: /^\/api\/v1\/positions\/[^/]+$/,
    what: 'cancel-shaped futures DELETE (trade refuses it; it does not close)',
  },
  { method: 'POST', pattern: /^\/api\/v1\/positions\/[^/]+\/close$/, what: 'close one futures position' },
  { method: 'POST', pattern: /^\/api\/v1\/futures\/positions\/close-all$/, what: 'close all futures positions' },
];

export type KillReason =
  /** The module is not switched off. */
  | 'not-killed'
  /** A read commits nothing. */
  | 'read-only'
  /** A cancel or other release — a control that traps funds is not a control. */
  | 'lets-the-user-out'
  /** Refused: the operator switched this module off. */
  | 'module-killed'
  /** No route owns this path; the 404 is the proxy's job, not the switch's. */
  | 'no-route'
  /** The decision itself failed. Refused, because a safety control fails closed. */
  | 'undecidable';

export interface KillDecision {
  /** The module the request was headed for, or null for an unrouted path. */
  readonly module: ModuleId | null;
  readonly refused: boolean;
  /** Why it was allowed through a kill — for the log line, and for the test. */
  readonly reason: KillReason;
}

/**
 * The tRPC procedure a request names, or null.
 *
 * `/api/trade/trpc/orders.create` → `orders.create`. Anything that is not a
 * tRPC call has no procedure, and is treated as a commitment unless
 * `ALWAYS_ALLOWED_REST` names it.
 */
export function procedureOf(pathname: string): string | null {
  const match = /\/trpc\/([^/?]+)/.exec(pathname);
  return match?.[1] ?? null;
}

/**
 * EVERY procedure a request names — because tRPC batches, and a batch is one
 * request carrying several calls.
 *
 * `/api/trade/trpc/orders.create,orders.cancel?batch=1` names TWO. The rule
 * used to read only the last one, so the attacker chose the order:
 *
 *   orders.create,orders.cancel  →  leaf is `cancel`  →  allowed through
 *   orders.cancel,orders.create  →  leaf is `create`  →  refused
 *
 * Same two calls, opposite answers, and the permissive one executed the create
 * against a module the operator had halted. `@trpc/server` has batching ON by
 * default and neither svc-trade nor svc-identity disables it.
 *
 * Returns null when the request is not tRPC at all, which the caller treats as
 * a commitment unless `ALWAYS_ALLOWED_REST` names it.
 */
export function proceduresOf(pathname: string): readonly string[] | null {
  const raw = procedureOf(pathname);
  if (raw === null) return null;

  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A malformed escape is not a procedure anybody can name. Treated as an
    // unknown shape, which is a commitment, which is refused.
    return [raw];
  }

  return decoded
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** The leaf of a procedure path: `orders.cancel` → `cancel`. */
export function procedureLeaf(procedure: string): string {
  const parts = procedure.split('.');
  return parts[parts.length - 1] ?? procedure;
}

/**
 * The path this request will actually reach an upstream on — or null when there
 * is no single answer, which is itself a refusal.
 *
 * THE BUG THIS CLOSES: TWO PARSERS, TWO ANSWERS
 *
 * The guard used to prefix-match the RAW target (`req.url.split('?')[0]`). The
 * proxy handler then re-read the same request with `new URL(req.url, …)`, and
 * the WHATWG parser removes dot segments. So the two disagreed about which
 * module a request was for, and the disagreement was exploitable:
 *
 *   POST /api/trade/../identity/trpc/auth.login
 *
 * The guard saw `/api/trade` — not killed — and waved it through. The proxy
 * resolved `/api/identity/...` and forwarded it to the halted service. The
 * console kept reporting identity as disabled and no 503 was ever logged: the
 * exact failure the fail-closed comment in control-plane.ts describes, arrived
 * at from the other direction.
 *
 * So the path is resolved ONCE, here, with the same parser the proxy uses, and
 * both read the result.
 *
 * `new URL` collapses `.` and `..` INCLUDING their percent-encoded forms —
 * `%2e%2e` and `%2E%2E` resolve exactly like `..` (checked against this Node,
 * not assumed). So for those the resolved path is already the one the proxy
 * will use, and there is nothing to refuse.
 *
 * What it does NOT collapse is a dot segment hidden behind an ENCODED SLASH.
 * `/api/trade/..%2fidentity/x` and `/api/trade/%2f../identity/x` survive
 * verbatim, because `%2f` hides the segment boundary from the parser. Whether
 * that becomes a path separator is then the upstream's decision and not ours —
 * the same disagreement as before, moved one layer down. So the path is decoded
 * once more and re-inspected: a dot segment that appears only after decoding
 * means the edge and the upstream cannot be made to agree, and a request nobody
 * can route to one place does not get to pick.
 *
 * Deliberately NOT refused: a segment that merely decodes to contain a slash,
 * such as `/api/v1/orders/BTC%2FUSDT`. That is an ordinary CCXT symbol, and the
 * cancel paths in `ALWAYS_ALLOWED_REST` are the release routes that let users
 * out during an incident — breaking those would be worse than the bug this
 * closes. Only a decoded DOT SEGMENT is refused.
 */
export function resolvedPathname(rawUrl: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(rawUrl, 'http://edge.invalid').pathname;
  } catch {
    return null;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape is not a path anybody can agree on either.
    return null;
  }
  if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) return null;

  return pathname;
}

/**
 * One entry in the operator audit trail (§14.6).
 *
 * `previous` is the half that is easy to omit and the half an incident review
 * actually needs: "trade was killed at 04:12" does not say whether the operator
 * changed anything or re-sent a request that had already landed, and those are
 * different timelines.
 */
export interface KillSwitchAuditEntry {
  readonly at: string;
  readonly module: ModuleId;
  /** The operator's principal id. Never anonymous — `admin-api.ts` proves it. */
  readonly actor: string;
  /**
   * Distinct confirming operator on the mutate door. Null only when a test
   * fixture arms `set()` without going through `/admin/kill-switches`.
   */
  readonly confirmOperatorId: string | null;
  readonly reason: string;
  readonly previous: boolean;
  readonly next: boolean;
  /** False when the request asked for the state it was already in. */
  readonly changed: boolean;
}

/**
 * In-process kill-switch state.
 *
 * IN PROCESS, AND SAID OUT LOUD: this state does not survive a restart, and a
 * second edge replica does not see it. That is a real limitation and it is the
 * honest shape of what can be built without giving the edge a datastore — which
 * `env.ts` refuses it on purpose, because the internet-facing component should
 * hold the least in the fleet.
 *
 * Memory-only mode, with no state path configured, comes back with every
 * module ON. That is the deployment default when nothing was asked to
 * survive a restart. File mode is the other case: a missing, empty, or
 * unreadable state file halts every module, and a torn write must not
 * drop an incident halt.
 *
 * The durable half of the platform's operator surface is the ledger's, not this
 * one: `posting_freeze` is a row, carries its own actor, and is enforced by
 * `posting_freeze_attributed_ck`. `admin-api.ts` reaches it. So the switch that
 * moves money has a durable timeline; this one has an attributed in-memory
 * timeline with the same shape, waiting on the same store.
 *
 * SOCKET §13: multi-replica shared store still residual. Optional
 * `EDGE_KILL_STATE_PATH` file gives **single-process restart durability** so an
 * incident kill is not wiped by a bounce. Multi-edge still needs a shared store.
 *
 * File mode does not treat a missing, empty, or unreadable state file as every
 * module ON. Hydrate halts every module. The write replaces the file only after
 * a temp file is fsynced; if that write throws, `set` leaves memory where it
 * was and does not return the audit entry. An explicit `{ "killed": [] }` is
 * the recorded all-on state.
 */
export interface SharedKillSnapshot {
  readonly killed: readonly { module: ModuleId; reason: string | null }[];
}

/**
 * Re-read on every decision. Two replicas that hold this store share one kill.
 * `read` returns null when the store cannot be read; that is a fail-closed
 * refuse of new holds, not "every module is on".
 */
export interface SharedKillStore {
  read(): SharedKillSnapshot | null;
  write(next: SharedKillSnapshot): void;
}

export class MemorySharedKillStore implements SharedKillStore {
  private snapshot: SharedKillSnapshot = { killed: [] };
  private readsFail = false;

  failReads(fail: boolean): void {
    this.readsFail = fail;
  }

  read(): SharedKillSnapshot | null {
    if (this.readsFail) return null;
    return { killed: this.snapshot.killed.map((row) => ({ module: row.module, reason: row.reason })) };
  }

  write(next: SharedKillSnapshot): void {
    this.snapshot = { killed: next.killed.map((row) => ({ module: row.module, reason: row.reason })) };
  }
}

export interface KillSwitchStateOptions {
  /** Path to JSON map of killed modules. Empty/undefined = memory only. */
  readonly statePath?: string;
  /** When set, every decision re-reads this store. File and memory stay process-local. */
  readonly shared?: SharedKillStore;
}

/**
 * Operator-visible durability of kill state.
 *
 * `multiReplicaShared` is true only when a shared store is attached. A file is
 * per process host, and memory is per process. The field must not call either
 * of those fleet-wide.
 */
export interface KillSwitchDurability {
  /** `shared` when a SharedKillStore is attached; `file` when EDGE_KILL_STATE_PATH is set; otherwise memory. */
  readonly persistence: 'file' | 'memory' | 'shared';
  /** True only for an attached shared store. */
  readonly multiReplicaShared: boolean;
  /** One sentence an operator can act on at 3am. */
  readonly note: string;
}

export class KillSwitchState {
  private readonly killed = new Set<ModuleId>();
  private readonly reasons = new Map<ModuleId, string>();
  private readonly audit: KillSwitchAuditEntry[] = [];
  private readonly statePath: string | undefined;
  private readonly shared: SharedKillStore | undefined;

  /**
   * How many audit entries are retained in memory.
   *
   * Bounded because this is a long-lived process on the public edge and an
   * unbounded array fed by an authenticated endpoint is a slow memory leak. The
   * cap is generous relative to how often a human flips a market off, and the
   * WARN log line emitted per toggle is the unbounded record.
   */
  static readonly AUDIT_LIMIT = 500;

  constructor(options: KillSwitchStateOptions = {}) {
    this.statePath = options.statePath?.trim() || undefined;
    this.shared = options.shared;
    this.hydrateFromDisk();
  }

  /**
   * What an operator can believe about whether a halt outlives this process.
   *
   * Exposed on `/admin/status` so the console never implies multi-replica
   * durability that the edge deliberately does not have (SOCKET §13 residual —
   * shared store invent without product law is fenced). File mode is
   * single-process restart durability only: another replica with its own file
   * (or none) still has its own switches.
   */
  durability(): KillSwitchDurability {
    if (this.shared) {
      return {
        persistence: 'shared',
        multiReplicaShared: true,
        note: 'Shared kill store is re-read on every decision. A replica that cannot read it refuses new holds and still allows a single-order cancel.',
      };
    }
    if (this.statePath) {
      return {
        persistence: 'file',
        multiReplicaShared: false,
        note: 'Single-process restart durability via EDGE_KILL_STATE_PATH. Other edge replicas do not share this file (SOCKET §13 multi-replica residual).',
      };
    }
    return {
      persistence: 'memory',
      multiReplicaShared: false,
      note: 'Memory only — process restart clears all kills. Attach a shared kill store for a fleet-wide halt.',
    };
  }

  /** A state file we cannot trust is a halt, not a quiet all-on boot. */
  private haltEveryModule(): void {
    const because = 'kill state file missing, empty, or unreadable — every module halted fail-closed';
    for (const id of MODULE_IDS) {
      this.killed.add(id);
      this.reasons.set(id, because);
    }
  }

  private hydrateFromDisk(): void {
    if (!this.statePath) return;
    let raw: string;
    try {
      raw = readFileSync(this.statePath, 'utf8');
    } catch {
      this.haltEveryModule();
      return;
    }
    if (raw.trim() === '') {
      this.haltEveryModule();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.haltEveryModule();
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.haltEveryModule();
      return;
    }
    const killed = (parsed as { killed?: unknown }).killed;
    if (!Array.isArray(killed)) {
      this.haltEveryModule();
      return;
    }
    for (const row of killed) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        this.haltEveryModule();
        return;
      }
      const id = (row as { module?: unknown }).module;
      const reason = (row as { reason?: unknown }).reason;
      if (typeof id !== 'string' || !isModuleId(id) || (reason !== undefined && reason !== null && typeof reason !== 'string')) {
        this.haltEveryModule();
        return;
      }
      this.killed.add(id);
      if (typeof reason === 'string' && reason.trim()) this.reasons.set(id, reason.trim());
    }
  }

  /**
   * Write the next killed-set. `pending` is the switch `set` has not applied
   * yet, so a throw leaves memory on the previous halt.
   */
  private persistToDisk(pending?: { module: ModuleId; disabled: boolean; reason: string | null }): void {
    if (!this.statePath) return;
    const killed = MODULE_IDS.filter((id) => (pending && id === pending.module ? pending.disabled : this.killed.has(id))).map((module) => ({
      module,
      reason: pending && module === pending.module ? pending.reason : (this.reasons.get(module) ?? null),
    }));
    this.replaceStateFile(`${JSON.stringify({ killed, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  }

  /**
   * Replace the state file only after the new bytes are fsynced. A crash during
   * the temp write leaves the previous file, and the previous incident halt, in place.
   * Errors propagate — the caller must not report a change the disk refused.
   */
  private replaceStateFile(body: string): void {
    const path = this.statePath;
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      const data = Buffer.from(body, 'utf8');
      let offset = 0;
      while (offset < data.length) {
        const written = writeSync(fd, data, offset, data.length - offset);
        if (written === 0) throw new Error('Kill-state write made no progress');
        offset += written;
      }
      fsyncSync(fd);
    } catch (err) {
      try {
        closeSync(fd);
      } catch {
        // The write already failed. Closing the descriptor must not hide that.
      }
      try {
        unlinkSync(tmp);
      } catch {
        // Temp cleanup must not hide the write error.
      }
      throw err;
    }
    try {
      closeSync(fd);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // Temp cleanup must not hide the close error.
      }
      throw err;
    }
    try {
      renameSync(tmp, path);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // Temp cleanup must not hide the rename error.
      }
      throw err;
    }
  }

  private killView(module: ModuleId): 'live' | 'killed' | 'unreadable' {
    if (!this.shared) return this.killed.has(module) ? 'killed' : 'live';
    const snap = this.shared.read();
    if (snap === null) return 'unreadable';
    return snap.killed.some((row) => row.module === module) ? 'killed' : 'live';
  }

  /** Modules currently switched off, in `MODULE_IDS` order so the output is stable. */
  disabledModules(): ModuleId[] {
    if (!this.shared) return MODULE_IDS.filter((id) => this.killed.has(id));
    const snap = this.shared.read();
    if (snap === null) return [...MODULE_IDS];
    const ids = new Set(snap.killed.map((row) => row.module));
    return MODULE_IDS.filter((id) => ids.has(id));
  }

  reasonFor(module: ModuleId): string | null {
    if (this.shared) {
      const snap = this.shared.read();
      if (snap === null) return null;
      return snap.killed.find((row) => row.module === module)?.reason ?? null;
    }
    return this.reasons.get(module) ?? null;
  }

  isKilled(module: ModuleId): boolean {
    const view = this.killView(module);
    return view === 'killed' || view === 'unreadable';
  }

  /** Newest first — an operator opening the console wants the last thing that happened. */
  auditTrail(): readonly KillSwitchAuditEntry[] {
    return [...this.audit].reverse();
  }

  /**
   * Move a switch, and record who moved it.
   *
   * The durable file is replaced before the in-memory booleans move. If that
   * write throws, the audit entry is not appended and the switches stay put:
   * `set` does not report a change the disk refused.
   *
   * The audit entry is appended BEFORE the state changes, so there is no
   * ordering in which the platform is halted and the record of the halt is
   * missing.
   */
  set(module: ModuleId, disabled: boolean, actor: string, reason: string, confirmOperatorId: string | null = null): KillSwitchAuditEntry {
    const view = this.killView(module);
    if (view === 'unreadable') throw new Error('shared kill store unreadable');
    const previous = view === 'killed';

    const entry: KillSwitchAuditEntry = {
      at: new Date().toISOString(),
      module,
      actor,
      confirmOperatorId,
      reason,
      previous,
      next: disabled,
      changed: previous !== disabled,
    };

    const recorded = confirmOperatorId ? `${reason} (by ${actor}; confirmed ${confirmOperatorId})` : `${reason} (by ${actor})`;

    if (this.shared && entry.changed) {
      const snap = this.shared.read();
      if (snap === null) throw new Error('shared kill store unreadable');
      const killed = snap.killed.filter((row) => row.module !== module);
      if (disabled) killed.push({ module, reason: recorded });
      this.shared.write({ killed });
    }

    if (entry.changed) {
      this.persistToDisk({ module, disabled, reason: disabled ? recorded : null });
    }

    this.audit.push(entry);
    if (this.audit.length > KillSwitchState.AUDIT_LIMIT) this.audit.shift();

    if (disabled) {
      this.killed.add(module);
      this.reasons.set(module, recorded);
    } else {
      this.killed.delete(module);
      this.reasons.delete(module);
    }

    return entry;
  }

  /**
   * Should this request be refused?
   *
   * Pure, and separated from the HTTP layer, because this is the rule worth
   * testing and a test that has to stand up a Fastify server to ask "does a
   * cancel still get through" is a test nobody writes.
   */
  private evaluate(pathname: string, method: string): KillDecision {
    const prefix = PREFIXES_LONGEST_FIRST.find((p) => pathname === p || pathname.startsWith(`${p}/`));
    if (!prefix) return { module: null, refused: false, reason: 'no-route' };

    const module = MODULE_BY_PREFIX.get(prefix) as ModuleId;
    const view = this.killView(module);
    if (view === 'live') return { module, refused: false, reason: 'not-killed' };

    // A read commits nothing. tRPC queries are GET; a user watching their open
    // orders during an incident is not the problem the switch is there to solve.
    const verb = method.toUpperCase();
    if (verb === 'GET' || verb === 'HEAD') return { module, refused: false, reason: 'read-only' };

    if (this.isRelease(pathname, verb)) return { module, refused: false, reason: 'lets-the-user-out' };

    // Cannot read the shared kill. Refuse the new hold. Do not call it a deliberate halt.
    if (view === 'unreadable') return { module, refused: true, reason: 'undecidable' };

    return { module, refused: true, reason: 'module-killed' };
  }

  /**
   * EVERY procedure in the batch must be allowed, not just one of them. A
   * batch is a single request carrying several calls, and reading only the
   * last let `orders.create,orders.cancel` through a halted module.
   *
   * Path only, never the query string: `?symbol=BTC/USDT` on a cancel-all
   * must not change whether the user is allowed out.
   */
  private isRelease(pathname: string, verb: string): boolean {
    const procedures = proceduresOf(pathname);
    if (procedures !== null && procedures.length > 0 && procedures.every((p) => ALWAYS_ALLOWED_PROCEDURES.includes(procedureLeaf(p)))) {
      return true;
    }
    const path = pathname.split('?')[0] ?? pathname;
    return ALWAYS_ALLOWED_REST.some((r) => r.method === verb && r.pattern.test(path));
  }

  /**
   * FAIL CLOSED.
   *
   * If deciding whether the switch is engaged throws, behave as though it is.
   * A safety control that opens when its own check errors is worse than no
   * control at all: the operator believes the market is halted, the console
   * says it is halted, and orders are being accepted. Refusing on an internal
   * error is visible, wrong in the recoverable direction, and reported as
   * `undecidable` so it can never be mistaken in the logs for a deliberate
   * operator halt.
   */
  decide(pathname: string, method: string): KillDecision {
    try {
      return this.evaluate(pathname, method);
    } catch {
      return { module: null, refused: true, reason: 'undecidable' };
    }
  }
}
