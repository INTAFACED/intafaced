import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Every route the app's navigation and menus name, plus rooms they reach only by a parameter. The look gate
 * (tooling/ci/look-gate) opens this list, so it judges every room.
 */
export function sweepRoutes() {
  // The room table lives in one file per area (src/app/rooms/<area>.ts, project-state #2616).
  const roomFiles = readdirSync(APP + 'src/app/rooms')
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
    .map((f) => `src/app/rooms/${f}`);
  const text = [...roomFiles, 'src/app/menus.ts'].map((f) => readFileSync(APP + f, 'utf8')).join('\n');
  const named = [...text.matchAll(/'(\/[a-z0-9/-]*)'/g)].map((m) => m[1]).filter((r) => r !== '//');
  return [...new Set([...named, '/trade/spot/BTC-USDT', '/coin/BTC'])].sort();
}
