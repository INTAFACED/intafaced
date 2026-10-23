import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CommandPalette } from './command-palette';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe('CommandPalette', () => {
  it('first paint is the Search button with its shortcut, and no open dialog', () => {
    const html = renderToStaticMarkup(<CommandPalette modules={['crm', 'ledger']} />);
    expect(html).toContain('Search');
    expect(html).toContain('aria-keyshortcuts="Control+K Meta+K"');
    expect(html).not.toContain('role="dialog"');
  });
});
