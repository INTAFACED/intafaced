/**
 * THE OPERATOR'S PARTNER STOP (project-state #1790; the money model's change 4 item 3, approved 10 Nov 2026).
 *
 * A second, narrower stop beside svc-ledger's platform posting freeze: operations can stop the instructions svc-bank
 * sends to one partner, or only one kind of them, without freezing the book. It adds a refusal and removes none: every
 * partner instruction still asks the posting freeze, and a stopped kind is refused `bank.partner_stopped` before the
 * partner is asked, while posting stays enabled for everything else.
 *
 * Kinds: `bank_move` (every partner bank move: transfers, payouts, returns, space moves) and the four partner card
 * instructions (`card_hold`, `card_capture`, `card_release`, `card_refund`). Reads are never stopped.
 *
 * No row means the partner has never been stopped. A state that cannot be read refuses the instruction
 * (`bank.partner_stop_unreadable`): an unknown state is not "open".
 *
 * A change names the revision it was made against, as the asset pause does (`ops/asset-pause.ts`): the history row for
 * (partner, revision) carries the business key `ops-partner-stop:<partner>:<revision>`, so a retry of the same change
 * replays and a different change on the same revision refuses `bank.ops_revision_conflict`. A change also needs a
 * second person: an identity approval bound to the partner and the new kinds, consumed before the write.
 */
import { scopedProcedure } from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { BankError } from '../errors.js';
import type { PartnerCardHolds } from '../cards/partner-card-holds.js';
import type { PartnerAccountRef, PartnerBank, PartnerCustody, PartnerMoveRequest, PartnerMovesQuery } from './partner-bank.js';

export const PARTNER_STOP_KINDS = ['bank_move', 'card_hold', 'card_capture', 'card_release', 'card_refund'] as const;
export type PartnerStopKind = (typeof PARTNER_STOP_KINDS)[number];

/** The TEST partner's id on the stop, the only partner wired today. */
export const TEST_PARTNER_ID = 'test-partner';

export interface PartnerStopState {
  partnerId: string;
  /** Sorted. Empty when nothing is stopped. */
  stoppedKinds: PartnerStopKind[];
  /** 0 when the partner has never been stopped. */
  revision: number;
  reason: string | null;
  approvedBy: string | null;
  updatedAt: string | null;
}

export interface PartnerStopChange {
  partnerId: string;
  stoppedKinds: readonly PartnerStopKind[];
  /** The revision the operator saw. The change becomes revision + 1. */
  expectedRevision: number;
  reason: string;
  /** Consumes the second person's approval; returns the approver id. */
  consume: () => Promise<string>;
}

/** What a partner instruction asks before it is sent. */
export interface PartnerStopGate {
  /** Refuses `bank.partner_stopped` when the kind is stopped, `bank.partner_stop_unreadable` when that is not known. */
  assertOpen(partnerId: string, kind: PartnerStopKind): Promise<void>;
}

interface StopRow {
  partner_id: string;
  stopped_kinds: string[];
  revision: number;
  reason: string;
  approved_by: string;
  updated_at: Date;
}

interface HistoryRow {
  partner_id: string;
  revision: number;
  stopped_kinds: string[];
  reason: string;
  approved_by: string;
}

export function partnerStopChangeKey(partnerId: string, revision: number): string {
  return `ops-partner-stop:${partnerId}:${revision}`;
}

function normalKinds(kinds: readonly string[]): PartnerStopKind[] {
  return PARTNER_STOP_KINDS.filter((k) => kinds.includes(k));
}

function toState(row: StopRow): PartnerStopState {
  return {
    partnerId: row.partner_id,
    stoppedKinds: normalKinds(row.stopped_kinds),
    revision: Number(row.revision),
    reason: row.reason,
    approvedBy: row.approved_by,
    updatedAt: row.updated_at.toISOString(),
  };
}

function neverStopped(partnerId: string): PartnerStopState {
  return { partnerId, stoppedKinds: [], revision: 0, reason: null, approvedBy: null, updatedAt: null };
}

export function partnerStopped(kind: PartnerStopKind): BankError {
  return new BankError(
    `Operations have stopped this kind of move (${kind}) at the partner for now. Nothing was sent or changed.`,
    'bank.partner_stopped',
  );
}

