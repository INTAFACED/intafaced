import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryLedger } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import type { BankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';
import { CardService } from './card-service.js';
import { cardSim } from './issuer.js';
import { FRAUD_PREVIEW_ACTIONS, FRAUD_SIGNALS, fraudPreview, refuseFraudPreviewAction } from './fraud-preview.js';

/** BK-cops-09 fraud half: a labelled preview over TEST rows that never decides, posts or stores anything. */

const OPERATOR = '33333333-3333-4333-8333-333333333333';

function context(scopes: string[]): Context {
  return {
    principal: {
      sub: OPERATOR,
      userId: OPERATOR,
      sid: '44444444-4444-4444-8444-444444444444',
      scopes,
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal,
    service: null,
    region: 'DE',
    requestId: 'req-fraud-preview',
  };
}

function untouchedSql(): Sql {
  const tag = () => {
    throw new Error('the fraud preview must not touch sql');
  };
  return tag as unknown as Sql;
}

function setup(scopes: string[]) {
  const ledger = new MemoryLedger();
  const cards = new CardService(untouchedSql(), ledger, { issuer: cardSim() });
  return { ledger, caller: createBankRouter({ cards } as BankServices).createCaller(context(scopes)) };
}

describe('fraud preview', () => {
  it('is labelled, blurred and serves TEST rows only, with no invented number', async () => {
    const { caller, ledger } = setup(['admin:treasury']);
    const view = await caller.ops.fraudPreview();
    expect(view.label).toBe('Preview · sample data');
    expect(view.preview).toBe(true);
    expect(view.blurred).toBe(true);
    expect(view.automaticBlocking).toBe('unavailable');
    expect(view.rows.length).toBeGreaterThan(0);
    for (const row of view.rows) {
      expect(row.test).toBe(true);
      expect(row.testAuthorisationRef).toMatch(/^TEST-/);
    }
    expect(new Set(view.rows.flatMap((r) => r.signals))).toEqual(new Set(FRAUD_SIGNALS));
    expect(JSON.stringify({ stances: view.stances, rows: view.rows.map((r) => [r.band, r.signals]) })).not.toMatch(/\d/);
    expect(ledger.journal()).toHaveLength(0);
  });

  it.each(FRAUD_PREVIEW_ACTIONS)('refuses %s with the typed Preview refusal and changes nothing', async (action) => {
    const { caller, ledger } = setup(['admin:treasury']);
    const before = fraudPreview();
    await expect(caller.ops.fraudPreviewAction({ action })).resolves.toEqual({
      kind: 'preview',
      engine: before.engine,
      action,
      changed: false,
    });
    expect(fraudPreview()).toEqual(before);
    expect(ledger.journal()).toHaveLength(0);
  });

  it('refuses an action it does not know at validation', async () => {
    const { caller } = setup(['admin:treasury']);
    await expect(caller.ops.fraudPreviewAction({ action: 'approve' as never })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses a caller without the treasury scope for both the read and the action', async () => {
    const { caller } = setup(['bank:read', 'bank:write']);
    await expect(caller.ops.fraudPreview()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.ops.fraudPreviewAction({ action: 'run_check' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('keeps the fixture frozen so no caller can turn a TEST row into a live one', () => {
    const view = fraudPreview();
    expect(Object.isFrozen(view.rows)).toBe(true);
    expect(() => {
      (view.rows[0] as { test: boolean }).test = false;
    }).toThrow();
    expect(refuseFraudPreviewAction('run_check').changed).toBe(false);
  });
});
