import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Every route the app's navigation and menus name, plus rooms they reach only by a parameter. The room report
 * (look-sweep.mjs) and the look gate (tooling/ci/look-gate) both open this list, so they judge the same rooms.
 */
export function sweepRoutes() {
  const text = ['src/app/navigation.ts', 'src/app/menus.ts'].map((f) => readFileSync(APP + f, 'utf8')).join('\n');
  const named = [...text.matchAll(/'(\/[a-z0-9/-]*)'/g)].map((m) => m[1]).filter((r) => r !== '//');
  return [...new Set([...named, '/trade/spot/BTC-USDT', '/coin/BTC'])].sort();
}
