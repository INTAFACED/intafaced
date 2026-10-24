import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The bank router's source as one text, for the tests that read it: shared.ts, errors.ts, context.ts, each area's
 * router in the order router.ts imports them, then router.ts. Each area's procedures stay together and in their
 * old order, so a slice between two procedure names of one area reads what it read when router.ts was one file.
 */
export function bankRouterSource(): string {
  const root = readFileSync(join(SRC, 'router.ts'), 'utf8');
  const areas = [...root.matchAll(/from '\.\/router\/([a-z-]+\.router)\.js'/g)].map((m) => `${m[1]}.ts`);
  return [...['shared.ts', 'errors.ts', 'context.ts', ...areas].map((f) => readFileSync(join(SRC, 'router', f), 'utf8')), root].join('\n');
}
