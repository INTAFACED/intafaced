import { z } from 'zod';
import { router, publicProcedure, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { formatAmount } from '@intafaced/ledger-client';
import { ActionApprovalConsumeError, consumeTokenApproval, type ActionApprovalConsumer } from '../action-approval-consume.js';
import { DualControlError, requireDualControl } from '../dual-control.js';
import { userCopy } from '../user-copy.js';
import { checkEligibility, type ParticipantSource } from './eligibility.js';
import { LaunchError, launchCopy } from './errors.js';
import {
  ALLOCATION_METHODS,
  ISSUER_STATES,
  LAUNCH_STATES,
  LAUNCH_STATUSES,
  LAUNCH_TYPES,
  canonicalEvent,
  type CreateEventInput,
  type LaunchEvent,
  type LaunchService,
} from './launch-service.js';

/** The founders' approvals for the three operator doors. Each binds the fields it changes. */
export const LAUNCH_ISSUER_SET_ACTION = 'token.launch.issuer.set';
export const LAUNCH_EVENT_CREATE_ACTION = 'token.launch.event.create';
export const LAUNCH_EVENT_MOVE_ACTION = 'token.launch.event.move';

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amount must be an unsigned decimal string (max 18dp)');
const launchId = z.string().min(3).max(63);
const iso = z.string().datetime({ offset: true });

const eventOutput = z.object({
  id: z.string(),
  issuer: z.object({ id: z.string(), name: z.string(), state: z.enum(ISSUER_STATES) }),
  type: z.enum(LAUNCH_TYPES),
  projectName: z.string(),
  symbol: z.string(),
  periods: z.object({ announceAt: z.string(), snapshotAt: z.string(), openAt: z.string(), closeAt: z.string(), distributionAt: z.string() }),
  status: z.enum(LAUNCH_STATUSES),
  state: z.enum(LAUNCH_STATES).nullable(),
  allocation: z.object({
    method: z.enum(ALLOCATION_METHODS).nullable(),
    perUserCap: amountString.nullable(),
    ticketSize: amountString.nullable(),
    tierWeights: z.array(z.object({ minBasis: amountString, weight: z.number().int() })).nullable(),
  }),
  terms: z.object({ price: amountString.nullable(), paymentAsset: z.string().nullable(), rateSource: z.string().nullable() }),
  snapshot: z.object({ count: z.number().int(), total: amountString, takenAt: z.string() }).nullable(),
  revision: z.number().int(),
});

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
    snapshot: e.snapshot ? { count: e.snapshot.count, total: formatAmount(e.snapshot.total), takenAt: e.snapshot.takenAt.toISOString() } : null,
    revision: e.revision,
  };
}

const createInput = z.object({
  id: launchId,
  issuerId: launchId,
  type: z.enum(LAUNCH_TYPES),
  projectName: z.string().min(1).max(120),
  symbol: z.string().min(2).max(12),
  periods: z.object({ announceAt: iso, snapshotAt: iso, openAt: iso, closeAt: iso, distributionAt: iso }).strict(),
  allocation: z
    .object({
      method: z.enum(ALLOCATION_METHODS).nullable(),
      perUserCap: amountString.nullable(),
      ticketSize: amountString.nullable(),
      tierWeights: z.array(z.object({ minBasis: amountString, weight: z.number().int() }).strict()).max(16).nullable(),
    })
    .strict(),
  terms: z.object({ price: amountString.nullable(), paymentAsset: z.string().max(12).nullable(), rateSource: z.string().max(120).nullable() }).strict(),
});

const approvalFields = { approvalId: z.string().max(128).nullish(), operationId: z.string().max(128).nullish() };

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

