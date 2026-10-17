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

  it('runs the python payments client tests', () => {
    execFileSync('python3', ['-m', 'unittest', 'discover', '-s', 'sdks/python/tests'], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  });

  it('types GET /payments as a page', async () => {
    const mod = (await import(generatorHref)) as {
      operationsFromSpec: (spec: { paths: Record<string, unknown> }) => unknown[];
      renderTypeScript: (ops: readonly unknown[]) => string;
      renderPython: (ops: readonly unknown[]) => string;
    };
    const ops = mod.operationsFromSpec({ paths: { '/payments': { get: { summary: 'List a merchant’s payments, newest first' } } } });
    const ts = mod.renderTypeScript(ops);
    const py = mod.renderPython(ops);
    expect(ts).toContain('getPayments(input: PayCallInput): Promise<PayPaymentPage>');
    expect(ts).toContain('paymentPageFromResponse');
    expect(py).toContain('def get_payments(');
    expect(py).toContain('-> PayPaymentPage');
    expect(py).toContain('payment_page_from_response');
  });

  it('refuses a founder or operator path', async () => {
    const mod = (await import(generatorHref)) as {
      assertMerchantSurface: (spec: { paths: Record<string, unknown> }) => void;
    };
    expect(() => mod.assertMerchantSurface({ paths: { '/founderAdmin/metrics': { get: {} } } })).toThrow(/non-merchant/);
    expect(() => mod.assertMerchantSurface({ paths: { '/operator/halt': { post: {} } } })).toThrow(/non-merchant/);
    expect(() => mod.assertMerchantSurface({ paths: { '/payments': { get: { operationId: 'payHalts.status' } } } })).toThrow(/payHalts/);
  });
});
