import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { AuthError, bearerToken, hasScope, requireScope, verifyAccessToken, type Principal, type TokenConfig } from '@intafaced/auth';
import { LedgerError } from '@intafaced/ledger-client';
import {
  LEDGER_RECONCILE_ASOF_INVALID,
  LEDGER_RECONCILE_CONTROL_NOT_FOUND,
  LEDGER_RECONCILE_SOURCE_UNAVAILABLE,
  OPS_CONTROL_ACTOR_UNSET,
  OPS_CONTROL_REASON_REQUIRED,
  defineReconciliationControlInputSchema,
  runReconciliationControlInputSchema,
  updateReconciliationControlInputSchema,
} from '@intafaced/contracts/ledger-reconciliation';
import { ASSET_EDIT_STALE, ASSET_OPERATION_CONFLICT, REGISTRY_REFUSALS } from './ledger/supported-assets.js';
import { DualControlError } from './ledger/dual-control.js';
import { ActionApprovalConsumeError, consumeLedgerApproval, type ActionApprovalConsumer } from './ledger/action-approval-consume.js';
import { LOOKUP_UNRECORDED, LookupUnrecordedError, requireLookupAuthority, type LookupActor } from './ledger/operator-lookup.js';
import { TraceInconsistentError, operatorTraceInputSchema, operatorTraceOutputSchema, traceBusinessKey } from './ledger/operator-trace.js';
import {
  BookingRecordMissingError,
  LEDGER_TX_NOT_FOUND,
  operatorTxGet,
  operatorTxGetInputSchema,
  operatorTxGetOutputSchema,
} from './ledger/operator-tx-get.js';
import {
  operatorAccountSearchInputSchema,
  operatorAccountSearchOutputSchema,
  operatorStatsOutputSchema,
  operatorTxListInputSchema,
  operatorTxListOutputSchema,
} from './ledger/operator-desk.js';
import { SKEW_BOUND_UNSET, WRITES_BLOCKED_CLOCK_SKEW } from './ledger/clock-skew.js';
import { ReconciliationControlError } from './ledger/reconciliation-control-error.js';
import {
  defineReconciliationControl,
  listReconciliationControls,
  runReconciliationControl,
  updateReconciliationControl,
} from './ledger/reconciliation-controls.js';
import {
  ACCOUNT_METADATA_APPROVAL_SPENT,
  ACCOUNT_METADATA_INVALID,
  ACCOUNT_METADATA_KEY_ABSENT,
  ACCOUNT_METADATA_STALE,
  ACCOUNT_NOT_FOUND,
  LEDGER_FROZEN,
  accountMetadataChangeOutputSchema,
  accountMetadataOutputSchema,
  accountMetadataReadInputSchema,
} from './ledger/operator-account-metadata.js';
import type { LedgerService } from './service.js';

