import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error the scaffold is plain JavaScript run by node
import { main, migrationStamp, parseArgs, sliceFiles } from '../bin/slice-new.mjs';

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

  it('writes the files into the repo, then refuses to overwrite them', () => {
    const repo = mkdtempSync(join(tmpdir(), 'slice-new-'));
    mkdirSync(join(repo, 'services', 'svc-academy'), { recursive: true });
    const report = main(ARGS, repo, NOW) as string;
    expect(report).toContain('still to add by hand');
    expect(readdirSync(join(repo, 'services', 'svc-academy', 'drizzle'))).toHaveLength(2);
    expect(readFileSync(join(repo, 'services', 'svc-academy', 'src', 'curriculum', 'grade-reports.ts'), 'utf8')).toContain(
      'class GradeReports',
    );
    expect(() => main(ARGS, repo, NOW)).toThrow(/already exists; nothing written/);
  });

  it('writes nothing on a dry run, and nothing for a service that does not exist', () => {
    const repo = mkdtempSync(join(tmpdir(), 'slice-new-'));
    expect(() => main(ARGS, repo, NOW)).toThrow(/does not exist/);
    mkdirSync(join(repo, 'services', 'svc-academy'), { recursive: true });
    expect(main([...ARGS, '--dry-run'], repo, NOW)).toContain('would write');
    expect(readdirSync(join(repo, 'services', 'svc-academy'))).toEqual([]);
  });
});
