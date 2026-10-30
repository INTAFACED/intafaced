import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BankError } from './errors.js';
import {
  assertAutoInvestListLimit,
  assertBusinessListLimit,
  assertBusinessPendingListLimit,
  assertCardAuthorizationsListLimit,
  assertCardsListLimit,
  assertEarnInterestListLimit,
  assertEarnPositionsListLimit,
  assertExecutionsListLimit,
  assertLoansListLimit,
  assertOfframpsListLimit,
  assertOnrampsListLimit,
  assertSchedulesListLimit,
  assertSpacesListLimit,
} from './owner-list-limit.js';
import { bankRouterSource } from './router/router-source.js';

/**
 * Owner-list page size is refuse-closed when unset.
 *
 * spaces.list / earn.positions / loans.list / cards.list /
 * cards.authorizations / transfers.listSchedules / transfers.executions /
 * autoInvest.list / business.list / business.pending / ramps.onramps /
 * ramps.offramps used to SELECT without LIMIT.
 * Blank must refuse. Owner/client may pass 50 explicitly. Never invent 50.
 *
 * Not milled: catalog pools/products (#4142), job batches, treasury dual-control,
 * earn.accrueAll / markUser / unnamedAssets / spendSummary work sets,
 * autoInvest.runDue (already `bank.auto_invest_batch_limit_unset`).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function refuseBank(fn: (n: number | undefined) => number, code: string) {
  expect(() => fn(undefined)).toThrow(BankError);
  expect(() => fn(Number.NaN)).toThrow(BankError);
  expect(() => fn(0)).toThrow(BankError);
  try {
    fn(undefined);
    throw new Error('expected refuse');
  } catch (e) {
    expect(e).toBeInstanceOf(BankError);
    expect((e as BankError).code).toBe(code);
    expect((e as BankError).message).not.toMatch(/default 50|50-row/i);
  }
}

function sliceFn(src: string, startNeedle: string, endNeedle: string): string {
  const start = src.indexOf(startNeedle);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf(endNeedle, start + startNeedle.length);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('svc-bank owner lists refuse unset limit', () => {
  it('asserts refuse blank / NaN / 0 — never invent 50', () => {
    refuseBank(assertSpacesListLimit, 'bank.spaces_list_limit_unset');
    refuseBank(assertEarnPositionsListLimit, 'bank.earn_positions_list_limit_unset');
    refuseBank(assertEarnInterestListLimit, 'bank.earn_interest_list_limit_unset');
    refuseBank(assertLoansListLimit, 'bank.loans_list_limit_unset');
    refuseBank(assertCardsListLimit, 'bank.cards_list_limit_unset');
    refuseBank(assertCardAuthorizationsListLimit, 'bank.card_authorizations_list_limit_unset');
    refuseBank(assertSchedulesListLimit, 'bank.schedules_list_limit_unset');
    refuseBank(assertExecutionsListLimit, 'bank.executions_list_limit_unset');
    refuseBank(assertAutoInvestListLimit, 'bank.auto_invest_list_limit_unset');
    refuseBank(assertBusinessListLimit, 'bank.business_list_limit_unset');
    refuseBank(assertBusinessPendingListLimit, 'bank.business_pending_list_limit_unset');
    refuseBank(assertOnrampsListLimit, 'bank.onramps_list_limit_unset');
    refuseBank(assertOfframpsListLimit, 'bank.offramps_list_limit_unset');
  });

  it('accepts owner-published 50 and caps at 200', () => {
    expect(assertSpacesListLimit(50)).toBe(50);
    expect(assertEarnPositionsListLimit(50)).toBe(50);
    expect(assertEarnInterestListLimit(31)).toBe(31);
    expect(assertLoansListLimit(1)).toBe(1);
    expect(assertCardsListLimit(200)).toBe(200);
    expect(assertCardAuthorizationsListLimit(201)).toBe(200);
    expect(assertSchedulesListLimit(201)).toBe(200);
    expect(assertExecutionsListLimit(50)).toBe(50);
    expect(assertAutoInvestListLimit(50)).toBe(50);
    expect(assertBusinessListLimit(1)).toBe(1);
    expect(assertBusinessPendingListLimit(200)).toBe(200);
    expect(assertOnrampsListLimit(201)).toBe(200);
    expect(assertOfframpsListLimit(201)).toBe(200);
  });

  it('dump methods require the assert and SQL LIMIT — no invented 50', () => {
    const spaces = readFileSync(join(ROOT, 'services/svc-bank/src/spaces/space-service.ts'), 'utf8');
    const list = sliceFn(spaces, 'async list(userId: string, assetId?: string, limit?: number)', 'async balanceOf(');
    expect(list).toContain('assertSpacesListLimit');
    expect(list).toContain('LIMIT ${page}');
    expect(list).not.toMatch(/\?\? 50/);
    expect(list).not.toMatch(/limit = 50/);

    const earn = readFileSync(join(ROOT, 'services/svc-bank/src/earn/earn-service.ts'), 'utf8');
    const positionsOf = sliceFn(earn, 'async positionsOf(', 'async principalOf(');
    expect(positionsOf).toContain('assertEarnPositionsListLimit');
    expect(positionsOf).toContain('LIMIT ${page}');
    expect(positionsOf).not.toMatch(/\?\? 50/);

    const loans = readFileSync(join(ROOT, 'services/svc-bank/src/loans/loan-service.ts'), 'utf8');
    const loansOf = sliceFn(loans, 'async loansOf(', 'async openLoansForMark(');
    expect(loansOf).toContain('assertLoansListLimit');
    expect(loansOf).toContain('LIMIT ${page}');
    expect(loansOf).not.toMatch(/\?\? 50/);

    const cards = readFileSync(join(ROOT, 'services/svc-bank/src/cards/card-service.ts'), 'utf8');
    const cardsOf = sliceFn(cards, 'async cardsOf(', 'async setStatus(');
    expect(cardsOf).toContain('assertCardsListLimit');
    expect(cardsOf).toContain('LIMIT ${page}');
    expect(cardsOf).not.toMatch(/\?\? 50/);

    const authorizationsOf = sliceFn(cards, 'async authorizationsOf(', 'async cashbackFor(');
    expect(authorizationsOf).toContain('assertCardAuthorizationsListLimit');
    expect(authorizationsOf).toContain('LIMIT ${page}');
    expect(authorizationsOf).not.toMatch(/\?\? 50/);

    const transfers = readFileSync(join(ROOT, 'services/svc-bank/src/transfers/transfer-service.ts'), 'utf8');
    const listSchedules = sliceFn(transfers, 'async listSchedules(', 'async cancelSchedule(');
    expect(listSchedules).toContain('assertSchedulesListLimit');
    expect(listSchedules).toContain('LIMIT ${page}');
    expect(listSchedules).not.toMatch(/\?\? 50/);

    const executions = sliceFn(transfers, 'async executions(', 'static occurrenceAt(');
    expect(executions).toContain('assertExecutionsListLimit');
    expect(executions).toContain('LIMIT ${page}');
    expect(executions).not.toMatch(/\?\? 50/);

    const autoInvest = readFileSync(join(ROOT, 'services/svc-bank/src/auto-invest/auto-invest-service.ts'), 'utf8');
    const listRules = sliceFn(autoInvest, 'async listRules(', 'async getRule(');
    expect(listRules).toContain('assertAutoInvestListLimit');
    expect(listRules).toContain('LIMIT ${page}');
    expect(listRules).not.toMatch(/\?\? 50/);

    const business = readFileSync(join(ROOT, 'services/svc-bank/src/business/business-service.ts'), 'utf8');
    const accountsOf = sliceFn(business, 'async accountsOf(', 'async proposeTransfer(');
    expect(accountsOf).toContain('assertBusinessListLimit');
    expect(accountsOf).toContain('LIMIT ${page}');
    expect(accountsOf).not.toMatch(/\?\? 50/);

    const listPending = sliceFn(business, 'async listPending(', 'async runPayroll(');
    expect(listPending).toContain('assertBusinessPendingListLimit');
    expect(listPending).toContain('LIMIT ${page}');
    expect(listPending).not.toMatch(/\?\? 50/);

    const ramps = readFileSync(join(ROOT, 'services/svc-bank/src/ramps/ramp-service.ts'), 'utf8');
    const onrampsOf = sliceFn(ramps, 'async onrampsOf(', 'async offrampsOf(');
    expect(onrampsOf).toContain('assertOnrampsListLimit');
    expect(onrampsOf).toContain('LIMIT ${page}');
    expect(onrampsOf).not.toMatch(/\?\? 50/);

    const offrampsOf = sliceFn(ramps, 'async offrampsOf(', 'async creditOnramp(');
    expect(offrampsOf).toContain('assertOfframpsListLimit');
    expect(offrampsOf).toContain('LIMIT ${page}');
    expect(offrampsOf).not.toMatch(/\?\? 50/);
  });

  it('tRPC owner lists pass optional input.limit — omit is not 50', () => {
    const router = bankRouterSource();

    const spacesList = sliceFn(router, 'export function createSpacesRouter(', 'unnamed: scopedProcedure');
    expect(spacesList).toContain('limit: z.number().int().min(1).max(200).optional()');
    expect(spacesList).toContain('overview(userId, input.assetId, input.limit)');
    expect(spacesList).not.toMatch(/\?\? 50/);

    const schedules = sliceFn(router, 'listSchedules: scopedProcedure', '/** What actually ran');
    expect(schedules).toContain('limit: z.number().int().min(1).max(200).optional()');
    expect(schedules).toContain('listSchedules(ctx.principal.userId, input?.limit)');
    expect(schedules).not.toMatch(/\?\? 50/);

    const positions = sliceFn(router, 'positions: scopedProcedure', 'export function createAnalyticsRouter(');
    expect(positions).toContain('limit: z.number().int().min(1).max(200).optional()');
    expect(positions).toContain('positionsOf(ctx.principal.userId, input?.limit)');
    expect(positions).not.toMatch(/\?\? 50/);

    const loansList = sliceFn(router, 'outstandingPrincipal: amountString', 'id: loan.id');
    expect(router).toContain('loansOf(ctx.principal.userId, input?.limit)');
    expect(loansList).toContain('outstandingPrincipal');
    expect(router).toContain('bank.loans_list_limit_unset');

    const cardsList = sliceFn(
      router,
      "list: scopedProcedure('bank:read', { module: 'bank' })\n      .input(\n        z\n          .object({\n            /**\n             * Page size. Optional so omit reaches `bank.cards_list_limit_unset`",
      'issue: scopedProcedure',
    );
    expect(cardsList).toContain('cardsOf(ctx.principal.userId, input?.limit)');
    expect(cardsList).not.toMatch(/\?\? 50/);

    const auths = sliceFn(router, 'authorizations: scopedProcedure', 'conversion: z');
    expect(auths).toContain('limit: z.number().int().min(1).max(200).optional()');
    expect(router).toContain('authorizationsOf(input.cardId, input.limit)');
    expect(auths).not.toMatch(/\?\? 50/);

    const executionsTrpc = sliceFn(router, 'executions: scopedProcedure', 'cancel: scopedProcedure');
    expect(executionsTrpc).toContain('limit: z.number().int().min(1).max(200).optional()');
    expect(executionsTrpc).toContain('executions(input.scheduleId, input.limit)');
    expect(executionsTrpc).not.toMatch(/\?\? 50/);

    const autoInvestList = sliceFn(router, "List this user's auto-invest rules", 'createThresholdSweep: scopedProcedure');
    expect(autoInvestList).toContain('limit: z.number().int().min(1).max(200).optional()');
    expect(autoInvestList).toContain('listRules(ctx.principal.userId, input?.limit)');
    expect(autoInvestList).not.toMatch(/\?\? 50/);

    const businessList = sliceFn(router, 'export function createBusinessRouter(', 'create: scopedProcedure');
    expect(businessList).toContain('limit: z.number().int().min(1).max(200).optional()');
    expect(businessList).toContain('accountsOf(ctx.principal.userId, input?.limit)');
    expect(businessList).not.toMatch(/\?\? 50/);

    const pending = sliceFn(router, 'pending: scopedProcedure', 'runPayroll: scopedProcedure');
    expect(pending).toContain('limit: z.number().int().min(1).max(200).optional()');
    expect(pending).toContain('listPending(input.accountId, ctx.principal.userId, input.limit)');
    expect(pending).not.toMatch(/\?\? 50/);

    const onramps = sliceFn(router, 'onramps: scopedProcedure', 'offramps: scopedProcedure');
    expect(onramps).toContain('limit: z.number().int().min(1).max(200).optional()');
    expect(onramps).toContain('onrampsOf(ctx.principal.userId, input?.limit)');
    expect(onramps).not.toMatch(/\?\? 50/);

    const offramps = sliceFn(router, 'offramps: scopedProcedure', 'setWithdrawDestination: scopedProcedure');
    expect(offramps).toContain('limit: z.number().int().min(1).max(200).optional()');
    expect(offramps).toContain('offrampsOf(ctx.principal.userId, input?.limit)');
    expect(offramps).not.toMatch(/\?\? 50/);
  });

  it('work sets stay unbounded — not milled as a page of 50', () => {
    const earn = readFileSync(join(ROOT, 'services/svc-bank/src/earn/earn-service.ts'), 'utf8');
    const accrueAll = sliceFn(earn, 'async accrueAll(', 'async interestPaid(');
    expect(accrueAll).toContain('this.poolsForAccrual()');
    expect(accrueAll).not.toMatch(/this\.listPools\(\)/);
    expect(accrueAll).not.toMatch(/\?\? 50/);

    const spaces = readFileSync(join(ROOT, 'services/svc-bank/src/spaces/space-service.ts'), 'utf8');
    const unnamed = sliceFn(spaces, 'async unnamedAssets(', 'async resolveForDebit(');
    expect(unnamed).toContain('namedSpaces');
    expect(unnamed).not.toMatch(/this\.list\(/);
    expect(unnamed).not.toMatch(/\?\? 50/);

    const spend = readFileSync(join(ROOT, 'services/svc-bank/src/analytics/spend.ts'), 'utf8');
    expect(spend).toContain('namedSpaces');
    expect(spend).not.toMatch(/spaces\.list\(/);
    expect(spend).not.toMatch(/\?\? 50/);

    const loans = readFileSync(join(ROOT, 'services/svc-bank/src/loans/loan-service.ts'), 'utf8');
    const markUser = sliceFn(loans, 'async markUser(', 'const quote = loans[0]');
    expect(markUser).toContain('openLoansForMark');
    expect(markUser).not.toMatch(/this\.loansOf\(/);
    expect(markUser).not.toMatch(/\?\? 50/);

    const autoInvest = readFileSync(join(ROOT, 'services/svc-bank/src/auto-invest/auto-invest-service.ts'), 'utf8');
    const runDue = sliceFn(autoInvest, 'async runDue(', 'return report;');
    expect(runDue).toContain('assertAutoInvestBatchLimit');
    expect(runDue).not.toMatch(/this\.listRules\(/);
    expect(runDue).not.toMatch(/\?\? 50/);
  });
});
