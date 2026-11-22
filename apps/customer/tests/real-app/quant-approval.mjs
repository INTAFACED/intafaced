// The live approval panel (RC-algo-dev-01) the journeys that ask a teammate to review a strategy version share
// (J-algo-dev-06 #3). Nothing here moves money.
import { expect } from './journey.mjs';

/** Opens the strategy page at `path` and returns its live approval panel once the service has answered. */
export async function approvalPanel(page, path) {
  await page.goto(path);
  const panel = page.getByTestId('quant-approval');
  await expect(panel.getByTestId('quant-approval-policy')).toBeVisible();
  return panel;
}