export class PartnerStopService implements PartnerStopGate {
  constructor(private readonly sql: Sql) {}

  async list(): Promise<PartnerStopState[]> {
    const rows = await this.sql<StopRow[]>`
      SELECT partner_id, stopped_kinds, revision, reason, approved_by, updated_at
        FROM bank.partner_stops ORDER BY partner_id
    `;
    return rows.map(toState);
  }

  async state(partnerId: string): Promise<PartnerStopState> {
    const rows = await this.sql<StopRow[]>`
      SELECT partner_id, stopped_kinds, revision, reason, approved_by, updated_at
        FROM bank.partner_stops WHERE partner_id = ${partnerId}
    `;
    return rows[0] ? toState(rows[0]) : neverStopped(partnerId);
  }

  async assertOpen(partnerId: string, kind: PartnerStopKind): Promise<void> {
    let rows: Array<{ stopped_kinds: string[] }>;
    try {
      rows = await this.sql<Array<{ stopped_kinds: string[] }>>`
        SELECT stopped_kinds FROM bank.partner_stops WHERE partner_id = ${partnerId}
      `;
    } catch {
      // The database detail is not a customer message; the code says enough to retry later.
      throw new BankError(
        'Whether moves at the partner are stopped could not be read, so nothing was sent.',
        'bank.partner_stop_unreadable',
      );
    }
    if (rows[0]?.stopped_kinds.includes(kind)) throw partnerStopped(kind);
  }

  async set(change: PartnerStopChange): Promise<PartnerStopState & { replayed: boolean }> {
    const reason = change.reason.trim();
    if (reason.length < 10) {
      throw new BankError(
        'A partner stop change needs a reason of at least 10 characters (bank.ops_reason_too_short)',
        'bank.ops_reason_too_short',
      );
    }
    if (!Number.isSafeInteger(change.expectedRevision) || change.expectedRevision < 0) {
      throw new BankError('expectedRevision must be the revision the desk read (0 for never stopped)', 'bank.validation_failed');
    }
    const unknown = change.stoppedKinds.filter((k) => !(PARTNER_STOP_KINDS as readonly string[]).includes(k));
    if (unknown.length > 0) throw new BankError(`Unknown partner move kind: ${unknown.join(', ')}`, 'bank.validation_failed');
    const kinds = normalKinds(change.stoppedKinds);
    const revision = change.expectedRevision + 1;

    const prior = await this.history(this.sql, change.partnerId, revision);
    if (prior) return this.replay(prior, change, kinds, reason);

    const current = await this.state(change.partnerId);
    if (current.revision !== change.expectedRevision) throw this.conflict(change.partnerId, change.expectedRevision, current.revision);

    const approvedBy = await change.consume();

    return transaction(this.sql, async (tx) => {
      const locked = await tx<Array<{ revision: number }>>`
        SELECT revision FROM bank.partner_stops WHERE partner_id = ${change.partnerId} FOR UPDATE
      `;
      const now = locked[0] ? Number(locked[0].revision) : 0;
      if (now !== change.expectedRevision) {
        const raced = await this.history(tx, change.partnerId, revision);
        if (raced) return this.replay(raced, change, kinds, reason);
        throw this.conflict(change.partnerId, change.expectedRevision, now);
      }
      const inserted = await tx<Array<{ partner_id: string }>>`
        INSERT INTO bank.partner_stop_history (partner_id, revision, change_key, stopped_kinds, reason, approved_by)
        VALUES (${change.partnerId}, ${revision}, ${partnerStopChangeKey(change.partnerId, revision)}, ${kinds}, ${reason}, ${approvedBy})
        ON CONFLICT DO NOTHING
        RETURNING partner_id
      `;
      if (inserted.length === 0) {
        // A first-revision race: no row to lock, and the other change won the key.
        const raced = await this.history(tx, change.partnerId, revision);
        if (raced) return this.replay(raced, change, kinds, reason);
        throw this.conflict(change.partnerId, change.expectedRevision, revision);
      }
      const rows = await tx<StopRow[]>`
        INSERT INTO bank.partner_stops (partner_id, stopped_kinds, revision, reason, approved_by, updated_at)
        VALUES (${change.partnerId}, ${kinds}, ${revision}, ${reason}, ${approvedBy}, now())
        ON CONFLICT (partner_id) DO UPDATE
          SET stopped_kinds = EXCLUDED.stopped_kinds, revision = EXCLUDED.revision, reason = EXCLUDED.reason,
              approved_by = EXCLUDED.approved_by, updated_at = EXCLUDED.updated_at
        RETURNING partner_id, stopped_kinds, revision, reason, approved_by, updated_at
      `;
      return { ...toState(rows[0]!), replayed: false };
    });
  }

