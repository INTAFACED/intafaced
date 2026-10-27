import { createHash } from 'node:crypto';
import {
  CONSOLE_MODE_STORAGE_UNCONFIGURED,
  CONSOLE_MODE_TARGET_ID,
  CONSOLE_MODE_TARGET_SERVICE,
  consoleModeApprovalFields,
  consoleModeIdempotencyKey,
  type ConsoleMode,
  type ConsoleModeSetInput,
  type ConsoleModeSetOutput,
} from '@intafaced/contracts';
import { OPS_IDEMPOTENCY_CONFLICT, OpsError } from '../codes.js';
import { consumeFounderApproval, type ApprovalConsumer } from '../operator-desks.js';
import type { ConsoleModeStore, ModeState } from './store.js';

export interface ConsoleModeDeskDeps {
  readonly store: ConsoleModeStore | undefined;
  readonly approvals: ApprovalConsumer | undefined;
  readonly now: () => string;
}

const view = (state: ModeState, asOf: string): ConsoleMode => ({ ...state, asOf });

/**
 * Maintenance mode for the founder console (OPS-admin-access-08). Turning it on (with a reason) and turning it off each need
 * a second founder's approval, spent once; one founder alone cannot change it either way. Each change is idempotent on
 * `<action>:<approvalId>`: a retry after the change was stored returns it and spends nothing.
 *
 * A replay must ask for what was logged (the same reason), or it is refused `ops.idempotency_conflict`. A change runs whole
 * under the store's lock, so two runs of one approval at once never both reach identity: the second waits, finds the first's
 * change logged and answers `replayed`.
 *
 * A crash between the spend and the write is not recoverable by a retry: the retry is refused
 * `action_approval.not_founders`, the mode stays as it was, and the founders approve again (the same limit as the protocol
 * listing desk). Nothing here touches the posting freeze or any account.
 */
export class ConsoleModeDesk {
  constructor(private readonly deps: ConsoleModeDeskDeps) {}

  private store(): ConsoleModeStore {
    if (!this.deps.store)
      throw new OpsError(
        CONSOLE_MODE_STORAGE_UNCONFIGURED,
        'No durable storage is configured for the console mode, so it cannot be read or changed (it is never on).',
      );
    return this.deps.store;
  }

  async get(): Promise<ConsoleMode> {
    const state = await this.store().get();
    return view(state, this.deps.now());
  }

  async set(requesterId: string, input: ConsoleModeSetInput): Promise<ConsoleModeSetOutput> {
    // The key is the approval id as identity spends it (consumeFounderApproval trims it the same way).
    const approvalId = input.approvalId.trim();
    const key = consoleModeIdempotencyKey(input.action, approvalId);
    // The contract's schema has already trimmed the reason.
    const reason = input.action === 'ops.console_mode.on' ? input.reason : null;
    return this.store().change(async (locked) => {
      const logged = await locked.logged(key);
      if (logged) {
        if (logged.reason !== reason)
          throw new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'this approval was already used for the console mode with another reason');
        return { mode: view(await locked.get(), this.deps.now()), outcome: 'replayed' as const, idempotencyKey: key };
      }
      const consumed = await consumeFounderApproval(this.deps.approvals, {
        approvalId,
        operationId: input.operationId,
        requestId: `console-mode:${createHash('sha256').update(key).digest('hex')}`,
        actionType: input.action,
        targetService: CONSOLE_MODE_TARGET_SERVICE,
        targetId: CONSOLE_MODE_TARGET_ID,
        fields: consoleModeApprovalFields(input.action, reason),
        requesterId,
      });
      const recorded = await locked.record({
        key,
        action: input.action,
        reason,
        approvalId: consumed.approvalId,
        requesterId: consumed.requesterId,
        approverId: consumed.approverId ?? '',
        policyVersion: consumed.policyVersion,
        at: this.deps.now(),
      });
      return { mode: view(recorded.state, this.deps.now()), outcome: recorded.outcome, idempotencyKey: key };
    });
  }
}
