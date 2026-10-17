import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function jsonAt(value: unknown, path: readonly string[]): Record<string, unknown> {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || !(key in current)) {
      throw new Error(`missing ${path.join('.')}`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current !== 'object' || current === null) throw new Error(`missing ${path.join('.')}`);
  return current as Record<string, unknown>;
}

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

  it('types GET /payment-links as a page', async () => {
    const mod = (await import(generatorHref)) as {
      operationsFromSpec: (spec: { paths: Record<string, unknown> }) => unknown[];
      renderTypeScript: (ops: readonly unknown[]) => string;
      renderPython: (ops: readonly unknown[]) => string;
    };
    const ops = mod.operationsFromSpec({
      paths: { '/payment-links': { get: { summary: 'List a merchant’s payment links, newest first' } } },
    });
    const ts = mod.renderTypeScript(ops);
    const py = mod.renderPython(ops);
    expect(ts).toContain('getPaymentLinks(input: PayCallInput): Promise<PayPaymentLinkPage>');
    expect(ts).toContain('paymentLinkPageFromResponse');
    expect(py).toContain('def get_payment_links(');
    expect(py).toContain('-> PayPaymentLinkPage');
    expect(py).toContain('payment_link_page_from_response');
  });

  it('records requestId on errors and pages payment links', () => {
    const spec = JSON.parse(readFileSync(new URL('../openapi/payments.openapi.json', import.meta.url), 'utf8')) as {
      paths?: Record<string, unknown>;
    };
    const list = jsonAt(spec, ['paths', '/payment-links', 'get', 'responses', '200', 'content', 'application/json', 'schema']);
    expect(list.type).toBe('object');
    expect(list.required).toEqual(expect.arrayContaining(['items', 'nextCursor']));
    expect(JSON.stringify(spec)).toContain('"requestId"');
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
