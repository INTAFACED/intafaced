import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error the scaffold is plain JavaScript run by node
import { main, migrationStamp, nextSteps, parseArgs, sliceFiles } from '../bin/slice-new.mjs';

const NOW = new Date('2026-10-27T06:30:12.345Z');
const ARGS = ['--service', 'svc-academy', '--name', 'grade-reports', '--dir', 'curriculum', '--slice', 'AC-assignments-04'];

describe('slice:new', () => {
  it('names the migration for the UTC second it is written', () => {
    expect(migrationStamp(NOW)).toBe('20261027063012');
  });

  it('derives the area and scope from the service and checks every name', () => {
    expect(parseArgs(ARGS)).toMatchObject({ area: 'academy', scope: 'academy', dir: 'curriculum' });
    expect(() => parseArgs(['--service', 'academy', '--name', 'x', '--slice', 'S'])).toThrow(/--service/);
    expect(() => parseArgs(['--service', 'svc-a', '--name', 'Grade_Reports', '--slice', 'S'])).toThrow(/kebab/);
    expect(() => parseArgs(['--service', 'svc-a', '--name', 'x'])).toThrow(/--slice is required/);
    expect(() => parseArgs([...ARGS, '--dir', '../escape'])).toThrow(/--dir/);
    expect(() => parseArgs([...ARGS, '--dri', 'curriculum'])).toThrow(/unexpected argument "--dri"/);
    expect(() => parseArgs(['--service', 'svc-a', '--name', 'x', '--slice', "AC's-04"])).toThrow(/--slice/);
    expect(() => parseArgs([...ARGS, '--area', 'my-area'])).toThrow(/--area/);
  });

  it('refuses a name the templates already use', () => {
    for (const name of ['sql', 'stored', 'z', 'row'])
      expect(() => parseArgs(['--service', 'svc-academy', '--name', name, '--slice', 'S'])).toThrow(/clashes/);
  });

  it('refuses a scope packages/auth does not have, and takes one it does', () => {
    expect(() => parseArgs(['--service', 'svc-quant', '--name', 'x-y', '--slice', 'S'])).toThrow(/quant:read is not a scope/);
    expect(parseArgs(['--service', 'svc-quant', '--name', 'x-y', '--slice', 'S', '--scope', 'trade'])).toMatchObject({ scope: 'trade' });
  });

  it('writes a reversible migration pair, the store, the router and the test on the kit', () => {
    const files = sliceFiles(parseArgs(ARGS), NOW) as Array<{ path: string; text: string }>;
    expect(files.map((f) => f.path)).toEqual([
      'services/svc-academy/drizzle/20261027063012_grade_reports.sql',
      'services/svc-academy/drizzle/20261027063012_grade_reports.down.sql',
      'services/svc-academy/src/curriculum/grade-reports.ts',
      'services/svc-academy/src/curriculum/grade-reports-router.ts',
      'services/svc-academy/src/curriculum/grade-reports.db.test.ts',
    ]);
    const [up, down, store, router, test] = files.map((f) => f.text);
    expect(up).toContain('CREATE TABLE IF NOT EXISTS "academy"."grade_reports"');
    expect(down).toMatch(/^-- intafaced:destructive/);
    expect(store).toContain("defineRefusals('GradeReportsError'");
    expect(store).toContain("'academy.grade_reports_cap_unset': 'PRECONDITION_FAILED'");
    expect(store).not.toMatch(/ledger/i);
    expect(router).toContain("scopedProcedure('academy:write')");
    expect(router).toContain('ctx.principal!.userId');
    for (const code of ['cap_unset', 'cap_reached', 'not_found']) expect(test).toContain(`academy.grade_reports_${code}`);
  });

  it('prints the same env key and module path the files use', () => {
    const steps = (nextSteps(parseArgs(ARGS)) as string[]).join('\n');
    expect(steps).toContain('ACADEMY_GRADE_REPORTS_CAP: blankAsUnset');
    expect(steps).toContain(
      "gradeReportsProcedures(new GradeReports(sql, env.ACADEMY_GRADE_REPORTS_CAP ?? null)), from './curriculum/grade-reports-router.js'",
    );
  });

  it('writes the files into the repo formatted, then refuses to overwrite them', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'slice-new-'));
    mkdirSync(join(repo, 'services', 'svc-academy'), { recursive: true });
    const report = (await main(ARGS, repo, NOW)) as string;
    expect(report).toContain('still to add by hand');
    expect(readdirSync(join(repo, 'services', 'svc-academy', 'drizzle'))).toHaveLength(2);
    expect(readFileSync(join(repo, 'services', 'svc-academy', 'src', 'curriculum', 'grade-reports.ts'), 'utf8')).toContain(
      'class GradeReports',
    );
    const router = readFileSync(join(repo, 'services', 'svc-academy', 'src', 'curriculum', 'grade-reports-router.ts'), 'utf8');
    expect(Math.max(...router.split('\n').map((l) => l.length))).toBeLessThanOrEqual(140);
    await expect(main(ARGS, repo, NOW)).rejects.toThrow(/already exists; nothing written/);
  });

  it('writes nothing on a dry run, and nothing for a service that does not exist', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'slice-new-'));
    await expect(main(ARGS, repo, NOW)).rejects.toThrow(/does not exist/);
    mkdirSync(join(repo, 'services', 'svc-academy'), { recursive: true });
    expect(await main([...ARGS, '--dry-run'], repo, NOW)).toContain('would write');
    expect(readdirSync(join(repo, 'services', 'svc-academy'))).toEqual([]);
  });
});
