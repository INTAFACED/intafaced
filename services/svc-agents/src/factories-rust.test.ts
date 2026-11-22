import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The Rust port's factories slice is held to `crates/svc-agents/tests/fixtures/factories/`: what this router's
 * `scanner`, `support`, `copyIntel` and `merchant` calls answer for the cases in `crates/svc-agents/scripts/factories/`,
 * recorded by `crates/svc-agents/scripts/record-factories.mjs`. A change to any of them here makes a file stale, and
 * this test fails until the script writes it again.
 */
describe('the Rust factories slice is held to these factories', () => {
  it('crates/svc-agents/tests/fixtures/factories/ is what these factories answer', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    let out = '';
    let failed = false;
    try {
      out = execFileSync(process.execPath, ['--import', 'tsx', 'crates/svc-agents/scripts/record-factories.mjs', '--check'], {
        cwd: root,
        env: { ...process.env, TZ: 'UTC' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      failed = true;
      out = String((err as { stderr?: string }).stderr ?? err);
    }
    expect(
      failed ? out : '',
      'a factories golden is stale: run `TZ=UTC node --import tsx crates/svc-agents/scripts/record-factories.mjs` from the repository root',
    ).toBe('');
  }, 120_000);
});