/**
 * THE LEDGER'S OPERATOR SURFACE — and the switch that was wired to nothing.
 *
 * ── The finding this file exists to close ───────────────────────────────────
 *
 * `ledger.posting` is described in `packages/config/src/flags.ts` as "the most
 * consequential switch in the platform", and every piece of it was already
 * built and correct:
 *
 *   · `posting_freeze` is a durable singleton row, not a process field, so
 *     every replica reads the same answer (migration 0002_durable_freeze).
 *   · It carries `reason`, `actor` and `changed_at`, and the DATABASE refuses a
 *     freeze with neither reason nor actor (`posting_freeze_attributed_ck`).
 *   · `LedgerService.freeze/unfreeze` emit `ledger.freeze.updated`.
 *   · `createLedgerRouter` exposes `freeze`, `unfreeze` and `reconcile` behind
 *     `scopedProcedure('admin:treasury')` — an interactive-only scope, so MFA
 *     is enforced by `requireScope` itself.
 *
 * **And none of it was reachable.** `index.ts` builds `appRouter` and exports it
 * for its TYPE; nothing registers a tRPC plugin, so those three procedures were
 * served on no port. `s2s-http.ts` already says this out loud about `post` —
 * "A guard written on one door does not secure the other one" — and the same
 * sentence was true of the freeze, in the other direction: not an unguarded
 * door, but no door at all. `svc-ledger` is also deliberately absent from
 * `svc-edge`'s route table, so there was no path from `apps/admin` either.
 *
 * The only way to freeze the ledger was `LEDGER_POSTING_ENABLED=false` and a
 * restart — and per `service.ts`, that flag "can freeze, and can never thaw".
 * So the platform's emergency stop was reachable only by redeploying, and
 * releasing it required a second redeploy. `apps/admin` has shipped a red
 * "Halt posting" button, with a typed confirmation, that set React state.
 *
 * ── Why raw routes and not a tRPC mount ─────────────────────────────────────
 *
 * Mounting `appRouter` would serve the whole router, including `post`, on a
 * port. `post` is `serviceProcedure` so it would still refuse a user token —
 * but the reason svc-ledger has no HTTP router today is a deliberate one, and
 * widening the money plane's surface to reach operator switches inverts the
 * cost. These handlers mirror `registerS2sHttp`'s shape: explicit, enumerable,
 * one line each, and nothing reachable that is not named here.
 *
 * Routes: GET/POST `/operator/freeze`, POST `/operator/unfreeze`,
 * POST `/operator/reconcile`, GET/POST `/operator/reconciliation/controls`,
 * POST `/operator/reconciliation/controls/update`, POST `/operator/reconciliation/controls/run`,
 * and the two object lookups GET `/operator/transactions/:txId` and GET
 * `/operator/trace?businessKey=`. Reconcile was the residual of the original
 * freeze-only ship — freeze was wired first because halt is more urgent than
 * audit, and apps/admin kept an honest-simulated reconcile button until this
 * path existed for edge to proxy. The control routes are the same kind of
 * explicit door: `appRouter` stays unmounted because it includes `post`.
 *
 * ── Authentication ─────────────────────────────────────────────────────────
 *
 * `admin:treasury`, which is in `INTERACTIVE_ONLY_SCOPES`, so `requireScope`
 * rejects a token without `mfa` on its own. The two object lookups are the one
 * exception: they also take a founder's `admin:read` with a second factor
 * (`requireLookupAuthority`, owner decision 2026-10-23). No session carries it
 * (`SESSION_SCOPES` excludes every `admin:*` scope and `auth.test.ts` asserts
 * that), and `assertDelegatableScopes` refuses to mint an API key with it.
 *
 * Not the internal service secret, which is what `post` uses. A shared secret
 * has no subject, and `posting_freeze.actor` is a column whose whole purpose is
 * to name who halted the platform. "Somebody with the key" is not an audit
 * trail.
 */

const freezeSchema = z.object({
  /**
   * Required, and required to be useful. The database's own check constraint
   * refuses an unattributed freeze; this refuses an unexplained one, because
   * `reason` is what the next operator reads before deciding whether to thaw.
   * Trim first so twelve spaces cannot satisfy `min(12)` with no readable text.
   */
  reason: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(12).max(500)),
  /** Display-only. Never authority. */
  confirmOperatorId: z.string().max(128).nullish(),
  approvalId: z.string().min(1).max(128),
  operationId: z.string().min(1).max(128),
});

const thawSchema = z.object({
  confirmOperatorId: z.string().max(128).nullish(),
  approvalId: z.string().min(1).max(128),
  operationId: z.string().min(1).max(128),
});

const reconcileSchema = z.object({
  confirmOperatorId: z.string().max(128).nullish(),
  approvalId: z.string().min(1).max(128),
  operationId: z.string().min(1).max(128),
});

export interface FreezeSnapshot {
  readonly frozen: boolean;
  readonly reason: string | null;
  readonly actor: string | null;
  readonly changedAt: string;
  /**
   * The row's `changedAtPrecise`. Freeze and unfreeze approvals are bound to
   * this version. Absent only when the store did not return one — never guessed.
   */
  readonly version?: string;
}

