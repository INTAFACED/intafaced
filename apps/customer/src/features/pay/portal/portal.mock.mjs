// Browser mock of the pay service for the merchant portal's Playwright run and screenshots.
// EVERYTHING HERE IS TEST DATA. No real merchant, customer, amount or id. Refs are prefixed TEST so they cannot be mistaken for real ones.
//
// This file only routes. Each package owns the fixtures and answers for its own procedures:
//   mock/core.mjs (account, headline numbers, halts, notifications), money/mock.mjs, payments/mock.mjs, settings/mock.mjs,
//   settings/b-mock.mjs (developers, reports and analytics).
// A part returns NOT_MINE for a procedure it does not own. `mock-contract.test.ts` parses every answer with the same
// schemas the client uses, so a fixture that drifts from the real shape fails a test instead of a screenshot.
import { NOT_MINE, USER_ID, mockContext, refuse } from './mock/shared.mjs';
import { createCoreMock } from './mock/core.mjs';
import { createMoneyMock } from './money/mock.mjs';
import { createPaymentsMock } from './payments/mock.mjs';
import { createSettingsMock } from './settings/mock.mjs';
import { createSettingsBMock } from './settings/b-mock.mjs';

export { USER_ID };

/**
 * scenario: 'active' (verified merchant with activity), 'new' (no merchant), 'quiet' (merchant, no activity yet),
 * 'soon' (operations service not switched on), 'down' (service unreachable), 'halted' (as 'active' with payouts paused).
 */
export function createPortalMock(scenario = 'active', { now = Date.now(), myAccess = 'off', role = 'owner' } = {}) {
  const calls = [];
  /** Procedures nothing answered, so the review board can list what a not-live card is waiting for. */
  const unmounted = [];
  const ctx = mockContext(scenario, now, { myAccess, role });
  const parts = [createCoreMock(ctx), createMoneyMock(ctx), createPaymentsMock(ctx), createSettingsBMock(ctx), createSettingsMock(ctx)];

  async function handle(route) {
    const url = new URL(route.request().url());
    const procedure = decodeURIComponent(url.pathname.split('/trpc/')[1] ?? '');
    const method = route.request().method();
    const input = method === 'GET' ? (JSON.parse(url.searchParams.get('input') ?? 'null') ?? {}) : (route.request().postDataJSON() ?? {});
    calls.push({ procedure, method, input });
    if (scenario === 'down') return refuse(route, 503, '', 'Service unavailable');
    if (
      scenario === 'soon' &&
      (procedure.startsWith('merchantOps.') ||
        procedure.startsWith('merchantMetrics.') ||
        procedure.startsWith('merchantControl.') ||
        procedure.startsWith('payHalts.'))
    )
      return refuse(route, 501, 'pay.not_built', 'pay.not_built: not built yet');
    for (const part of parts) {
      const answered = await part.handle(procedure, input, route);
      if (answered !== NOT_MINE) return answered;
    }
    unmounted.push(procedure);
    return refuse(route, 404, '', `No procedure ${procedure}`);
  }
  /** Identity procedures (sessions, devices) are answered only when a part owns them; anything else falls through to the test's own route. */
  async function handleIdentity(route) {
    const url = new URL(route.request().url());
    const procedure = decodeURIComponent(url.pathname.split('/trpc/')[1] ?? '');
    const method = route.request().method();
    const input = method === 'GET' ? (JSON.parse(url.searchParams.get('input') ?? 'null') ?? {}) : (route.request().postDataJSON() ?? {});
    for (const part of parts) {
      const answered = await part.handle(procedure, input, route);
      if (answered !== NOT_MINE) {
        calls.push({ procedure, method, input });
        return answered;
      }
    }
    return route.fallback();
  }
  return {
    calls,
    unmounted,
    state: ctx.state,
    /** Answer one request directly. Used by the contract test, which has no browser. */
    handle,
    async install(page) {
      await page.route('**/api/pay/trpc/**', handle);
      await page.route('**/api/identity/trpc/**', handleIdentity);
    },
  };
}