  /** Newest first. */
  async historyOf(
    partnerId: string,
    limit: number,
  ): Promise<Array<Omit<PartnerStopState, 'updatedAt'> & { changeKey: string; at: string }>> {
    const rows = await this.sql<Array<HistoryRow & { change_key: string; created_at: Date }>>`
      SELECT partner_id, revision, change_key, stopped_kinds, reason, approved_by, created_at
        FROM bank.partner_stop_history WHERE partner_id = ${partnerId}
       ORDER BY revision DESC LIMIT ${limit}
    `;
    return rows.map((r) => ({
      partnerId: r.partner_id,
      revision: Number(r.revision),
      changeKey: r.change_key,
      stoppedKinds: normalKinds(r.stopped_kinds),
      reason: r.reason,
      approvedBy: r.approved_by,
      at: r.created_at.toISOString(),
    }));
  }

  private async history(sql: Sql, partnerId: string, revision: number): Promise<HistoryRow | null> {
    const rows = await sql<HistoryRow[]>`
      SELECT partner_id, revision, stopped_kinds, reason, approved_by
        FROM bank.partner_stop_history WHERE change_key = ${partnerStopChangeKey(partnerId, revision)}
    `;
    return rows[0] ?? null;
  }

  private replay(
    prior: HistoryRow,
    change: PartnerStopChange,
    kinds: PartnerStopKind[],
    reason: string,
  ): PartnerStopState & { replayed: boolean } {
    const priorKinds = normalKinds(prior.stopped_kinds);
    if (priorKinds.join(',') !== kinds.join(',') || prior.reason !== reason) {
      throw this.conflict(change.partnerId, change.expectedRevision, Number(prior.revision));
    }
    return {
      partnerId: prior.partner_id,
      stoppedKinds: priorKinds,
      revision: Number(prior.revision),
      reason: prior.reason,
      approvedBy: prior.approved_by,
      updatedAt: null,
      replayed: true,
    };
  }

  private conflict(partnerId: string, expected: number, actual: number): BankError {
    return new BankError(
      `The stop for partner ${partnerId} changed underneath this request (expected revision ${expected}, found ${actual}); read it again`,
      'bank.ops_revision_conflict',
    );
  }
}

/**
 * Every partner bank move asks the stop first (`bank_move`). Reads stay open. Wrap outside the posting freeze's guard,
 * so the freeze is still asked for every move the stop lets through.
 */
export function stopGuardedCustody(custody: PartnerCustody, partnerId: string, gate: PartnerStopGate): PartnerCustody {
  const guarded = new WeakMap<PartnerBank, PartnerBank>();
  const guard = (bank: PartnerBank): PartnerBank => {
    let wrapped = guarded.get(bank);
    if (!wrapped) {
      // One wrapper per partner, so two sides of one move still compare as the same partner.
      wrapped = Object.freeze({
        label: bank.label,
        balance: (account: PartnerAccountRef) => bank.balance(account),
        balances: (userId: string) => bank.balances(userId),
        moveByKey: (key: string) => bank.moveByKey(key),
        moves: (userId: string, query: PartnerMovesQuery) => bank.moves(userId, query),
        move: async (request: PartnerMoveRequest) => {
          await gate.assertOpen(partnerId, 'bank_move');
          return bank.move(request);
        },
      });
      guarded.set(bank, wrapped);
    }
    return wrapped;
  };
  return {
    bankFor: (userId) => {
      const bank = custody.bankFor(userId);
      return bank ? guard(bank) : null;
    },
  };
}