/**
 * On-demand reconciliation report for the operator console.
 *
 * Matches the three independent checks in `ledger/reconcile.ts`. Never carries
 * a `simulated` flag — if this route answers, the book was asked. A broken
 * chain reports `chainLength` as the number of transactions that verified
 * before the break (and `chainBrokenAt` when known), not zero: zero looks like
 * an empty healthy book.
 */
export interface ReconcileSnapshot {
  readonly ok: boolean;
  readonly accountsChecked: number;
  readonly chainLength: number;
  readonly unbalancedAssets: readonly string[];
  readonly ranAt: string;
  readonly confirmOperatorId: string;
  readonly chainBrokenAt?: string;
}

/** Map an `AuthError` to a status an operator console can branch on. */
export function statusForAuthError(err: AuthError): number {
  switch (err.code) {
    case 'scope.denied':
      return 403;
    // 401 for everything else: expired, malformed, absent, or missing a second
    // factor are all "come back with a better credential", not "never".
    default:
      return 401;
  }
}

/** The parts of a Fastify request the operator routes read. */
interface OperatorRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: unknown;
  readonly params?: unknown;
  readonly query?: unknown;
  readonly id?: string;
}

export { LOOKUP_UNRECORDED };
/** A transaction id that is not a UUID, or a blank or over-long business key. Nothing was recorded or read. */
export const LOOKUP_INPUT_INVALID = 'ledger.lookup_input_invalid' as const;
/** A recorded lookup the ledger could not answer (the database did not respond, or the answer failed its schema). */
export const LOOKUP_UNAVAILABLE = 'ledger.lookup_unavailable' as const;

/** HTTP status of each account-metadata refusal. Nothing changed in any of them. */
const METADATA_STATUS: Readonly<Record<string, number>> = {
  [ACCOUNT_METADATA_INVALID]: 400,
  [ACCOUNT_NOT_FOUND]: 404,
  [ACCOUNT_METADATA_KEY_ABSENT]: 404,
  [ACCOUNT_METADATA_STALE]: 409,
  [ACCOUNT_METADATA_APPROVAL_SPENT]: 409,
  [LEDGER_FROZEN]: 412,
};

