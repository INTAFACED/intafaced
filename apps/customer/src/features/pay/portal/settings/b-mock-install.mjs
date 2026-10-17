// TEST DATA ONLY. Puts the developers, reports and analytics stand-in in front of the shared portal stand-in.
import { NOT_MINE, mockContext, createSettingsBMock } from './b-mock.mjs';

/**
 * Registers one handler for the pay and identity services that answers only the procedures these pages call and
 * passes every other request on to whatever was installed before it (Playwright runs the newest route first).
 */
export async function installSettingsBMock(page, { scenario = 'active', role = 'owner', now = Date.now() } = {}) {
  const ctx = mockContext(scenario, now, { role });
  const mock = createSettingsBMock(ctx);
  const calls = [];
  const handle = async (route) => {
    const url = new URL(route.request().url());
    const procedure = decodeURIComponent(url.pathname.split('/trpc/')[1] ?? '');
    const method = route.request().method();
    const input = method === 'GET' ? (JSON.parse(url.searchParams.get('input') ?? 'null') ?? {}) : (route.request().postDataJSON() ?? {});
    const answered = await mock.handle(procedure, input, route);
    if (answered === NOT_MINE) return route.fallback();
    calls.push({ procedure, method, input });
    return answered;
  };
  await page.route('**/api/pay/trpc/**', handle);
  await page.route('**/api/identity/trpc/**', handle);
  return { calls, state: ctx.state };
}
