import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Weed project-state#2731: router.ts held every procedure of every area (4,007 lines), so every algo-dev
 * journey edited it and parallel builds collided there (16 merged PRs in 7 days). Now each area's
 * procedures live in routes/<area>.ts and router.ts only composes the areas.
 */
export function routerShapeFaults(src: string): string[] {
  const faults: string[] = [];
  const procedure = src.match(/\b\w*Procedure\b|\.(query|mutation)\(/);
  if (procedure) faults.push(`router.ts defines a procedure (${procedure[0]}): put it in its area's file, routes/<area>.ts`);
  const lines = src.split('\n').length;
  if (lines > 120) faults.push(`router.ts is ${lines} lines: it only composes the areas; move the code into routes/`);
  return faults;
}

describe('router.ts only composes the areas', () => {
  it('holds no procedure and stays small', () => {
    expect(routerShapeFaults(readFileSync(join(HERE, 'router.ts'), 'utf8'))).toEqual([]);
  });

  it('refuses the old shape: a procedure written into router.ts', () => {
    const planted = `export function createQuantRouter() {\n  return router({\n    health: publicProcedure.query(() => ({ ok: true })),\n  });\n}\n`;
    expect(routerShapeFaults(planted)).toEqual([
      "router.ts defines a procedure (publicProcedure): put it in its area's file, routes/<area>.ts",
    ]);
  });
});