export function registerOperatorHttp(
  app: FastifyInstance,
  ledger: LedgerService,
  tokens: TokenConfig,
  approvals: ActionApprovalConsumer,
): void {
  // Also enforces MFA, because `admin:treasury` is interactive-only.
  const treasury = (principal: Principal) => requireScope(principal, 'admin:treasury');

  const authenticate = async (header: string | undefined, authorize: (principal: Principal) => void): Promise<Principal> => {
    const token = bearerToken(header ?? null);
    if (!token) throw new AuthError('An operator access token is required', 'token.invalid');

    const principal = await verifyAccessToken(token, tokens);
    authorize(principal);
    return principal;
  };

  const guarded =
    (
      handle: (operator: Principal, body: unknown, req: OperatorRequest, reply: FastifyReply) => Promise<unknown>,
      authorize: (principal: Principal) => void = treasury,
    ) =>
    async (req: OperatorRequest, reply: FastifyReply) => {
      let operator: Principal;
      try {
        const header = req.headers.authorization;
        operator = await authenticate(typeof header === 'string' ? header : undefined, authorize);
      } catch (err) {
        if (err instanceof AuthError) return reply.code(statusForAuthError(err)).send({ message: err.message, code: err.code });
        throw err;
      }

      try {
        return await handle(operator, req.body, req, reply);
      } catch (err) {
        // Different attribution while already frozen: first reason stands
        // (STOP §4.2b #3). Must not look like a successful freeze — soft-200
        // used to return the standing row and operators believed their reason
        // had landed. 409 + the durable code so a console can branch.
        if (err instanceof DualControlError || err instanceof ActionApprovalConsumeError) {
          return reply.code(400).send({ message: err.message, code: err.code });
        }
        if (err instanceof LedgerError && err.code === 'ledger.freeze_attributed') {
          return reply.code(409).send({ message: err.message, code: err.code });
        }
        // Another reconciliation holds the single-flight lock: nothing ran, nothing changed.
        if (err instanceof LedgerError && err.code === 'ledger.reconcile_in_progress') {
          return reply.code(409).send({ message: err.message, code: err.code });
        }
        // The proof could not reach a verdict (timeout, lost connection). The book is NOT frozen by
        // this and NOT verified: not a 400 the operator would read as a bad request, not an `ok: false`.
        if (err instanceof LedgerError && err.code === 'ledger.reconcile_incomplete') {
          return reply.code(503).send({ message: err.message, code: err.code });
        }
        if (err instanceof ReconciliationControlError) {
          return reply.code(controlHttpStatus(err.code)).send({ message: err.code, code: err.code });
        }
        // The asset registry (W-balances-05): another edit landed first, or the operation id was used for
        // another edit. Nothing changed; 409 so the console asks for a fresh approval rather than retrying.
        if (err instanceof LedgerError && (err.code === ASSET_EDIT_STALE || err.code === ASSET_OPERATION_CONFLICT)) {
          return reply.code(409).send({ message: err.message, code: err.code });
        }
        if (err instanceof LedgerError && REGISTRY_REFUSALS.has(err.code)) {
          return reply.code(400).send({ message: err.message, code: err.code });
        }
        const message = err instanceof Error ? err.message : 'operator request failed';
        // 400 rather than 500: everything reachable here is either a validation
        // failure or a constraint the database refused, and both are the
        // caller's to fix. A thrown freeze must never look like a succeeded one.
        return reply.code(400).send({ message, code: 'ledger.operator_request_failed' });
      }
    };

  const shape = (state: {
    frozen: boolean;
    reason: string | null;
    actor: string | null;
    changedAt: Date;
    changedAtPrecise?: string;
  }): FreezeSnapshot => ({
    frozen: state.frozen,
    reason: state.reason,
    actor: state.actor,
    changedAt: state.changedAt.toISOString(),
    ...(typeof state.changedAtPrecise === 'string' && state.changedAtPrecise.length > 0 ? { version: state.changedAtPrecise } : {}),
  });

  /**
   * Read. Behind the same scope as the write, deliberately: whether the
   * platform's money plane is halted, and who halted it, is operator
   * information. `/health` already reports `postingEnabled` for anything that
   * only needs the boolean.
   */
  app.get(
    '/operator/freeze',
    guarded(async () => shape(await ledger.freezeState())),
  );

  /**
   * Clock integrity (OPS-ledger-desk-04). A blank owner bound is 412
   * `ledger.skew_bound_unset`. A bound the clocks exceed is 503
   * `ledger.writes_blocked_clock_skew`. Neither answer invents a window.
   */
  app.get(
    '/operator/integrity/clock',
    guarded(async (_operator, _body, _req, reply) => {
      const view = await ledger.clockSkew();
      if (!view.ok && view.code === SKEW_BOUND_UNSET) return reply.code(412).send(view);
      if (!view.ok && view.code === WRITES_BLOCKED_CLOCK_SKEW) return reply.code(503).send(view);
      return view;
    }),
  );

  app.post(
    '/operator/freeze',
    guarded(async (operator, body) => {
      const parsed = freezeSchema.parse(body);
      const prior = await ledger.freezeState();
      const consumed = await consumeLedgerApproval(approvals, parsed, 'ledger.freeze', 'posting_freeze', prior.changedAtPrecise, {
        reason: parsed.reason,
      });
      const confirmOperatorId = consumed.approverId ?? consumed.requesterId;
      app.log.warn(
        { actor: operator.userId, confirmOperatorId, reason: parsed.reason },
        'LEDGER FREEZE requested by operator — all value movement will stop',
      );
      return { ...shape(await ledger.freeze(parsed.reason, operator.userId)), confirmOperatorId };
    }),
  );

  /**
   * A thaw names two people. The confirming id comes from the consumed
   * approval, not from a typed-in string. One actor string leaves the freeze
   * where it is. There is no reason field: a successful thaw clears it.
   */
  app.post(
    '/operator/unfreeze',
    guarded(async (operator, body) => {
      const parsed = thawSchema.parse(body ?? {});
      const prior = await ledger.freezeState();
      const consumed = await consumeLedgerApproval(approvals, parsed, 'ledger.unfreeze', 'posting_unfreeze', prior.changedAtPrecise, {});
      const confirmOperatorId = consumed.approverId ?? consumed.requesterId;
      app.log.warn({ actor: operator.userId, confirmOperatorId }, 'LEDGER THAW requested by operator — value movement resumes');
      return { ...shape(await ledger.unfreeze(operator.userId, confirmOperatorId)), confirmOperatorId };
    }),
  );

  /**
   * On-demand full reconciliation — balances vs replay, hash chain, totalsByAsset.
   *
   * Behind the same `admin:treasury` + MFA + distinct confirm door as freeze.
   * On failure the service freezes itself before answering (§4.2); this handler
   * only shapes the report. It is deliberately a POST (a mutation of operator
   * attention and potentially of freeze state), not a GET that a load balancer
   * could cache.
   *
   * apps/admin and svc-edge still have to proxy this — their residual is not
   * this service's. Until they do, the scheduled job and this route are the
   * live paths; the console's simulated button is an honesty marker, not a
   * substitute for the book.
   */
  app.post(
    '/operator/reconcile',
    guarded(async (operator, body) => {
      const parsed = reconcileSchema.parse(body ?? {});
      const prior = await ledger.freezeState();
      const consumed = await consumeLedgerApproval(approvals, parsed, 'ledger.reconcile', 'posting_reconcile', prior.changedAtPrecise, {});
      const confirmOperatorId = consumed.approverId ?? consumed.requesterId;
      app.log.info({ actor: operator.userId, confirmOperatorId }, 'LEDGER RECONCILE requested by operator');
      const report = await ledger.reconcile();
      const snapshot: ReconcileSnapshot = {
        ok: report.ok,
        accountsChecked: report.balances.accountsChecked,
        // Prefer length-so-far on a break over inventing green zero.
        chainLength: report.chain.length,
        unbalancedAssets: report.unbalancedAssets,
        ranAt: report.ranAt.toISOString(),
        confirmOperatorId,
        ...(!report.chain.ok && 'brokenAt' in report.chain ? { chainBrokenAt: report.chain.brokenAt } : {}),
      };
      if (!report.ok) {
        app.log.fatal(
          { actor: operator.userId, confirmOperatorId, report: snapshot },
          'LEDGER RECONCILIATION FAILED via operator request — posting frozen',
        );
      }
      return snapshot;
    }),
  );

  /**
   * Object lookup (OPS-rules-monitoring-12 on OPS-ledger-desk-01's reads): one booked transaction by its id, or the
   * transaction a business key booked. Reads, never posts, and they answer while the posting freeze is on.
   *
   * Who may look: `requireLookupAuthority` (a founder's `admin:read` with a second factor, or `admin:treasury`).
   *
   * Each lookup writes one `operator_access_log` row FIRST, inside the read function (`operator-lookup.ts`); a row that
   * cannot be written refuses with 503 and reads nothing. An unknown transaction id is 404 `ledger.tx_not_found`; a key
   * that never booked is an honest `found: false`. A read that fails after it was recorded is 503 with a fixed message,
   * never a 400 that would blame the operator, and never the driver's text. Answers are checked against the same output
   * schemas the tRPC procedures declare. Postings name opaque account ids only.
   */
  const lookup = <I, T>(spec: {
    input: (req: OperatorRequest) => unknown;
    inputSchema: z.ZodType<I>;
    invalid: string;
    read: (actor: LookupActor, input: I) => Promise<T>;
    output: z.ZodType<T>;
  }) =>
    guarded(async (operator, _body, req, reply) => {
      const input = spec.inputSchema.safeParse(spec.input(req));
      if (!input.success) return reply.code(400).send({ message: spec.invalid, code: LOOKUP_INPUT_INVALID });
      try {
        return spec.output.parse(await spec.read({ actorId: operator.userId, requestId: req.id ?? null }, input.data));
      } catch (err) {
        if (err instanceof LookupUnrecordedError) {
          app.log.error({ err, actor: operator.userId }, 'operator lookup refused: access row not written');
          return reply.code(503).send({ message: 'The lookup could not be recorded, so it was not read.', code: LOOKUP_UNRECORDED });
        }
        if (err instanceof LedgerError && err.code === LEDGER_TX_NOT_FOUND) {
          return reply.code(404).send({ message: 'No transaction has that id.', code: LEDGER_TX_NOT_FOUND });
        }
        if (err instanceof LedgerError && err.code === ACCOUNT_NOT_FOUND) {
          return reply.code(404).send({ message: 'No ledger account has that id.', code: ACCOUNT_NOT_FOUND });
        }
        if (err instanceof TraceInconsistentError || err instanceof BookingRecordMissingError) {
          // The book's own integrity, not the operator's request: a server fault, as the tRPC procedure reports it.
          app.log.error({ err, actor: operator.userId }, 'operator lookup: the book answered a transaction it cannot account for');
          const message =
            err instanceof TraceInconsistentError
              ? 'The book answered a transaction booked under another key.'
              : 'The book answered a transaction with no row in its log.';
          return reply.code(500).send({ message, code: err.code });
        }
        app.log.error({ err, actor: operator.userId }, 'operator lookup failed after it was recorded');
        return reply.code(503).send({ message: 'The ledger could not answer this lookup. Try again.', code: LOOKUP_UNAVAILABLE });
      }
    }, requireLookupAuthority);

  app.get(
    '/operator/transactions/:txId',
    lookup({
      input: (req) => ({ txId: (req.params as { txId?: unknown } | undefined)?.txId }),
      inputSchema: operatorTxGetInputSchema,
      invalid: 'A transaction id is a UUID.',
      read: (actor, input) => operatorTxGet(ledger, actor, input),
      output: operatorTxGetOutputSchema,
    }),
  );

  app.get(
    '/operator/trace',
    lookup({
      input: (req) => ({ businessKey: (req.query as { businessKey?: unknown } | undefined)?.businessKey }),
      inputSchema: operatorTraceInputSchema,
      invalid: 'A business key is 1 to 512 characters.',
      read: (actor, input) => traceBusinessKey(ledger, actor, input),
      output: operatorTraceOutputSchema,
    }),
  );

  /**
   * The ledger desk's browsing reads (OPS-ledger-desk-01): the transaction list by asset and time with a cursor and the
   * ledger's own total, the account address search with volumes, and the book's counts. Same authority as the lookups;
   * the list and the search write their access row first, inside `LedgerService` (`operator-desk.ts`); the counts name
   * no one.
   */
  const queryOf = (req: OperatorRequest, keys: readonly string[]): Record<string, unknown> => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    return Object.fromEntries(keys.filter((k) => query[k] !== undefined && query[k] !== '').map((k) => [k, query[k]]));
  };

  app.get(
    '/operator/transactions',
    lookup({
      input: (req) => queryOf(req, ['assetId', 'from', 'to', 'before']),
      inputSchema: operatorTxListInputSchema,
      invalid: 'An asset is 1 to 32 characters, times are ISO 8601 with from before to, and the cursor is the one a page answered.',
      read: (actor, input) => ledger.deskTransactions(actor, input),
      output: operatorTxListOutputSchema,
    }),
  );

  app.get(
    '/operator/accounts',
    lookup({
      input: (req) => queryOf(req, ['prefix', 'after']),
      inputSchema: operatorAccountSearchInputSchema,
      invalid: 'An address prefix is an owner type, a colon, and the first 1 to 128 characters of the owner id.',
      read: (actor, input) => ledger.deskAccounts(actor, input),
      output: operatorAccountSearchOutputSchema,
    }),
  );

  app.get(
    '/operator/stats',
    lookup({
      input: () => ({}),
      inputSchema: z.object({}).strict(),
      invalid: 'The counts take no input.',
      read: () => ledger.readOperatorStats(),
      output: operatorStatsOutputSchema,
    }),
  );

  /**
   * An account's operator metadata (J-ops-console-03 #6, #7; `operator-account-metadata.ts`). The read takes the lookups'
   * authority and is recorded first; it answers while the posting freeze is on. The set and the delete are treasury
   * writes like the asset edit: a set is one founder's, a delete spends a second founder's approval
   * (`ledger.account_metadata.delete`). Both refuse 412 `ledger.frozen` under the freeze, with nothing changed.
   */
  const accountOf = (req: OperatorRequest) => (req.params as { accountId?: unknown } | undefined)?.accountId;

  app.get(
    '/operator/accounts/:accountId/metadata',
    lookup({
      input: (req) => ({ accountId: accountOf(req) }),
      inputSchema: accountMetadataReadInputSchema,
      invalid: 'An account id is a UUID.',
      read: (actor, input) => ledger.deskAccountMetadata(actor, input),
      output: accountMetadataOutputSchema,
    }),
  );

  /** A metadata refusal answers its own status; anything else (an approval refusal, say) goes to `guarded`. */
  const metadataWrite = async (reply: FastifyReply, write: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await write();
    } catch (err) {
      const status = err instanceof LedgerError ? METADATA_STATUS[err.code] : undefined;
      if (status === undefined) throw err;
      return reply.code(status).send({ message: (err as LedgerError).message, code: (err as LedgerError).code });
    }
  };

  const bodyFor = (req: OperatorRequest, body: unknown) => ({
    ...(body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}),
    accountId: accountOf(req),
  });

  app.post(
    '/operator/accounts/:accountId/metadata/set',
    guarded((operator, body, req, reply) =>
      metadataWrite(reply, async () => {
        const answer = accountMetadataChangeOutputSchema.parse(await ledger.setAccountMetadata(operator.userId, bodyFor(req, body)));
        app.log.warn({ actor: operator.userId, accountId: answer.accountId, key: answer.change.key }, 'LEDGER ACCOUNT METADATA set');
        return answer;
      }),
    ),
  );

  app.post(
    '/operator/accounts/:accountId/metadata/delete',
    guarded((operator, body, req, reply) =>
      metadataWrite(reply, async () => {
        const answer = accountMetadataChangeOutputSchema.parse(
          await ledger.deleteAccountMetadata(approvals, operator.userId, bodyFor(req, body)),
        );
        app.log.warn(
          { actor: operator.userId, accountId: answer.accountId, key: answer.change.key, approver: answer.change.approverId },
          'LEDGER ACCOUNT METADATA deleted',
        );
        return answer;
      }),
    ),
  );

  /**
   * The asset and network registry (W-balances-05), operator side. The read lists every row, published or
   * not, so a founder sees what is still blank. The write applies one edit two founders approved in identity
   * (`ledger.asset_edit`); the edit travels with the call and its hash must match the approval's.
   */
  app.get(
    '/operator/assets',
    guarded(async () => ({ assets: await ledger.listOperatorAssets() })),
  );

  app.post(
    '/operator/assets/apply-edit',
    guarded(async (operator, body) => {
      const asset = await ledger.applyAssetEdit(approvals, operator.userId, body);
      app.log.warn({ actor: operator.userId, assetId: asset.id, revision: asset.revision }, 'LEDGER ASSET EDIT applied');
      return asset;
    }),
  );

  /**
   * Operator reconciliation controls (OPS-reconciliation-01). Not `appRouter`: that router also serves `post`.
   * List is `admin:treasury` or `admin:compliance`. Define, update and run are treasury, and treasury requires MFA.
   * Define and update require a reason. Run also consumes an approval. The book's sql is the service's own handle.
   */
  const controls = controlSql(ledger);
  const actorOf = (operator: Principal, req: OperatorRequest) => ({
    actorId: operator.userId,
    requestId: typeof req.id === 'string' && req.id.length > 0 ? req.id : null,
  });

  app.get(
    '/operator/reconciliation/controls',
    guarded(async (_operator, _body, _req, reply) => {
      if (!controls) return reply.code(503).send(sourceUnavailable());
      return { controls: await listReconciliationControls(controls) };
    }, requireControlList),
  );

  app.post(
    '/operator/reconciliation/controls',
    guarded(async (operator, body, req, reply) => {
      if (!controls) return reply.code(503).send(sourceUnavailable());
      const input = defineReconciliationControlInputSchema.safeParse(body ?? {});
      if (!input.success) return reply.code(400).send(invalidControl(input.error));
      return defineReconciliationControl(controls, actorOf(operator, req), input.data);
    }),
  );

  app.post(
    '/operator/reconciliation/controls/update',
    guarded(async (operator, body, req, reply) => {
      if (!controls) return reply.code(503).send(sourceUnavailable());
      const input = updateReconciliationControlInputSchema.safeParse(body ?? {});
      if (!input.success) return reply.code(400).send(invalidControl(input.error));
      return updateReconciliationControl(controls, actorOf(operator, req), input.data, approvals);
    }),
  );

  app.post(
    '/operator/reconciliation/controls/run',
    guarded(async (operator, body, req, reply) => {
      if (!controls) return reply.code(503).send(sourceUnavailable());
      const input = runReconciliationControlInputSchema.safeParse(body ?? {});
      if (!input.success) return reply.code(400).send(invalidControl(input.error));
      const run = await runReconciliationControl(controls, approvals, actorOf(operator, req), input.data);
      app.log.info({ actor: operator.userId, controlId: run.controlId, status: run.status }, 'LEDGER RECONCILIATION CONTROL run');
      return run;
    }),
  );
}

