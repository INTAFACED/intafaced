import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOKEN_VAR } from '@/lib/console-status';
import { blockingBlanks, CONSOLE_SETTINGS, flagOverrides, settingRows } from './effective';

const SECRET = 'TEST-secret-value-never-shown';

describe('effective console settings', () => {
  it('names every blank setting with what it stops, and never shows a secret', () => {
    const rows = settingRows({ EDGE_URL: 'http://127.0.0.1:14500', ADMIN_SESSION_SECRET: SECRET, ADMIN_OPERATOR_TOKEN: '  ' });
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by.EDGE_URL).toMatchObject({ state: 'set', value: 'http://127.0.0.1:14500', blocks: null });
    expect(by.ADMIN_SESSION_SECRET).toMatchObject({ state: 'set', value: null });
    // A whitespace-only token is blank, and says what it stops.
    expect(by.ADMIN_OPERATOR_TOKEN).toMatchObject({ state: 'blank', value: null, blocks: expect.stringContaining('compliance') });
    expect(by.ADMIN_TREASURY_TOKEN).toMatchObject({ state: 'blank', blocks: expect.any(String) });
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it('a blank that stops nothing says what blank means and is not listed as blocking', () => {
    const rows = settingRows({});
    expect(rows.find((r) => r.name === 'ADMIN_MODULES')).toMatchObject({ state: 'blank', blocks: null, blankMeans: 'Every module is on.' });
    const blocking = blockingBlanks(rows).map((r) => r.name);
    expect(blocking).not.toContain('ADMIN_MODULES');
    expect(blocking).toEqual(expect.arrayContaining(['EDGE_URL', 'ADMIN_OPERATOR_TOKEN', 'ADMIN_TREASURY_TOKEN']));
    for (const def of CONSOLE_SETTINGS) if (def.blocks === null) expect(def.blankMeans).toBeTruthy();
  });

  it('lists flag overrides by name, sorted, and nothing else from the environment', () => {
    expect(flagOverrides({ INTAFACED_FLAG_B: 'off', PATH: '/bin', INTAFACED_FLAG_A: 'on' })).toEqual([
      { name: 'INTAFACED_FLAG_A', value: 'on' },
      { name: 'INTAFACED_FLAG_B', value: 'off' },
    ]);
  });

  it('covers every setting the console reads by name (runtime-only names aside)', () => {
    const src = fileURLToPath(new URL('../..', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(src);
    const read = new Set<string>(Object.values(TOKEN_VAR));
    for (const file of files) for (const m of readFileSync(file, 'utf8').matchAll(/\benv(?:\.|\[')([A-Z][A-Z0-9_]+)/g)) read.add(m[1]!);
    const runtime = new Set(['NODE_ENV', 'NEXT_RUNTIME', 'APP_ENV', 'ADMIN_ROUTE_PROBE', 'TZ']);
    const listed = new Set(CONSOLE_SETTINGS.map((d) => d.name));
    expect([...read].filter((name) => !runtime.has(name) && !listed.has(name))).toEqual([]);
  });
});
