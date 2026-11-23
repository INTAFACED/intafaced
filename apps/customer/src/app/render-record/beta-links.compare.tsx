// @vitest-environment happy-dom
/**
 * The beta's links: every room the look gate draws that the beta shows, drawn whole as the beta's build draws it
 * (the beta's list, and React's JSX runtime swapped for beta-links.ts as vite.config.ts swaps it), holds no link to a room
 * the beta hides, so no link in the beta opens "Not in this beta".
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { appPath, type JsxRuntime } from '../beta-links';
import { betaHides, betaRoomList, type BetaRooms } from '../beta-volt';
import { rooms } from '../navigation';
import { voltCount } from '../volt-count';
import { renderPart } from './harness';

vi.mock('react/jsx-runtime', async (original) => (await import('../beta-links')).betaRuntime(await original<JsxRuntime>()));
vi.mock('react/jsx-dev-runtime', async (original) => (await import('../beta-links')).betaRuntime(await original<JsxRuntime>()));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.useFakeTimers({ toFake: ['Date'] });

const list: BetaRooms = betaRoomList(voltCount().rooms, rooms);
const routes: string[] = JSON.parse(
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { sweepRoutes } from '../../tooling/ci/look-gate/rooms.mjs'; console.log(JSON.stringify(sweepRoutes()))",
    ],
    { encoding: 'utf8' },
  ),
);
const shown = routes.filter((route) => !betaHides(route.split('?')[0]!, list));

describe("the beta's rooms link to no room the beta hides", () => {
  it('leaves rooms to draw', () => expect(shown.length).toBeGreaterThan(50));

  it.each(shown)('%s', async (route) => {
    // renderPart clears every stubbed global when its part closes, so each part sets the list again.
    vi.stubGlobal('__BETA_VOLT_ROOMS__', list);
    const html = await renderPart({ name: route, route });
    const hrefs = [...html.matchAll(/<a\b[^>]*?\shref="([^"]*)"/g)].map((match) => match[1]!.replaceAll('&amp;', '&'));
    const dead = hrefs.filter((href) => {
      const path = appPath(href);
      return path !== undefined && betaHides(path, list);
    });
    expect(dead, `${route} links to rooms the beta hides`).toEqual([]);
  });
});
