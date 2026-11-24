// @vitest-environment happy-dom
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { renderPart } from './harness';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.useFakeTimers({ toFake: ['Date'] });

const sweepRoutes = (): string[] =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { sweepRoutes } from '../../tooling/ci/look-gate/rooms.mjs'; console.log(JSON.stringify(sweepRoutes()))",
      ],
      { encoding: 'utf8' },
    ),
  );

const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));
const tabs = (html: string) => html.slice(html.indexOf('data-testid="plo-tabs"'), html.indexOf('data-testid="pp"'));

describe('look gate TEST account on Pay business onboarding (#10301)', () => {
  it('includes /pay/onboarding in sweepRoutes so the look gate photographs it', () => {
    expect(sweepRoutes()).toContain('/pay/onboarding');
  });

  it('draws /pay/onboarding on its first setup step with only Open a business account in the business menu', async () => {
    const html = await renderPart({ name: '/pay/onboarding', route: '/pay/onboarding' });
    const nav = tabs(html);
    expect(nav).toContain('Open a business account');
    expect(hrefs(nav)).toEqual(['/pay/onboarding']);
    expect(nav).not.toContain('plo-subtabs');
    expect(html).toContain('Set up your account');
    expect(html).toContain('Business details');
    expect(html).toContain('Start with your business details');
    expect(html).toContain('href="/pay/onboarding/business"');
    expect(html).not.toMatch(/We could not connect|You don’t have access|does not have access|Try again/);
  }, 60_000);

  it('draws /pay/merchant as a personal account with no business rooms in the menu', async () => {
    const html = await renderPart({ name: '/pay/merchant', route: '/pay/merchant' });
    const nav = tabs(html);
    expect(nav).toContain('Open a business account');
    expect(hrefs(nav)).toEqual(['/pay/onboarding']);
    expect(nav).not.toContain('plo-subtabs');
    expect(html).toContain('No business account yet');
    expect(html).toContain('href="/pay/onboarding"');
    expect(html).not.toMatch(/We could not connect|Try again/);
  }, 60_000);
});
