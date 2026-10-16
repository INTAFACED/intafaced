import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const generatorHref = new URL('../../../tooling/scripts/sdk-from-openapi.ts', import.meta.url).href;

describe('SDK spec drift', () => {
  it('matches the live Payments OpenAPI mount', () => {
    execFileSync('pnpm', ['exec', 'tsx', 'tooling/scripts/sdk-from-openapi.ts', '--check'], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  }, 60_000);

  it('refuses a founder or operator path', async () => {
    const mod = (await import(generatorHref)) as {
      assertMerchantSurface: (spec: { paths: Record<string, unknown> }) => void;
    };
    expect(() => mod.assertMerchantSurface({ paths: { '/founderAdmin/metrics': { get: {} } } })).toThrow(/non-merchant/);
    expect(() => mod.assertMerchantSurface({ paths: { '/operator/halt': { post: {} } } })).toThrow(/non-merchant/);
    expect(() => mod.assertMerchantSurface({ paths: { '/payments': { get: { operationId: 'payHalts.status' } } } })).toThrow(/payHalts/);
  });
});
