import { renderToString } from 'react-dom/server';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { DataTable, Field, Page } from '@intafaced/ui';
import { Chip, PortalLoading } from './components';
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { Arrives } from './ExtensionTools';

const root = fileURLToPath(new URL('..', import.meta.url));
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : /\.(tsx?|css)$/.test(entry.name) && !entry.name.includes('.test.')
        ? [join(dir, entry.name)]
        : [],
  );
}

describe('Pay redesign boundary', () => {
  it('keeps the entire feature independent of the retired UI module', () => {
    const retired = ['shared', 'ui'].join('/');
    expect(sourceFiles(root).filter((path) => new RegExp(`from ['"][^'"]*${retired}(?:['"]|/)`).test(readFileSync(path, 'utf8')))).toEqual(
      [],
    );
  });
  it('keeps the page heading, purpose and navigation action accessible', () => {
    const out = renderToString(
      <Page title="TEST payments" description="TEST purpose" actions={<a href="/pay/links/new">Create link</a>}>
        <p>TEST content</p>
      </Page>,
    );
    expect(out).toMatch(/<h1[^>]*>TEST payments<\/h1>/);
    expect(out).toContain('TEST purpose');
    expect(out).toContain('href="/pay/links/new"');
  });
  it('links an invalid required field to its label and refusal helper', () => {
    const out = renderToString(
      <Field id="test-amount" label="TEST amount" required error="Enter a positive amount" aria-describedby="limits" />,
    );
    expect(out).toContain('for="test-amount"');
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('aria-describedby="limits test-amount-help"');
    expect(out).toContain('required=""');
  });
  it('retains table semantics and a keyboard reachable overflow region', () => {
    const out = renderToString(
      <DataTable headers={['Reference', 'Amount']} label="TEST payments">
        <tr>
          <td>TEST-1</td>
          <td>0.000000000000000001 USDT</td>
        </tr>
      </DataTable>,
    );
    expect(out).toContain('tabindex="0"');
    expect(out).toContain('role="region"');
    expect(out).toContain('scope="col"');
    expect(out).toContain('0.000000000000000001 USDT');
  });
  it('retains status words and explanations independently of colour', () => {
    const out = renderToString(<Chip kind="payment" value="captured" />);
    expect(out).toContain('class="pp-chip pp-chip--');
    expect(out).toContain('Paid');
    expect(out).toContain('title=');
  });
  it('announces loading and keeps unbuilt backend copy honest', () => {
    expect(renderToString(<PortalLoading label="Loading TEST payments" />)).toContain('aria-busy="true"');
    const out = renderToString(<Arrives reason="TEST reason shown first">TEST dependency is unavailable</Arrives>);
    expect(out).toContain('TEST reason shown first');
    expect(out).not.toContain('0.00');
  });
});
