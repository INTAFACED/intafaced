import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts/trpc';
import { formatAmount } from '@intafaced/ledger-client';
import { ActionApprovalConsumeError, consumeTokenApproval, type ActionApprovalConsumer } from '../action-approval-consume.js';
import { DualControlError, requireDualControl } from '../dual-control.js';
import { userCopy } from '../user-copy.js';
import { checkEligibility, type ParticipantSource } from './eligibility.js';
import { LaunchError, launchCopy } from './errors.js';
import { LAUNCH_EVENT_CREATE_ACTION, LAUNCH_EVENT_MOVE_ACTION, LAUNCH_ISSUER_SET_ACTION, launchEventPayload } from './payload.js';
import { type CreateEventInput, type LaunchEvent, type LaunchService } from './launch-service.js';
import { launchId, eventOutput, createInput } from '@intafaced/contracts/token-call-schemas';
import {
  TOKEN_LAUNCH_ADMIN_MOVES,
  TOKEN_LAUNCH_ADMIN_ISSUERS,
  TOKEN_LAUNCH_ADMIN_EVENTS,
  TOKEN_LAUNCH_ISSUER_SET,
  TOKEN_LAUNCH_EVENTS_CREATE,
  TOKEN_LAUNCH_EVENTS_MOVE,
  TOKEN_LAUNCH_EVENTS_LIST,
  TOKEN_LAUNCH_EVENTS_GET,
  TOKEN_LAUNCH_ELIGIBILITY,
  TOKEN_LAUNCH_BASIS,
} from '@intafaced/contracts/token-launch-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { tokenRefusal } from '../refusal.js';

function eventToWire(e: LaunchEvent): z.infer<typeof eventOutput> {
  const amt = (v: bigint | null) => (v === null ? null : formatAmount(v));
  return {
    id: e.id,
    issuer: e.issuer,
    type: e.type,
    projectName: e.projectName,
    symbol: e.symbol,
    periods: {
      announceAt: e.periods.announceAt.toISOString(),
      snapshotAt: e.periods.snapshotAt.toISOString(),
      openAt: e.periods.openAt.toISOString(),
      closeAt: e.periods.closeAt.toISOString(),
      distributionAt: e.periods.distributionAt.toISOString(),
    },
    status: e.status,
    state: e.state,
    allocation: {
      method: e.allocation.method,
      perUserCap: amt(e.allocation.perUserCap),
      ticketSize: amt(e.allocation.ticketSize),
      tierWeights: e.allocation.tierWeights?.map((t) => ({ minBasis: formatAmount(t.minBasis), weight: t.weight })) ?? null,
    },
    terms: { price: amt(e.terms.price), paymentAsset: e.terms.paymentAsset, rateSource: e.terms.rateSource },
    snapshot: e.snapshot
      ? { count: e.snapshot.count, total: formatAmount(e.snapshot.total), takenAt: e.snapshot.takenAt.toISOString() }
      : null,
    revision: e.revision,
  };
}

function toCreateInput(input: z.infer<typeof createInput>): CreateEventInput {
  const p = input.periods;
  return {
    ...input,
    periods: {
      announceAt: new Date(p.announceAt),
      snapshotAt: new Date(p.snapshotAt),
      openAt: new Date(p.openAt),
      closeAt: new Date(p.closeAt),
      distributionAt: new Date(p.distributionAt),
    },
  };
}

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof DualControlError || err instanceof ActionApprovalConsumeError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
  }
  if (err instanceof LaunchError) {
    const message = err.code === 'launch.event_invalid' ? `${launchCopy(err.code)} ${err.message}` : launchCopy(err.code);
    switch (err.code) {
      case 'launch.event_not_found':
      case 'launch.issuer_not_found':
        return new TRPCError({ code: 'NOT_FOUND', message, cause: err });
      case 'launch.event_conflict':
      case 'launch.issuer_conflict':
      case 'launch.event_stale':
      case 'launch.issuer_stale':
        return new TRPCError({ code: 'CONFLICT', message, cause: err });
      case 'launch.event_invalid':
      case 'launch.event_move_invalid':
      case 'launch.issuer_move_invalid':
        return new TRPCError({ code: 'BAD_REQUEST', message, cause: err });
      default:
        return new TRPCError({ code: 'PRECONDITION_FAILED', message, cause: err });
    }
  }
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: userCopy('error.generic'), cause: err });
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toTrpcError(err);
  }
}

export interface LaunchRouterOptions {
  approvals: ActionApprovalConsumer;
  participants: ParticipantSource;
  /** The owner values as read at startup. Each check parses them again, so a blank one refuses every check with its own code. */
  eligibilityEnv: () => { TOKEN_LAUNCH_MIN_KYC_TIER?: string; TOKEN_LAUNCH_RESTRICTED_REGIONS?: string };
  now?: () => Date;
}

/**
 * `token.launch.*`. The catalogue and one event read signed in or out; eligibility and basis read the signed account
 * only (its id comes from the principal, never the input). Operator doors are `admin:write` plus the founders'
 * approval bound to the exact fields, and the approver is a second person.
 */
