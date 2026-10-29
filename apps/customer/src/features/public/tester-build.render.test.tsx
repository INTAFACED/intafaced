// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// J-home-ia-11 #2: the sign-in page of a test build says where the founder vault is and how to print a one-time code.
let host: HTMLDivElement, root: Root;

async function render(banner: boolean) {
  // isTestBuild() reads the served page once, so each case loads the panel fresh.
  vi.resetModules();
  document.body.innerHTML = banner ? '<div id="local-test-stack-banner" role="status">LOCAL TEST STACK</div>' : '';
  const { TesterBuild } = await import('./TesterBuild');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<TesterBuild />));
}

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});

describe('TesterBuild', () => {
  it('on a test build, names the founder vault and the one-time code command', async () => {
    await render(true);
    const region = host.querySelector('section[aria-labelledby="tester-build-title"]');
    expect(region?.querySelector('#tester-build-title')?.textContent).toBe('Tester build');
    expect(region?.textContent).toContain('founders.json');
    expect(region?.textContent).toMatch(/one-time code/i);
    expect(region?.textContent).toContain('node tooling/scripts/local-test-entry.mjs code a');
  });

  it('on a build with no TEST banner, shows nothing', async () => {
    await render(false);
    expect(host.innerHTML).toBe('');
  });
});