/** The canonical event the founders approve: stored values in a fixed order, times as UTC ISO. */
export function launchEventPayload(input: CreateEventInput): string {
  const e = canonicalEvent(input);
  const amt = (v: bigint | null) => (v === null ? null : formatAmount(v));
  return JSON.stringify({
    id: e.id,
    issuerId: e.issuerId,
    type: e.type,
    projectName: e.projectName,
    symbol: e.symbol,
    periods: [e.periods.announceAt, e.periods.snapshotAt, e.periods.openAt, e.periods.closeAt, e.periods.distributionAt].map((d) => d.toISOString()),
    method: e.method,
    perUserCap: amt(e.perUserCap),
    ticketSize: amt(e.ticketSize),
    tierWeights: e.tierWeights?.map((t) => [formatAmount(t.minBasis), t.weight]) ?? null,
    price: amt(e.price),
    paymentAsset: e.paymentAsset,
    rateSource: e.rateSource,
  });
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
  /** The owner values read per check, so a change is never cached. */
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
      list: publicProcedure
        .input(
          z
            .object({
              type: z.enum(LAUNCH_TYPES).optional(),
              state: z.enum(LAUNCH_STATES).optional(),
              /** Optional here so an omit reaches `launch.events_list_limit_unset`, not a Zod "Required". */
              limit: z.number().int().min(1).max(200).optional(),
            })
            .default({}),
        )
        .output(z.array(eventOutput))
        .query(({ input }) => guard(async () => (await launch.listEvents(input)).map(eventToWire))),

      get: publicProcedure
        .input(z.object({ id: launchId }))
        .output(eventOutput)
        .query(({ input }) => guard(async () => eventToWire(await launch.getEvent(input.id)))),

      create: scopedProcedure('admin:write')
        .input(createInput.extend(approvalFields))
        .output(z.object({ id: z.string(), status: z.enum(LAUNCH_STATUSES), revision: z.number().int(), confirmOperatorId: z.string() }))
        .mutation(({ ctx, input }) =>
          guard(async () => {
            const { approvalId, operationId, ...fields } = input;
            const event = toCreateInput(fields);
            // A launch the door would refuse never spends the founders' approval.
            const payload = launchEventPayload(event);
            const consumed = await consumeTokenApproval(options.approvals, { approvalId, operationId }, LAUNCH_EVENT_CREATE_ACTION, { event: payload }, '0');
            const confirmOperatorId = requireDualControl(ctx.principal.userId, consumed.approverId);
            return { ...(await launch.createEvent(event)), confirmOperatorId };
          }),
        ),

      move: scopedProcedure('admin:write')
        .input(
          z.object({
            id: launchId,
            to: z.enum(LAUNCH_STATUSES),
            expectedRevision: z.number().int().min(0),
            ...approvalFields,
          }),
        )
        .output(eventOutput.extend({ confirmOperatorId: z.string() }))
        .mutation(({ ctx, input }) =>
          guard(async () => {
            const expected = String(input.expectedRevision);
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
        ),
    }),

    issuer: router({
      set: scopedProcedure('admin:write')
        .input(
          z.object({
            id: launchId,
            name: z.string().min(1).max(120),
            state: z.enum(ISSUER_STATES),
            expectedRevision: z.number().int().min(0),
            ...approvalFields,
          }),
        )
        .output(z.object({ id: z.string(), name: z.string(), state: z.enum(ISSUER_STATES), revision: z.number().int(), confirmOperatorId: z.string() }))
        .mutation(({ ctx, input }) =>
          guard(async () => {
            const expected = String(input.expectedRevision);
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
        ),
    }),

    eligibility: scopedProcedure('token:read', { module: 'token' })
      .input(z.object({ id: launchId }))
      .output(
        z.object({
          eventId: z.string(),
          eligible: z.boolean(),
          requirements: z.array(
            z.object({
              id: z.enum(['identity_verification', 'region', 'account_active', 'main_account', 'issuer_onboarded', 'event_open']),
              met: z.boolean(),
              required: z.string(),
              actual: z.string(),
            }),
          ),
        }),
      )
      .query(({ ctx, input }) =>
        guard(async () => {
          const userId = signed(ctx.principal.userId);
          const event = await launch.getEvent(input.id);
          return checkEligibility(options.eligibilityEnv(), options.participants, event, {
            userId,
            subAccount: Boolean(ctx.principal.sub_account),
          });
        }),
      ),

    basis: scopedProcedure('token:read', { module: 'token' })
      .input(z.object({ id: launchId }))
      .output(
        z.object({
          eventId: z.string(),
          method: z.enum(ALLOCATION_METHODS).nullable(),
          perUserCap: amountString.nullable(),
          ticketSize: amountString.nullable(),
          tierWeights: z.array(z.object({ minBasis: amountString, weight: z.number().int() })).nullable(),
          basis: amountString.nullable(),
          reason: z.enum(['snapshot_not_taken', 'no_holdings_at_snapshot']).nullable(),
          takenAt: z.string().nullable(),
          tickets: z.string().nullable(),
          tierWeight: z.number().int().nullable(),
        }),
      )
      .query(({ ctx, input }) =>
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
      ),
  });
}
