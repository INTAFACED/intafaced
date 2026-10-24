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

  it('a set value the console cannot use is listed with the blanks, with why', () => {
    const rows = settingRows({
      ANALYTICS_REPLICA_CONFIGURED: 'false',
      ANALYTICS_ETL_WATERMARK_AT: 'soon',
      ANALYTICS_REPLICA_LAG_SECONDS: '30',
    });
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by.ANALYTICS_REPLICA_CONFIGURED).toMatchObject({
      state: 'invalid',
      value: 'false',
      blocks: expect.stringContaining('warehouse'),
    });
    expect(by.ANALYTICS_ETL_WATERMARK_AT).toMatchObject({ state: 'invalid', problem: expect.stringContaining('ISO-8601') });
    expect(by.ANALYTICS_REPLICA_LAG_SECONDS).toMatchObject({ state: 'set', blocks: null, problem: null });
    expect(blockingBlanks(rows).map((r) => r.name)).toEqual(
      expect.arrayContaining(['ANALYTICS_REPLICA_CONFIGURED', 'ANALYTICS_ETL_WATERMARK_AT']),
    );
    expect(settingRows({ ANALYTICS_REPLICA_CONFIGURED: 'true' }).find((r) => r.name === 'ANALYTICS_REPLICA_CONFIGURED')?.state).toBe('set');
    expect(settingRows({ HSTS_MAX_AGE_SECONDS: '63072001' }).find((r) => r.name === 'HSTS_MAX_AGE_SECONDS')?.state).toBe('invalid');
  });

  it('lists flag pins sorted, as every service reads them; an empty value is no pin', () => {
    expect(flagOverrides({ INTAFACED_FLAG_B: 'off', INTAFACED_FLAG_A: 'on', INTAFACED_FLAG_C: '', INTAFACED_FLAG_D: 'maybe' })).toEqual([
      { name: 'INTAFACED_FLAG_A', resolved: 'on', unrecognised: null },
      { name: 'INTAFACED_FLAG_B', resolved: 'off', unrecognised: null },
      { name: 'INTAFACED_FLAG_D', resolved: 'off', unrecognised: 'maybe' },
    ]);
  });

  it('covers every setting the console reads by name (runtime-only names aside)', () => {
    const src = fileURLToPath(new URL('../..', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        // src/testing holds the journey harnesses, which read their own evidence settings and are not the console.
        if (statSync(path).isDirectory()) {
          if (path !== join(src, 'testing')) walk(path);
        } else if (/\.(tsx?|mjs)$/.test(name) && !/\.(test|pw)\.(tsx?|mjs)$/.test(name)) files.push(path);
      }
    };
    walk(src);
    const read = new Set<string>(Object.values(TOKEN_VAR));
    // `env.X`, `env['X']`, and a name handed to a reader as a string (`present(env, 'X')`, `setValue(env, 'X')`).
    const reads = /\benv(?:\.|\[['"])([A-Z][A-Z0-9_]+)|\benv,\s*['"]([A-Z][A-Z0-9_]+)['"]/g;
    for (const file of files) for (const m of readFileSync(file, 'utf8').matchAll(reads)) read.add((m[1] ?? m[2])!);
    const runtime = new Set(['NODE_ENV', 'NEXT_RUNTIME', 'APP_ENV', 'ADMIN_ROUTE_PROBE', 'TZ']);
    const listed = new Set(CONSOLE_SETTINGS.map((d) => d.name));
    expect([...read].filter((name) => !runtime.has(name) && !listed.has(name))).toEqual([]);
  });
});
