import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { Reports } from './Reports';
it('offers exactly the three supported export-job kinds and names the missing report capabilities', () => {
  const out = renderToString(<Reports />);
  for (const kind of ['payments', 'settlements', 'payouts']) expect(out).toContain(`/pay/reports/exports?report=${kind}`);
  expect(out).not.toContain('?report=refunds');
  expect(out).toContain('schedule reports');
});