export function createLaunchRouter(launch: LaunchService, options: LaunchRouterOptions) {
  const now = options.now ?? (() => new Date());
  const signed = (userId: string | undefined): string => {
    if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
    return userId;
  };

  return router({
    events: router({
      list: mountRecord(
        TOKEN_LAUNCH_EVENTS_LIST,
        ({ input }) => guard(async () => (await launch.listEvents(input)).map(eventToWire)),
        tokenRefusal,
      ),

      get: mountRecord(
        TOKEN_LAUNCH_EVENTS_GET,
        ({ input }) => guard(async () => eventToWire(await launch.getEvent(input.id))),
        tokenRefusal,
      ),

      create: mountRecord(
        TOKEN_LAUNCH_EVENTS_CREATE,
        ({ ctx, input }) =>
          guard(async () => {
            const { approvalId, operationId, ...fields } = input;
            const event = toCreateInput(fields);
            // A launch the door would refuse never spends the founders' approval.
            const payload = launchEventPayload(event);
            await launch.checkCreate(event);
            const consumed = await consumeTokenApproval(
              options.approvals,
              { approvalId, operationId },
              LAUNCH_EVENT_CREATE_ACTION,
              { event: payload },
              '0',
            );
            const actorId = signed(ctx.principal.userId);
            const confirmOperatorId = requireDualControl(actorId, consumed.approverId);
            return { ...(await launch.createEvent(event, { actorId, approverId: confirmOperatorId })), confirmOperatorId };
          }),
        tokenRefusal,
      ),

      move: mountRecord(
        TOKEN_LAUNCH_EVENTS_MOVE,
        ({ ctx, input }) =>
          guard(async () => {
            const expected = String(input.expectedRevision);
            // A move the service would refuse never spends the founders' approval.
            await launch.checkMove({ id: input.id, to: input.to, expectedRevision: input.expectedRevision, now: now() });
            const consumed = await consumeTokenApproval(
              options.approvals,
              input,
              LAUNCH_EVENT_MOVE_ACTION,
              { eventId: input.id, to: input.to, expectedRevision: expected },
              expected,
            );
            const actorId = signed(ctx.principal.userId);
            const confirmOperatorId = requireDualControl(actorId, consumed.approverId);
            const event = await launch.moveEvent({
              id: input.id,
              to: input.to,
              expectedRevision: input.expectedRevision,
              actorId,
              approverId: confirmOperatorId,
              now: now(),
            });
            return { ...eventToWire(event), confirmOperatorId };
          }),
        tokenRefusal,
      ),
    }),

    issuer: router({
      set: mountRecord(
        TOKEN_LAUNCH_ISSUER_SET,
        ({ ctx, input }) =>
          guard(async () => {
            const expected = String(input.expectedRevision);
            // An issuer change the service would refuse never spends the founders' approval.
            await launch.checkIssuerSet(input);
            const consumed = await consumeTokenApproval(
              options.approvals,
              input,
              LAUNCH_ISSUER_SET_ACTION,
              { issuerId: input.id, name: input.name.trim(), state: input.state, expectedRevision: expected },
              expected,
            );
            const actorId = signed(ctx.principal.userId);
            const confirmOperatorId = requireDualControl(actorId, consumed.approverId);
            const issuer = await launch.setIssuer({
              id: input.id,
              name: input.name,
              state: input.state,
              expectedRevision: input.expectedRevision,
              actorId,
              approverId: confirmOperatorId,
            });
            return { ...issuer, confirmOperatorId };
          }),
        tokenRefusal,
      ),
    }),

    // The operator lens (J-more-catalogue-14): every launch, drafts included, every issuer, and the audited moves of
    // each. Reads only; every write above keeps the founders' approval.
    admin: router({
      events: mountRecord(
        TOKEN_LAUNCH_ADMIN_EVENTS,
        ({ input }) => guard(async () => (await launch.listAllEvents(input)).map(eventToWire)),
        tokenRefusal,
      ),

      event: scopedProcedure('admin:read')
        .input(z.object({ id: launchId }))
        .output(eventOutput)
        .query(({ input }) => guard(async () => eventToWire(await launch.getAnyEvent(input.id)))),

      issuers: mountRecord(TOKEN_LAUNCH_ADMIN_ISSUERS, ({ input }) => guard(() => launch.listIssuers(input)), tokenRefusal),

      moves: mountRecord(
        TOKEN_LAUNCH_ADMIN_MOVES,
        ({ input }) =>
          guard(async () => {
            const trails = await launch.moves(input.kind, [...new Set(input.ids)]);
            return Object.fromEntries([...trails].map(([id, moves]) => [id, moves.map((m) => ({ ...m, at: m.at.toISOString() }))]));
          }),
        tokenRefusal,
      ),
    }),

    // No module guard here: an account short of the token module's tier must still read which requirements it misses
    // (J-more-catalogue-11 #4). It reads only its own answer; basis and every write keep the guard.
    eligibility: mountRecord(
      TOKEN_LAUNCH_ELIGIBILITY,
      ({ ctx, input }) =>
        guard(async () => {
          const userId = signed(ctx.principal.userId);
          const event = await launch.getEvent(input.id);
          return checkEligibility(options.eligibilityEnv(), options.participants, event, {
            userId,
            subAccount: Boolean(ctx.principal.sub_account),
          });
        }),
      tokenRefusal,
    ),

    basis: mountRecord(
      TOKEN_LAUNCH_BASIS,
      ({ ctx, input }) =>
        guard(async () => {
          const b = await launch.readBasis(input.id, signed(ctx.principal.userId));
          const amt = (v: bigint | null) => (v === null ? null : formatAmount(v));
          return {
            eventId: b.eventId,
            method: b.method,
            perUserCap: amt(b.perUserCap),
            ticketSize: amt(b.ticketSize),
            tierWeights: b.tierWeights?.map((t) => ({ minBasis: formatAmount(t.minBasis), weight: t.weight })) ?? null,
            basis: amt(b.basis),
            reason: b.reason,
            takenAt: b.takenAt?.toISOString() ?? null,
            tickets: b.tickets === null ? null : b.tickets.toString(),
            tierWeight: b.tierWeight,
          };
        }),
      tokenRefusal,
    ),
  });
}

export { LAUNCH_EVENT_CREATE_ACTION, LAUNCH_EVENT_MOVE_ACTION, LAUNCH_ISSUER_SET_ACTION, launchEventPayload };