function invalidControl(error: z.ZodError): { message: string; code: 'ledger.operator_request_failed' } {
  return { message: error.issues.map((issue) => issue.message).join('; '), code: 'ledger.operator_request_failed' };
}

/** `admin:compliance` may list. `admin:treasury` may list too, and it still requires a second factor. */
function requireControlList(principal: Principal): void {
  const scopes = ['admin:treasury', 'admin:compliance'] as const;
  let sawMfa = false;
  for (const scope of scopes) {
    if (!hasScope(principal.scopes, scope)) continue;
    try {
      requireScope(principal, scope);
      return;
    } catch (err) {
      if (err instanceof AuthError && err.code === 'mfa.required') {
        sawMfa = true;
        continue;
      }
    }
  }
  if (sawMfa) throw new AuthError('A second factor is required', 'mfa.required');
  throw new AuthError('One of admin:treasury, admin:compliance is required', 'scope.denied');
}

function controlSql(ledger: LedgerService): Sql | null {
  const sql = (ledger as unknown as { sql?: Sql }).sql;
  return sql ?? null;
}

function sourceUnavailable(): { message: string; code: typeof LEDGER_RECONCILE_SOURCE_UNAVAILABLE } {
  return { message: LEDGER_RECONCILE_SOURCE_UNAVAILABLE, code: LEDGER_RECONCILE_SOURCE_UNAVAILABLE };
}

function controlHttpStatus(code: string): number {
  if (code === 'ledger.idempotency_conflict') return 409;
  if (code === LEDGER_RECONCILE_CONTROL_NOT_FOUND) return 404;
  if (code === LEDGER_RECONCILE_ASOF_INVALID || code === OPS_CONTROL_ACTOR_UNSET || code === OPS_CONTROL_REASON_REQUIRED) return 400;
  if (code === LEDGER_RECONCILE_SOURCE_UNAVAILABLE) return 503;
  return 412;
}