/**
 * Every partner card instruction asks the stop for its own kind first. A stopped capture, release or refund is not a
 * `PartnerCardRefusal`: the partner never said no, so the claim stays pending and is re-sent under the same key once
 * the stop is lifted. A stopped hold is a decline once the partner confirms it holds nothing under the key, exactly as
 * the posting freeze's (`card-service.ts`, `commitPartnerHold`). Reads (figures, holdState) stay open.
 */
export function stopGuardedCardHolds(holds: PartnerCardHolds, partnerId: string, gate: PartnerStopGate): PartnerCardHolds {
  return Object.freeze({
    test: holds.test,
    figures: (input: { userId: string; assetId: string }) => holds.figures(input),
    holdState: (input: { holdKey: string }) => holds.holdState(input),
    hold: async (input: Parameters<PartnerCardHolds['hold']>[0]) => {
      await gate.assertOpen(partnerId, 'card_hold');
      return holds.hold(input);
    },
    capture: async (input: Parameters<PartnerCardHolds['capture']>[0]) => {
      await gate.assertOpen(partnerId, 'card_capture');
      return holds.capture(input);
    },
    release: async (input: Parameters<PartnerCardHolds['release']>[0]) => {
      await gate.assertOpen(partnerId, 'card_release');
      return holds.release(input);
    },
    refund: async (input: Parameters<PartnerCardHolds['refund']>[0]) => {
      await gate.assertOpen(partnerId, 'card_refund');
      return holds.refund(input);
    },
  });
}

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

const kindSchema = z.enum(PARTNER_STOP_KINDS);
const stopState = z.object({
  partnerId: z.string(),
  stoppedKinds: z.array(kindSchema),
  revision: z.number().int(),
  reason: z.string().nullable(),
  approvedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

/** Desk read: every partner that has ever been stopped, and the kinds a stop can name. */
export function partnerStopsProcedure(stops: () => PartnerStopService, guard: Guard) {
  return scopedProcedure('admin:read')
    .input(
      z.object({ historyFor: z.string().min(1).max(64).optional(), historyLimit: z.number().int().min(1).max(200).optional() }).optional(),
    )
    .output(
      z.object({
        kinds: z.array(kindSchema),
        partners: z.array(stopState),
        history: z.array(stopState.omit({ updatedAt: true }).extend({ changeKey: z.string(), at: z.string() })),
      }),
    )
    .query(({ input }) =>
      guard(async () => {
        if (input?.historyFor !== undefined && input.historyLimit === undefined) {
          throw new BankError('historyLimit is required with historyFor; blank is not 50', 'bank.validation_failed');
        }
        const service = stops();
        const partners = await service.list();
        const history = input?.historyFor !== undefined ? await service.historyOf(input.historyFor, input.historyLimit!) : [];
        return { kinds: [...PARTNER_STOP_KINDS], partners, history };
      }),
    );
}

export function setPartnerStopProcedure(
  stops: () => PartnerStopService,
  consumeOpsApproval: (
    input: { approvalId?: string | null; operationId?: string | null },
    actionType: string,
    fields: Record<string, string>,
  ) => Promise<string>,
  guard: Guard,
) {
  return scopedProcedure('admin:treasury')
    .input(
      z.object({
        partnerId: z.string().min(1).max(64),
        stoppedKinds: z.array(kindSchema).max(PARTNER_STOP_KINDS.length),
        expectedRevision: z.number().int().min(0),
        reason: z.string(),
        approvalId: z.string().max(128).nullish(),
        operationId: z.string().max(128).nullish(),
      }),
    )
    .output(stopState.extend({ replayed: z.boolean() }))
    .mutation(({ input }) =>
      guard(() =>
        stops().set({
          partnerId: input.partnerId,
          stoppedKinds: input.stoppedKinds,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
          consume: () =>
            consumeOpsApproval(input, 'bank.ops.setPartnerStop', {
              partnerId: input.partnerId,
              stoppedKinds: normalKinds(input.stoppedKinds).join(','),
              revision: String(input.expectedRevision + 1),
            }),
        }),
      ),
    );
}
