import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The Rust port's gateway slice is held to `crates/svc-agents/tests/fixtures/gateway-parity.golden.json`: what this
 * service's routing table parser, mock and upstream adapters, gateway, `/ready` and `routes.list` answer, recorded by
 * `crates/svc-agents/scripts/record-gateway.mjs`. A change to any of them here makes that file stale, and this test
 * fails until the script writes it again.
 */
describe('the Rust gateway slice is held to this gateway', () => {
  it('crates/svc-agents/tests/fixtures/gateway-parity.golden.json is what this gateway answers', () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    let out = '';
    let failed = false;
    try {
      out = execFileSync(process.execPath, ['--import', 'tsx', 'crates/svc-agents/scripts/record-gateway.mjs', '--check'], {
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
      'the gateway golden is stale: run `TZ=UTC node --import tsx crates/svc-agents/scripts/record-gateway.mjs` from the repository root',
    ).toBe('');
  }, 60_000);
});
