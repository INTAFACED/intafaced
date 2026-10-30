import { TRPCError } from '@trpc/server';
import { scopedProcedure } from '@intafaced/contracts';
import {
  OPS_RESOLVE_NOTE_REQUIRED,
  opsAlertAcceptInputSchema,
  opsAlertAcknowledgeInputSchema,
  opsAlertDetailSchema,
  opsAlertGetInputSchema,
  opsAlertListInputSchema,
  opsAlertListSchema,
  opsAlertResolveInputSchema,
  opsAlertSnoozeInputSchema,
  opsAlertUnsnoozeInputSchema,
  opsPlatformIncidentsInputSchema,
  opsPlatformIncidentsSchema,
  opsReconciliationPeriodsInputSchema,
  opsReconciliationPeriodsSchema,
} from '@intafaced/contracts/ops-reconciliation-alerts';
import {
  OPS_ALERT_ACTOR_UNSET,
  OPS_ALERT_FORBIDDEN,
  OPS_ALERT_NOT_FOUND,
  OPS_ALERT_NOTE_REQUIRED,
  OPS_ALERT_STATE_ILLEGAL,
  OPS_ALERT_STORAGE_UNCONFIGURED,
  OPS_IDEMPOTENCY_CONFLICT,
  OpsError,
} from '../codes.js';
import { assertIdempotencyKey } from '../operator-desks.js';
import type { ReconciliationAlertStore } from './store.js';

const guards = { module: 'core-ops' as const, plane: 'fiat' as const };

function reconciliationAlertError(err: unknown): never {
  if (err instanceof OpsError) {
    const code =
      err.code === OPS_ALERT_FORBIDDEN
        ? 'FORBIDDEN'
        : err.code === OPS_ALERT_NOT_FOUND
          ? 'NOT_FOUND'
          : err.code === OPS_ALERT_STATE_ILLEGAL || err.code === OPS_IDEMPOTENCY_CONFLICT
            ? 'CONFLICT'
            : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: `${err.code} — ${err.message}`, cause: err });
  }
  throw err;
}

/**
 * Reconciliation alerts (OPS-reconciliation-03, -04): read, acknowledge, snooze, resolve, accept, the periods' green
 * state and the platform incidents. Without storage every call refuses `ops.alert_storage_unconfigured`; a failed ledger
 * read shows on every answer as the source, never as an empty list. Resolve and accept run on the treasury credential
 * (`admin:treasury`), whose holder is a founder: resolve is that founder alone, accept spends a second founder's approval.
 */
export function createReconciliationAlertRoutes(
  store: ReconciliationAlertStore | undefined,
  options: { bus?: () => 'attached' | 'detached' } = {},
) {
  const run = async <T>(work: (desk: ReconciliationAlertStore) => Promise<T>): Promise<T> => {
    try {
      if (!store) {
        throw new OpsError(OPS_ALERT_STORAGE_UNCONFIGURED, 'No durable storage is configured for alerts. Nothing was read or saved.');
      }
      return await work(store);
    } catch (err) {
      return reconciliationAlertError(err);
    }
  };
  const actor = (principal: { userId: string; mfa: boolean }): string => {
    if (!principal.mfa) throw new OpsError(OPS_ALERT_FORBIDDEN, 'This write needs a second factor on this session.');
    const id = principal.userId.trim();
    if (!id) throw new OpsError(OPS_ALERT_ACTOR_UNSET, 'The operator id is blank. Nothing was saved.');
    return id;
  };
  const reader = scopedProcedure('admin:read', guards);
  const writer = scopedProcedure('admin:write', guards);
  const treasury = scopedProcedure('admin:treasury', guards);

  return {
    list: reader
      .input(opsAlertListInputSchema)
      .output(opsAlertListSchema)
      .query(({ input }) => run((desk) => desk.list(input))),
    get: reader
      .input(opsAlertGetInputSchema)
      .output(opsAlertDetailSchema)
      .query(({ input }) => run((desk) => desk.get(input.alertId))),
    acknowledge: writer
      .input(opsAlertAcknowledgeInputSchema)
      .output(opsAlertDetailSchema)
      .mutation(({ ctx, input }) =>
        run((desk) => {
          const by = actor(ctx.principal);
          const note = input.note.trim();
          if (!note) throw new OpsError(OPS_ALERT_NOTE_REQUIRED, 'An acknowledgement needs a note. Nothing was changed.');
          return desk.acknowledge({ alertId: input.alertId, actor: by, note, key: assertIdempotencyKey(input.idempotencyKey) });
        }),
      ),
    snooze: writer
      .input(opsAlertSnoozeInputSchema)
      .output(opsAlertDetailSchema)
      .mutation(({ ctx, input }) =>
        run((desk) =>
          desk.snooze({
            alertId: input.alertId,
            actor: actor(ctx.principal),
            endsAt: input.endsAt,
            reason: input.reason?.trim() || null,
            key: assertIdempotencyKey(input.idempotencyKey),
          }),
        ),
      ),
    unsnooze: writer
      .input(opsAlertUnsnoozeInputSchema)
      .output(opsAlertDetailSchema)
      .mutation(({ ctx, input }) =>
        run((desk) =>
          desk.unsnooze({ alertId: input.alertId, actor: actor(ctx.principal), key: assertIdempotencyKey(input.idempotencyKey) }),
        ),
      ),
    resolve: treasury
      .input(opsAlertResolveInputSchema)
      .output(opsAlertDetailSchema)
      .mutation(({ ctx, input }) =>
        run((desk) =>
          desk.resolveFixed({
            alertId: input.alertId,
            actor: actor(ctx.principal),
            txIds: input.correctiveTxIds,
            note: input.note?.trim() || null,
            key: assertIdempotencyKey(input.idempotencyKey),
          }),
        ),
      ),
    accept: treasury
      .input(opsAlertAcceptInputSchema)
      .output(opsAlertDetailSchema)
      .mutation(({ ctx, input }) =>
        run((desk) => {
          // Checked before the second factor and the approval, so a blank note never spends anything.
          if (!input.note.trim()) {
            throw new OpsError(
              OPS_RESOLVE_NOTE_REQUIRED,
              'Accepting a discrepancy needs a note. Nothing was changed and no approval was spent.',
            );
          }
          return desk.accept({
            alertId: input.alertId,
            requesterId: actor(ctx.principal),
            note: input.note,
            evidenceHash: input.evidenceHash,
            approvalId: input.approvalId,
            operationId: input.operationId,
          });
        }),
      ),
    platformIncidents: reader
      .input(opsPlatformIncidentsInputSchema)
      .output(opsPlatformIncidentsSchema)
      .query(({ input }) => run(async (desk) => ({ bus: options.bus?.() ?? 'detached', incidents: await desk.incidents(input.limit) }))),
    periods: reader
      .input(opsReconciliationPeriodsInputSchema)
      .output(opsReconciliationPeriodsSchema)
      .query(({ input }) => run((desk) => desk.periods(input))),
  };
}
