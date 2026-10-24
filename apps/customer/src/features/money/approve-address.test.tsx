import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../session/session', () => ({ useSession: () => ({ userId: 'u1', api: {} }) }));
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { ApproveAddress } from './ApproveAddress';

describe('the page the new-address approval email links to', () => {
  it('asks the person to press Approve, and spends nothing on opening; the token is never shown', () => {
    const html = renderToStaticMarkup(<ApproveAddress search="?token=tok_TEST_0123456789abcdef" />);
    expect(html).toContain('Approve a new withdrawal address');
    expect(html).toContain('Approve it only if you saved it yourself.');
    expect(html).toContain('>Approve</button>');
    expect(html).not.toContain('tok_TEST_0123456789abcdef');
    expect(html).toContain('href="/uc/withdraw/address"');
  });
  it('without a token there is nothing to approve: it says to open the link again', () => {
    const html = renderToStaticMarkup(<ApproveAddress search="" />);
    expect(html).toContain('This link no longer works');
    expect(html).toContain('This page needs the link from the email.');
    expect(html).not.toContain('>Approve</button>');
  });
});
