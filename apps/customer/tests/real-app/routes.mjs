import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../../', import.meta.url));

/** Algo dev's rooms reached only from its own tab bar (QuantRooms), so the sweep judges each of them too. */
const QUANT_TABS = [
  '/quant/shared',
  '/quant/strategies',
  '/quant/library',
  '/quant/live',
  '/quant/limits',
  '/quant/studio',
  '/quant/sandbox',
  '/quant/tester',
  '/quant/optimise',
  '/quant/data',
];

/**
 * Every route the app's navigation and menus name, plus rooms they reach only by a parameter or from another room's tab bar. The look gate
 * (tooling/ci/look-gate) opens this list, so it judges every room.
 */
export function sweepRoutes() {
  // The room table lives in one file per area (src/app/rooms/<area>.ts, project-state #2616).
  const roomFiles = readdirSync(APP + 'src/app/rooms')
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
    .map((f) => `src/app/rooms/${f}`);
  const text = [...roomFiles, 'src/app/menus.ts'].map((f) => readFileSync(APP + f, 'utf8')).join('\n');
  const named = [...text.matchAll(/'(\/[a-z0-9/-]*)'/g)].map((m) => m[1]).filter((r) => r !== '//');
  // `/pay/onboarding` is built from a slug array in `src/app/rooms/pay.ts` (`/pay/${slug}`), so the literal matcher
  // above misses it; listed here so the look gate photographs and holds a baseline for the first setup step.
  return [...new Set([...named, '/trade/spot/BTC-USDT', '/coin/BTC', '/pay/onboarding', ...QUANT_TABS])].sort();
}
