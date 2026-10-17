import { issueAccessToken } from '@intafaced/auth';
import { LedgerError } from '@intafaced/ledger-client';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  ActionApprovalConsumeError,
  stubApprovalConsumer,
  type ActionApprovalConsumer,
} from './action-approval-consume.js';
import { DualControlError } from './dual-control.js';
import { frozenMessage, MemoryPostingFreeze } from './freeze.js';
import { registerOperatorHttp } from '../operator-http.js';
import type { LedgerService } from '../service.js';

/**
 * S10 / TRD-0230 / OPS-0180. One actor string does not thaw posting.
 * A second operator, distinct from the caller and from the person who froze
 * the book, does. A later freeze reason does not replace the first.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REASON = 'suspected drift in USDT';

const TOKENS = {
  secret: 'four-eyes-unfreeze-operator-secret-ok',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

function postOrRefuse(book: MemoryPostingFreeze): void {
  const state = book.snapshot();
  if (state.frozen) throw new LedgerError(frozenMessage(state.reason), 'ledger.frozen');
}

class SwitchLedger {
  readonly book = new MemoryPostingFreeze();

  async freeze(reason: string, actor: string) {
    return this.book.freeze(reason, actor);
  }

  async unfreeze(actor: string, confirmOperatorId?: string | null) {
    return this.book.unfreeze(actor, confirmOperatorId ?? null);
  }

  async freezeState() {
    return this.book.snapshot();
  }
}

function consumeThenThrow(): ActionApprovalConsumer {
  let calls = 0;
  const ok = stubApprovalConsumer(B);
  return {
    async consume(input) {
      calls += 1;
      if (calls > 1) {
        throw new ActionApprovalConsumeError('identity timed out', 'action_approval.consume_failed');
      }
      return ok.consume(input);
    },
  };
}

async function bearer(): Promise<string> {
  const { token } = await issueAccessToken(
    {
      userId: A,
      sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      scopes: ['admin:treasury'],
      tier: 'basic',
      mfa: true,
    },
    TOKENS,
  );
  return token;
}

describe('S10 one actor string does not clear a posting freeze', () => {
  it('keeps the freeze and refuses a new post when unfreeze is only an actor string (TRD-0230)', () => {
    const book = new MemoryPostingFreeze();
    book.freeze(REASON, A);

    expect(() => book.unfreeze(A)).toThrow(DualControlError);
    expect(book.snapshot()).toMatchObject({ frozen: true, reason: REASON, actor: A });
    expect(() => postOrRefuse(book)).toThrow(LedgerError);
    try {
      postOrRefuse(book);
    } catch (err) {
      expect(err).toMatchObject({ code: 'ledger.frozen' });
    }
  });

  it('refuses the same person, including whitespace and a different hex case', () => {
    const book = new MemoryPostingFreeze();
    book.freeze(REASON, A);
    expect(() => book.unfreeze(A, A)).toThrow(DualControlError);
    expect(() => book.unfreeze(A, `  ${A.toUpperCase()}  `)).toThrow(DualControlError);
    expect(() => book.unfreeze(B, ` ${A} `)).toThrow(DualControlError);
    expect(book.snapshot()).toMatchObject({ frozen: true, reason: REASON, actor: A });
  });

  it('clears the freeze when a second operator, distinct from the person who froze it, confirms (OPS-0180)', () => {
    const book = new MemoryPostingFreeze();
    book.freeze(REASON, A);
    const cleared = book.unfreeze(A, B);
    expect(cleared).toMatchObject({ frozen: false, reason: null, actor: A });
    expect(() => postOrRefuse(book)).not.toThrow();

    const again = book.unfreeze(A, B);
    expect(again.frozen).toBe(false);
    expect(again.changedAtPrecise).toBe(cleared.changedAtPrecise);
  });

  it('does not let a second freeze reason replace the first', () => {
    const book = new MemoryPostingFreeze();
    book.freeze(REASON, A);
    expect(() => book.freeze('a later story', C)).toThrow(LedgerError);
    expect(book.snapshot()).toMatchObject({ frozen: true, reason: REASON, actor: A });
  });

  it('leaves the book frozen when the approval consume times out', async () => {
    const ledger = new SwitchLedger();
    const app = Fastify({ logger: false });
    registerOperatorHttp(app, ledger as unknown as LedgerService, TOKENS, consumeThenThrow());
    await app.ready();
    const authorization = `Bearer ${await bearer()}`;

    const frozen = await app.inject({
      method: 'POST',
      url: '/operator/freeze',
      headers: { authorization },
      payload: { reason: REASON, approvalId: 'appr-1', operationId: 'op-1' },
    });
    expect(frozen.statusCode).toBe(200);
    expect(ledger.book.snapshot().frozen).toBe(true);

    const thaw = await app.inject({
      method: 'POST',
      url: '/operator/unfreeze',
      headers: { authorization },
      payload: { approvalId: 'appr-2', operationId: 'op-2' },
    });
    expect(thaw.statusCode).toBe(400);
    expect(thaw.json().code).toBe('action_approval.consume_failed');
    expect(ledger.book.snapshot()).toMatchObject({ frozen: true, reason: REASON, actor: A });
    expect(() => postOrRefuse(ledger.book)).toThrow(LedgerError);
    await app.close();
  });

  it('clears through the operator door when identity consumed a different approver', async () => {
    const ledger = new SwitchLedger();
    const app = Fastify({ logger: false });
    registerOperatorHttp(app, ledger as unknown as LedgerService, TOKENS, stubApprovalConsumer(B));
    await app.ready();
    const authorization = `Bearer ${await bearer()}`;

    await app.inject({
      method: 'POST',
      url: '/operator/freeze',
      headers: { authorization },
      payload: { reason: REASON, approvalId: 'appr-1', operationId: 'op-1' },
    });
    const thaw = await app.inject({
      method: 'POST',
      url: '/operator/unfreeze',
      headers: { authorization },
      payload: { approvalId: 'appr-2', operationId: 'op-2' },
    });
    expect(thaw.statusCode).toBe(200);
    expect(thaw.json()).toMatchObject({ frozen: false, reason: null, actor: A, confirmOperatorId: B });
    expect(() => postOrRefuse(ledger.book)).not.toThrow();
    await app.close();
  });
});
